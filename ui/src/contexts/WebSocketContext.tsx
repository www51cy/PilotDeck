import { globalModelSelectionStore } from '../components/chat/utils/globalModelSelection';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { withClientRequestContext } from '../utils/requestContext';

type WSSubscriber = (msg: any) => void;

export type ReconnectInfo = {
  attempt: number;
  nextRetryMs: number;
  status: 'connected' | 'disconnected' | 'reconnecting';
};

type WebSocketContextType = {
  ws: WebSocket | null;
  /** Returns true when the frame was sent or safely queued for replay. */
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  isConnected: boolean;
  reconnectInfo: ReconnectInfo;
  /**
   * Subscribe to every incoming WebSocket message synchronously, bypassing
   * React state batching. Returns an unsubscribe function. Use this for
   * high-frequency event streams (chat stream_delta, etc.) where dropping
   * intermediate values is not acceptable. For low-frequency one-shot events
   * the `latestMessage` state is still fine.
   */
  subscribe: (handler: WSSubscriber) => () => void;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM || !token) return `${protocol}//${window.location.host}/ws`;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
};

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_FACTOR = 2;
const MAX_QUEUED_MESSAGES = 100;

/** How often the browser probes the link with an application-level ping. */
export const PING_INTERVAL_MS = 30_000;
/**
 * How long a probe may stay unanswered before the socket is treated as
 * half-open. Must stay below {@link PING_INTERVAL_MS} so probes never overlap.
 */
export const PING_ACK_TIMEOUT_MS = 15_000;

export function getQueuedMessageKey(message: any): string | null {
  if (message?.type === 'check-session-status' && typeof message.sessionId === 'string' && message.sessionId.trim()) {
    return `check-session-status:${message.sessionId.trim()}`;
  }
  return null;
}

export function isQueueableDisconnectedMessage(message: any): boolean {
  return getQueuedMessageKey(message) !== null;
}

export function enqueueDisconnectedMessage(queue: any[], message: any, maxQueuedMessages = MAX_QUEUED_MESSAGES): void {
  const key = getQueuedMessageKey(message);
  if (!key) return;
  const existingIndex = queue.findIndex((queuedMessage) => getQueuedMessageKey(queuedMessage) === key);
  if (existingIndex >= 0) {
    queue.splice(existingIndex, 1);
  }
  queue.push(message);
  if (queue.length > maxQueuedMessages) {
    queue.splice(0, queue.length - maxQueuedMessages);
  }
}

