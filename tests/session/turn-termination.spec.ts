import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { deriveAgentTurnTerminations } from "../../src/session/transcript/TurnTermination.js";

const createdAt = "2026-11-06T00:00:00.000Z";
let sequence = 0;

function base(turnId: string) {
  return { sessionId: "session-1", turnId, sequence: ++sequence, createdAt };
}

function accepted(turnId: string): AgentTranscriptEntry {
  return {
    ...base(turnId),
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: turnId }] }],
  };
}

function durable(turnId: string, compactReplacement = false): AgentTranscriptEntry {
  return {
    ...base(turnId),
    type: "assistant_message",
    message: {
      role: "assistant",
      ...(compactReplacement ? { metadata: { compactReplacement: true } } : {}),
      content: [{ type: "text", text: `output for ${turnId}` }],
    },
  };
}

function result(
  turnId: string,
  type: "success" | "aborted" | "error" | "max_turns",
): AgentTranscriptEntry {
  const stopReason = {
    success: "completed",
    aborted: "aborted_streaming",
    error: "model_error",
    max_turns: "max_turns",
  } as const;
  return {
    ...base(turnId),
    type: "turn_result",
    result: {
      type,
      sessionId: "session-1",
      turnId,
      stopReason: stopReason[type],
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: createdAt,
      completedAt: createdAt,
    },
  };
}

test("derives terminal and incomplete turn states from transcript evidence", () => {
  const entries = [
    accepted("turn-incomplete-input"),
    durable("turn-incomplete-output"),
    accepted("turn-complete"),
    result("turn-complete", "success"),
    accepted("turn-aborted"),
    result("turn-aborted", "aborted"),
    accepted("turn-error"),
    result("turn-error", "error"),
    accepted("turn-max"),
    result("turn-max", "max_turns"),
  ];

  assert.deepEqual([...deriveAgentTurnTerminations(entries)], [
    ["turn-incomplete-input", "incomplete"],
    ["turn-incomplete-output", "incomplete"],
    ["turn-complete", "completed"],
    ["turn-aborted", "aborted"],
    ["turn-error", "failed"],
    ["turn-max", "failed"],
  ]);
});

test("does not invent turns from control records or compact replacements", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      ...base("turn-control"),
      type: "control_boundary",
      boundary: { kind: "resume" },
    },
    {
      ...base("turn-status"),
      type: "agent_status_message",
      event: "model_request_failed",
      kind: "error",
      text: "recoverable status",
    },
    durable("turn-compact", true),
  ];

  assert.deepEqual([...deriveAgentTurnTerminations(entries)], []);
});
