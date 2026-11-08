import { describe, expect, it, vi } from 'vitest';
import { buildPongFrame, replyToPing } from './session-heartbeat.js';

function createSocket({ readyState = 1, userId = 'user-1' } = {}) {
  return {
    readyState,
    userId,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  };
}

describe('buildPongFrame', () => {
  it('echoes the client request id and timestamp so the client can match its probe', () => {
    const frame = buildPongFrame({ type: 'ping', requestId: 'hb-7', timestamp: 1700000000000 }, 1700000000042);
    expect(frame).toEqual({
      type: 'pong',
      requestId: 'hb-7',
      timestamp: 1700000000000,
      serverTime: 1700000000042,
    });
  });

  it('accepts a numeric request id', () => {
    expect(buildPongFrame({ type: 'ping', requestId: 12 }, 5).requestId).toBe(12);
  });

  it('omits request id and timestamp when the client sent none', () => {
    expect(buildPongFrame({ type: 'ping' }, 99)).toEqual({ type: 'pong', serverTime: 99 });
  });

  it('does not echo arbitrary client payload fields', () => {
    const frame = buildPongFrame({
      type: 'ping',
      requestId: 'hb-1',
      sessionId: 'session-1',
      userId: 'spoofed',
      nested: { evil: true },
    }, 1);
    expect(Object.keys(frame).sort()).toEqual(['requestId', 'serverTime', 'type']);
  });

  it('rejects non-scalar request ids instead of stringifying objects', () => {
    expect(buildPongFrame({ type: 'ping', requestId: { a: 1 } }, 1).requestId).toBeUndefined();
    expect(buildPongFrame({ type: 'ping', requestId: null }, 1).requestId).toBeUndefined();
  });
});

describe('replyToPing', () => {
  it('replies only to the pinging socket', () => {
    const origin = createSocket();
    const other = createSocket();
    const sameUserOtherConnection = createSocket();

    expect(replyToPing(origin, { type: 'ping', requestId: 'hb-1' }, 10)).toBe(true);

    expect(origin.sent).toEqual([{ type: 'pong', requestId: 'hb-1', serverTime: 10 }]);
    // An ACK is per-connection liveness; fanning it out would let one client's
    // probe satisfy another client's timeout.
    expect(other.sent).toEqual([]);
    expect(sameUserOtherConnection.sent).toEqual([]);
  });

  it('does not attempt to send on a closed socket', () => {
    const closed = createSocket({ readyState: 3 });
    expect(replyToPing(closed, { type: 'ping' }, 10)).toBe(false);
    expect(closed.sent).toEqual([]);
  });

  it('tolerates a malformed socket without throwing', () => {
    expect(replyToPing(null, { type: 'ping' })).toBe(false);
    expect(replyToPing({ readyState: 1 }, { type: 'ping' })).toBe(false);
  });

  it('produces a JSON frame the browser can parse', () => {
    const socket = createSocket();
    replyToPing(socket, { type: 'ping', requestId: 'hb-9' }, 1);
    expect(() => JSON.parse(JSON.stringify(socket.sent[0]))).not.toThrow();
    expect(socket.sent[0].type).toBe('pong');
  });
});