export function clearDisconnectedQueue(queue: any[]): void {
  queue.splice(0, queue.length);
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectIdRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>({
    attempt: 0,
    nextRetryMs: 0,
    status: 'disconnected',
  });
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const ackTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingPingIdRef = useRef<string | null>(null);
  const pingSeqRef = useRef(0);
  const queuedMessagesRef = useRef<any[]>([]);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const id = ++connectIdRef.current;

    const connect = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      setReconnectInfo((prev) => ({ ...prev, status: 'reconnecting' }));
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

        const websocket = new WebSocket(wsUrl);

        const clearHeartbeat = () => {
          if (pingIntervalRef.current) {
            clearInterval(pingIntervalRef.current);
            pingIntervalRef.current = null;
          }
          if (ackTimeoutRef.current) {
            clearTimeout(ackTimeoutRef.current);
            ackTimeoutRef.current = null;
          }
          pendingPingIdRef.current = null;
        };

        // A connection settles exactly once: either the browser reports `close`,
        // or we detect a half-open link ourselves. Both must schedule the same
        // single backoff reconnect.
        let settled = false;
        const settle = () => {
          if (settled || connectIdRef.current !== id) return;
          settled = true;
          clearHeartbeat();
          setIsConnected(false);
          wsRef.current = null;
          const attempt = ++reconnectAttemptRef.current;
          const delay = Math.min(
            INITIAL_RECONNECT_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
            MAX_RECONNECT_MS,
          );
          setReconnectInfo({ attempt, nextRetryMs: delay, status: 'disconnected' });
          reconnectTimeoutRef.current = setTimeout(() => {
            if (unmountedRef.current || connectIdRef.current !== id) return;
            connect();
          }, delay);
        };

        websocket.onopen = () => {
          if (connectIdRef.current !== id) { websocket.close(); return; }
          setIsConnected(true);
          reconnectAttemptRef.current = 0;
          setReconnectInfo({ attempt: 0, nextRetryMs: 0, status: 'connected' });
          wsRef.current = websocket;

          while (queuedMessagesRef.current.length > 0 && websocket.readyState === WebSocket.OPEN) {
            const message = queuedMessagesRef.current.shift();
            websocket.send(JSON.stringify(withClientRequestContext(message)));
          }

          clearHeartbeat();
          pingIntervalRef.current = setInterval(() => {
            if (websocket.readyState !== WebSocket.OPEN) return;
            const requestId = `hb-${++pingSeqRef.current}`;
            pendingPingIdRef.current = requestId;
            try {
              websocket.send(JSON.stringify({ type: 'ping', requestId, timestamp: Date.now() }));
            } catch {
              pendingPingIdRef.current = null;
              return;
            }
            // A socket can still read OPEN while the peer is gone (frozen tab,
            // half-open TCP). No `close` event will arrive in that case, so an
            // unanswered probe is the only signal that the link is dead.
            if (ackTimeoutRef.current) clearTimeout(ackTimeoutRef.current);
            ackTimeoutRef.current = setTimeout(() => {
              ackTimeoutRef.current = null;
              if (settled || connectIdRef.current !== id) return;
              try { websocket.close(); } catch { /* already closing */ }
              settle();
            }, PING_ACK_TIMEOUT_MS);
          }, PING_INTERVAL_MS);

          if (hasConnectedRef.current) {
            globalModelSelectionStore.invalidate();
            const reconnectMsg = { type: 'websocket-reconnected', timestamp: Date.now() };
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try { sub(reconnectMsg); } catch { /* Isolate subscriber failures. */ }
              });
            }
            setLatestMessage(reconnectMsg);
          }
          hasConnectedRef.current = true;
        };

        websocket.onmessage = (event) => {
          if (connectIdRef.current !== id) return;
          try {
            const data = JSON.parse(event.data);
            if (data?.type === 'pong') {
              // A pong proves the link is alive. It says nothing about business
              // state, so it is not dispatched to subscribers — otherwise every
              // heartbeat would churn React state and look like a data message.
              const pendingId = pendingPingIdRef.current;
              if (pendingId === null || data.requestId === undefined || data.requestId === pendingId) {
                pendingPingIdRef.current = null;
                if (ackTimeoutRef.current) {
                  clearTimeout(ackTimeoutRef.current);
                  ackTimeoutRef.current = null;
                }
              }
              return;
            }
            // Invalidate even while the composer is unmounted (for example in settings).
            if (data?.type === 'config:reloaded') globalModelSelectionStore.invalidate();
            globalModelSelectionStore.receiveMessage(data);
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try {
                  sub(data);
                } catch (err) {
                  console.error('WebSocket subscriber error:', err);
                }
              });
            }
            setLatestMessage(data);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        websocket.onclose = () => {
          if (connectIdRef.current !== id) return;
          settle();
        };

        websocket.onerror = (error) => {
          console.error('WebSocket error:', error);
        };
      } catch (error) {
        console.error('Error creating WebSocket connection:', error);
      }
    };

    connect();

    return () => {
      connectIdRef.current++;
      clearDisconnectedQueue(queuedMessagesRef.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (ackTimeoutRef.current) {
        clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = null;
      }
      pendingPingIdRef.current = null;
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [token]);

  const sendMessage = useCallback((message: any): boolean => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(withClientRequestContext(message)));
        globalModelSelectionStore.trackMessage(message);
        return true;
      } catch (error) {
        console.warn('Failed to send WebSocket message', error);
        return false;
      }
    } else if (isQueueableDisconnectedMessage(message)) {
      enqueueDisconnectedMessage(queuedMessagesRef.current, message);
      console.warn('WebSocket not connected');
      return true;
    } else {
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const subscribe = useCallback<WebSocketContextType['subscribe']>((handler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    reconnectInfo,
    subscribe,
  }), [sendMessage, latestMessage, isConnected, reconnectInfo, subscribe]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
