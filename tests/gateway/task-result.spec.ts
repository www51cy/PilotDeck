import assert from "node:assert/strict";
import test from "node:test";

import type { Gateway, GatewayEvent } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";

type SentFrame = {
  type: string;
  id?: string;
  seq?: number;
  final?: boolean;
  event?: GatewayEvent;
  ok?: boolean;
};

class FakeTextWebSocketConnection {
  readonly sent: SentFrame[] = [];
  private messageHandler?: (message: string) => void;

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(_handler: () => void): void {}

  sendText(message: string): void {
    this.sent.push(JSON.parse(message) as SentFrame);
  }

  close(): void {}

  dispatch(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function submitTurn(
  events: GatewayEvent[],
  streamFailure?: { error: unknown },
): Promise<SentFrame[]> {
  const socket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway: {
      describeServer: async () => ({ mode: "in_process" }),
      async *submitTurn() {
        for (const event of events) yield event;
        if (streamFailure) throw streamFailure.error;
      },
    } as unknown as Gateway,
  });
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  socket.dispatch({
    type: "request",
    id: "turn-1",
    method: "submit_turn",
    params: { sessionKey: "web:s_result", runId: "run-result", message: "hello" },
  });
  await flushAsyncWork();
  return socket.sent;
}

function eventFrames(frames: SentFrame[]): Array<SentFrame & { event: GatewayEvent }> {
  return frames.filter((frame): frame is SentFrame & { event: GatewayEvent } => frame.type === "event");
}

function onlyTaskResult(frames: SentFrame[]): Extract<GatewayEvent, { type: "task_result" }> {
  const results = eventFrames(frames).filter((frame) => frame.event.type === "task_result");
  assert.equal(results.length, 1);
  return results[0]!.event as Extract<GatewayEvent, { type: "task_result" }>;
}

test("submit_turn preserves process events and emits one authoritative result before final", async () => {
  const frames = await submitTurn([
    { type: "assistant_text_delta", runId: "run-result", text: "done" },
    { type: "turn_completed", runId: "run-result", usage: { inputTokens: 3 }, finishReason: "completed" },
  ]);
  const events = eventFrames(frames);

  assert.deepEqual(events.map((frame) => [frame.event.type, frame.final]), [
    ["assistant_text_delta", false],
    ["turn_completed", false],
    ["task_result", false],
    ["turn_completed", true],
  ]);
  assert.deepEqual(onlyTaskResult(frames), {
    type: "task_result",
    sessionKey: "web:s_result",
    runId: "run-result",
    status: "success",
    finishReason: "completed",
    usage: { inputTokens: 3 },
  });
  assert.ok(events[2]!.seq! < events[3]!.seq!);
});

for (const [finishReason, status] of [
  ["max_turns", "max_turns"],
  ["aborted_tools", "aborted"],
  ["model_error", "failed"],
] as const) {
  test(`task_result classifies ${finishReason} as ${status}`, async () => {
    const frames = await submitTurn([
      { type: "turn_completed", runId: "run-result", usage: {}, finishReason },
    ]);
    const result = onlyTaskResult(frames);
    assert.equal(result.status, status);
    assert.equal(result.finishReason, finishReason);
    assert.equal(eventFrames(frames).at(-1)?.final, true);
    assert.equal(eventFrames(frames).at(-1)?.event.type, "turn_completed");
    if (eventFrames(frames).at(-1)?.event.type === "turn_completed") {
      const finalEvent = eventFrames(frames).at(-1)!.event as TurnCompletedForTest;
      assert.equal(finalEvent.finishReason, finishReason);
    }
  });
}

type TurnCompletedForTest = Extract<GatewayEvent, { type: "turn_completed" }>;

test("a terminal error without turn_completed produces a failed result, not default success", async () => {
  const frames = await submitTurn([
    { type: "error", runId: "run-result", code: "turn_timeout", message: "Timed out", recoverable: false },
  ]);
  assert.deepEqual(onlyTaskResult(frames), {
    type: "task_result",
    sessionKey: "web:s_result",
    runId: "run-result",
    status: "failed",
    finishReason: "turn_timeout",
    usage: {},
    error: { code: "turn_timeout", message: "Timed out" },
  });
});

test("an agent_aborted error produces an aborted result with its user hint", async () => {
  const frames = await submitTurn([
    { type: "error", runId: "run-result", code: "agent_aborted", message: "Stopped by user", userHint: "Start a new turn when ready.", recoverable: false },
  ]);
  assert.deepEqual(onlyTaskResult(frames), {
    type: "task_result",
    sessionKey: "web:s_result",
    runId: "run-result",
    status: "aborted",
    finishReason: "aborted",
    usage: {},
    error: { code: "agent_aborted", message: "Stopped by user", userHint: "Start a new turn when ready." },
  });
});

test("recoverable errors alone do not manufacture a terminal outcome", async () => {
  const frames = await submitTurn([
    { type: "error", runId: "run-result", code: "retrying", message: "Retrying", recoverable: true },
  ]);
  const result = onlyTaskResult(frames);
  assert.equal(result.status, "unknown");
  assert.equal(result.finishReason, "missing_turn_completed");
});

test("an unterminated event stream produces an explicit unknown result", async () => {
  const frames = await submitTurn([]);
  const result = onlyTaskResult(frames);
  assert.equal(result.status, "unknown");
  assert.equal(result.finishReason, "missing_turn_completed");
  assert.equal(result.error?.code, "missing_turn_completed");
  const final = eventFrames(frames).at(-1);
  assert.equal(final?.final, true);
  assert.equal(final?.event.type === "turn_completed" && final.event.finishReason, "missing_turn_completed");
});

test("a throwing submit stream closes with a failed result instead of an RPC-only failure", async () => {
  const failure = Object.assign(new Error("model exploded"), { code: "model_request_failed" });
  const frames = await submitTurn([], { error: failure });
  const result = onlyTaskResult(frames);
  assert.equal(result.status, "failed");
  assert.equal(result.finishReason, "gateway_error");
  assert.deepEqual(result.error, { code: "model_request_failed", message: "model exploded" });
  assert.equal(eventFrames(frames).at(-1)?.final, true);
  assert.equal(frames.some((frame) => frame.type === "response"), false);
});
