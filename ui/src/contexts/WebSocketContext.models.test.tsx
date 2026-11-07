import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { refreshSessionAfterReconnect, shouldRefreshSessionOnReconnect } from '../components/chat-v2/reconnectRecovery';
import { useWebSocket, WebSocketProvider } from './WebSocketContext';
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../components/chat/utils/globalModelSelection', () => ({ globalModelSelectionStore: { invalidate, receiveMessage: vi.fn(), trackMessage: vi.fn() } }));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 'fixture' }) }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  closeCode: number | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { super(); Socket.instances.push(this); }
  send() {}
  close(code = 1000) {
    this.closeCode = code;
    this.readyState = 3;
    const event = new Event('close');
    Object.defineProperty(event, 'code', { value: code });
    this.dispatchEvent(event);
    this.onclose?.();
  }
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); invalidate.mockClear(); Socket.instances = [];
});

it('invalidates the catalog on config changes and reconnect even without a mounted composer', () => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
  render(<WebSocketProvider><div>Settings</div></WebSocketProvider>);
  const first = Socket.instances[0];
  act(() => first.onopen?.());
  act(() => first.onmessage?.({ data: JSON.stringify({ type: 'stream_delta' }) }));
  expect(invalidate).not.toHaveBeenCalled();
  act(() => first.onmessage?.({ data: JSON.stringify({ type: 'config:reloaded' }) }));
  expect(invalidate).toHaveBeenCalledTimes(1);
  act(() => first.close());
  act(() => vi.advanceTimersByTime(1000));
  act(() => Socket.instances[1].onopen?.());
  expect(invalidate).toHaveBeenCalledTimes(2);
});

it('refreshes the active session message window after a close 1001 reconnect', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const refresh = vi.fn();

  function MessageWindow() {
    const { subscribe } = useWebSocket();
    const [messages, setMessages] = useState(['before-restart']);
    useEffect(() => subscribe((message) => {
      if (message.type !== 'websocket-reconnected') return;
      if (!shouldRefreshSessionOnReconnect({
        isLoading: true,
        processingSessions: new Set(['session-1']),
        sessionId: 'session-1',
      })) return;
      void refreshSessionAfterReconnect(async () => {
        refresh();
        setMessages(['before-restart', 'written-while-disconnected']);
      });
    }), [subscribe]);
    return <div data-testid="message-count">{messages.length}</div>;
  }

  render(<WebSocketProvider><MessageWindow /></WebSocketProvider>);
  const first = Socket.instances[0];
  act(() => first.onopen?.());
  expect(screen.getByTestId('message-count').textContent).toBe('1');

  act(() => first.close(1001));
  expect(first.closeCode).toBe(1001);
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => { Socket.instances[1].onopen?.(); });

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('message-count').textContent).toBe('2');
});
