/**
 * Application-level heartbeat for the chat WebSocket (`/ws`).
 *
 * The browser sends `{ type: 'ping', requestId, timestamp }` on a fixed
 * interval and treats a missing `pong` as a dead link. Two properties matter:
 *
 * 1. The ACK is *per-connection liveness* only — it is never fanned out to
 *    other sockets of the same user, because one client's probe must not be
 *    able to satisfy another client's timeout.
 * 2. The reply echoes the client's request id so the client can drop stale
 *    pongs instead of resetting its timer from a late response.
 *
 * A pong says nothing about business state. It must not be read as "the
 * session projection is up to date".
 */

const OPEN = 1; // WebSocket.OPEN, kept numeric so this module needs no global.

function isScalarRequestId(value) {
  return value !== null && (typeof value === 'string' || typeof value === 'number');
}

export function buildPongFrame(ping, now = Date.now()) {
  const frame = { type: 'pong', serverTime: now };
  const requestId = ping?.requestId;
  if (isScalarRequestId(requestId)) frame.requestId = requestId;

  const timestamp = ping?.timestamp;
  if (Number.isFinite(timestamp)) frame.timestamp = timestamp;

  return frame;
}

/**
 * Replies to a heartbeat probe. Returns true when a pong was written.
 */
export function replyToPing(ws, ping, now = Date.now()) {
  if (!ws || ws.readyState !== OPEN || typeof ws.send !== 'function') return false;
  ws.send(JSON.stringify(buildPongFrame(ping, now)));
  return true;
}
