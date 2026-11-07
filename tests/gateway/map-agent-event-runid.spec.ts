import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";

test("mapAgentEvent propagates runId to streaming lifecycle boundaries", () => {
  const runId = "run-1";

  const accepted = mapAgentEvent({
    type: "input_accepted",
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
  }, runId);
  assert.deepEqual(accepted, [{ type: "input_accepted", runId }]);

  const unapplied = mapAgentEvent({
    type: "steer_unapplied",
    sessionId: "session-1",
    turnId: "turn-1",
    itemId: "queue-1",
    reason: "turn_ended",
  }, runId);
  assert.deepEqual(unapplied, [{
    type: "steer_unapplied",
    itemId: "queue-1",
    reason: "turn_ended",
    runId,
  }]);

  const toolStarted = mapAgentEvent({
    type: "tool_calls_detected",
    sessionId: "session-1",
    turnId: "turn-1",
    calls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
  } as unknown as AgentEvent, runId);
  assert.equal(toolStarted[0]?.type, "tool_call_started");
  assert.equal(toolStarted[0]?.runId, runId);

  const completed = mapAgentEvent({
    type: "turn_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      stopReason: "completed",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  } as unknown as AgentEvent, runId);
  assert.equal(completed[0]?.type, "turn_completed");
  assert.equal(completed[0]?.runId, runId);

  const failed = mapAgentEvent({
    type: "turn_failed",
    sessionId: "session-1",
    turnId: "turn-1",
    error: { code: "model_error", message: "boom" },
  } as unknown as AgentEvent, runId);
  assert.equal(failed[0]?.type, "error");
  assert.equal(failed[0]?.runId, runId);

  const compactCompleted = mapAgentEvent({
    type: "compact_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    compactionId: "compact-1",
    trigger: "reactive",
    status: "success",
    preTokens: 120,
    postTokens: 40,
    messagesSummarized: 3,
  }, runId);
  assert.deepEqual(compactCompleted, [{
    type: "agent_status",
    event: "compact_completed",
    detail: {
      compactionId: "compact-1",
      trigger: "reactive",
      status: "success",
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 3,
    },
    runId,
  }]);
});

test("mapAgentEvent preserves an aborted subagent completion", () => {
  const [completed] = mapAgentEvent({
    type: "subagent_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-1",
    subagentType: "explore",
    success: false,
    aborted: true,
    durationMs: 10,
  }, "run-1");

  assert.equal(completed?.type, "agent_status");
  assert.equal(completed?.runId, "run-1");
  assert.deepEqual(completed?.type === "agent_status" ? completed.detail : undefined, {
    subagentId: "subagent-1",
    subagentType: "explore",
    success: false,
    aborted: true,
    durationMs: 10,
  });
});


test("subagent errors receive distinct identities before replay serialization", () => {
  const error: AgentEvent = {
    type: "subagent_model_event", sessionId: "session-1", turnId: "turn-1",
    subagentId: "child", subagentType: "explore",
    event: { type: "error", error: { provider: "test", protocol: "openai",
      code: "timeout", message: "Timed out", retryable: true } },
  };
  const [first] = mapAgentEvent(error, "run-1");
  const [second] = mapAgentEvent(error, "run-1");
  assert.ok(first?.type === "agent_status" && second?.type === "agent_status");
  assert.equal(typeof first.detail?.errorId, "string");
  assert.ok(first.detail?.errorId);
  assert.notEqual(first.detail?.errorId, second.detail?.errorId);
  assert.equal(JSON.parse(JSON.stringify(first)).detail.errorId, first.detail?.errorId);
});

// --- Slice A: explicit model-request terminals -----------------------------
// `tool_call_start` and `message_end` are stream boundaries, not request
// terminals: the same request keeps streaming after a tool-call block, and a
// turn issues several requests. Only the agent loop can decide that a request
// is over, so the terminal must come from an explicit AgentEvent.

test("model request terminals carry the run id and the mapped model metadata", () => {
  const started = mapAgentEvent({
    type: "model_request_started",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "model-a",
    provider: "provider-a",
  }, "run-1");
  assert.deepEqual(started, [{
    type: "model_request_started",
    model: "model-a",
    provider: "provider-a",
    runId: "run-1",
  }]);

  const completed = mapAgentEvent({
    type: "model_request_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "model-a",
    provider: "provider-a",
    finishReason: "tool_call",
  }, "run-1");
  assert.deepEqual(completed, [{
    type: "model_request_completed",
    model: "model-a",
    provider: "provider-a",
    finishReason: "tool_call",
    runId: "run-1",
  }]);

  const failed = mapAgentEvent({
    type: "model_request_failed",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "model-a",
    provider: "provider-a",
    error: { code: "agent_model_error", message: "provider exploded" } as never,
  }, "run-1");
  assert.deepEqual(failed, [{
    type: "model_request_failed",
    model: "model-a",
    provider: "provider-a",
    message: "provider exploded",
    code: "agent_model_error",
    runId: "run-1",
  }]);
});

test("canonical message_end and tool_call_start remain stream boundaries only", () => {
  const messageEnd = mapAgentEvent({
    type: "model_event",
    sessionId: "session-1",
    turnId: "turn-1",
    event: { type: "message_end", finishReason: "stop" } as never,
  }, "run-1");
  assert.deepEqual(messageEnd, [{ type: "assistant_stream_end", runId: "run-1" }]);

  const toolCallStart = mapAgentEvent({
    type: "model_event",
    sessionId: "session-1",
    turnId: "turn-1",
    event: { type: "tool_call_start", id: "call-1", name: "bash" } as never,
  }, "run-1");
  assert.deepEqual(toolCallStart, [{ type: "assistant_stream_end", runId: "run-1" }]);

  // Neither branch may synthesize a request terminal; only the agent loop can.
  for (const frame of [...messageEnd, ...toolCallStart]) {
    assert.notEqual(frame.type, "model_request_completed");
    assert.notEqual(frame.type, "model_request_failed");
  }
});
