import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

const createdAt = "2026-11-06T00:00:00.000Z";

function incompleteEntries(): AgentTranscriptEntry[] {
  const base = { sessionId: "session-1", turnId: "turn-interrupted", createdAt };
  return [
    {
      ...base,
      type: "accepted_input",
      sequence: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "run the tool" }] }],
    },
    {
      ...base,
      type: "assistant_message",
      sequence: 2,
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "bash", input: { command: "pwd" } }],
      },
    },
    {
      ...base,
      type: "tool_result_message",
      sequence: 3,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "durable tool output" }],
        }],
      },
    },
    {
      ...base,
      type: "durable_message",
      sequence: 4,
      message: { role: "user", content: [{ type: "text", text: "durable progress note" }] },
    },
  ];
}

test("replays incomplete durable history with a state diagnostic, not corruption", () => {
  const entries = incompleteEntries();
  const before = structuredClone(entries);
  const replay = replayTranscriptEntries(entries);

  assert.equal(replay.messages.length, 4);
  assert.notEqual(replay.messages[0], entries[0]?.type === "accepted_input" ? entries[0].messages[0] : undefined);
  assert.equal(replay.messages[1]?.role, "assistant");
  assert.equal(replay.messages[2]?.role, "user");
  assert.match(JSON.stringify(replay.messages), /durable tool output/);
  assert.match(JSON.stringify(replay.messages), /durable progress note/);
  assert.deepEqual(replay.turnTerminations.get("turn-interrupted"), "incomplete");
  assert.deepEqual(replay.diagnostics, [{
    code: "transcript_turn_incomplete",
    severity: "warning",
    message: "Replaying incomplete turn turn-interrupted; no turn_result was recorded.",
    turnId: "turn-interrupted",
  }]);
  assert.equal(replay.diagnostics.some(item => item.code === "transcript_entry_invalid"), false);
  assert.equal(replay.events.some(event => event.type === "turn_completed"), false);
  assert.deepEqual(entries, before, "replay must not mutate persisted entries");
  assert.deepEqual(replayTranscriptEntries(entries).messages, replay.messages);
});

test("reports an accepted but otherwise empty interrupted turn once", () => {
  const [accepted] = incompleteEntries();
  const replay = replayTranscriptEntries([accepted!]);

  assert.equal(replay.messages.length, 1);
  assert.deepEqual(replay.diagnostics.map(item => [item.code, item.turnId]), [
    ["transcript_turn_incomplete", "turn-interrupted"],
  ]);
});
