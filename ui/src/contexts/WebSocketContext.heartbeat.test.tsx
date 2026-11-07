import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PING_ACK_TIMEOUT_MS,
  PING_INTERVAL_MS,
  WebSocketProvider,
  useWebSocket,
} from './WebSocketContext';

vi.mock('../components/chat/utils/globalModelSelection', () => ({
  globalModelSelectionStore: { invalidate: vi.fn(), receiveMessage: vi.fn(), trackMessage: vi.fn() },
}));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 'fixture' }) }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: any[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    super();
    Socket.instances.push(this);
  }
  send(payload: string) { this.sent.push(JSON.parse(payload)); }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
    this.onclose?.();
  }
  // Simulates a frame arriving from the server.
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const pings = (socket: Socket) => socket.sent.filter((frame) => frame.type === 'ping');

let received: any[] = [];

function Probe() {
  const { subscribe } = useWebSocket();
  useEffect(() => subscribe((message) => { received.push(message); }), [subscribe]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  received = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Socket.instances = [];
});

const renderConnected = () => {
  render(
    <WebSocketProvider>
      <Probe />
    </WebSocketProvider>,
  );
  const socket = Socket.instances[0];
  act(() => socket.onopen?.());
  return socket;
};

describe('heartbeat ACK tracking', () => {
  it('sends a ping carrying a request id and timestamp', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));

    const [ping] = pings(socket);
    expect(ping).toBeDefined();
    expect(typeof ping.requestId).toBe('string');
    expect(ping.requestId.length).toBeGreaterThan(0);
    expect(typeof ping.timestamp).toBe('number');
  });

  it('keeps the connection when the server answers the ping', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    const [ping] = pings(socket);

    act(() => socket.receive({ type: 'pong', requestId: ping.requestId, serverTime: 1 }));
    act(() => vi.advanceTimersByTime(PING_ACK_TIMEOUT_MS - 1));

    expect(socket.closeCalls).toBe(0);
    expect(Socket.instances).toHaveLength(1);
  });

  it('treats an unanswered ping as a dead link and reconnects with the existing backoff', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    expect(pings(socket)).toHaveLength(1);

    act(() => vi.advanceTimersByTime(PING_ACK_TIMEOUT_MS));

    expect(socket.closeCalls).toBe(1);
    expect(Socket.instances).toHaveLength(1);

    // The reconnect still goes through the normal exponential backoff path.
    act(() => vi.advanceTimersByTime(1000));
    expect(Socket.instances).toHaveLength(2);
  });

  it('reconnects only once when both the ACK timeout and the close event fire', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS + PING_ACK_TIMEOUT_MS));
    act(() => vi.advanceTimersByTime(1000));

    expect(Socket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(60_000));
    expect(Socket.instances.length).toBeLessThanOrEqual(3);
  });

  it('ignores a stale pong that answers an older probe', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    const firstRequestId = pings(socket)[0].requestId;

    act(() => socket.receive({ type: 'pong', requestId: firstRequestId }));
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    const secondRequestId = pings(socket)[1].requestId;
    expect(secondRequestId).not.toBe(firstRequestId);

    // Late answer to the previous probe must not clear the current timer.
    act(() => socket.receive({ type: 'pong', requestId: firstRequestId }));
    act(() => vi.advanceTimersByTime(PING_ACK_TIMEOUT_MS));

    expect(socket.closeCalls).toBe(1);
  });

  it('does not dispatch pongs to business subscribers', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    const [ping] = pings(socket);

    act(() => socket.receive({ type: 'pong', requestId: ping.requestId }));
    act(() => socket.receive({ type: 'stream_delta', text: 'hello' }));

    expect(received.map((message) => message.type)).toEqual(['stream_delta']);
  });

  it('clears heartbeat timers on unmount', () => {
    const socket = renderConnected();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS));
    const pingsBefore = pings(socket).length;

    cleanup();
    act(() => vi.advanceTimersByTime(PING_INTERVAL_MS * 3));

    expect(pings(socket)).toHaveLength(pingsBefore);
  });
});
