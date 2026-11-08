import test from "node:test";
import assert from "node:assert/strict";

import { insertWebMessageByTranscriptOrder } from "../../src/web/server/readSessionMessages.js";

type Msg = Parameters<typeof insertWebMessageByTranscriptOrder>[0][number];

function message(id: string, createdAt: string, sequence?: number): Msg {
  return {
    id,
    sessionId: "web:s_order",
    turnId: "turn",
    role: "system",
    kind: "status",
    content: "",
    createdAt,
    ...(sequence === undefined ? {} : { sequence }),
  } as unknown as Msg;
}

test("turn-local sequences never hoist a later row above earlier ones", () => {
  const messages: Msg[] = [];
  // Runtime status rows restart their counter at 1 for every turn, so a later
  // status row can carry a smaller `sequence` than the message before it.
  insertWebMessageByTranscriptOrder(messages, message("u1", "2026-11-08T10:00:00.000Z", 1));
  insertWebMessageByTranscriptOrder(messages, message("a1", "2026-11-08T10:00:05.000Z", 2));
  insertWebMessageByTranscriptOrder(messages, message("s2", "2026-11-08T10:00:09.000Z", 1));

  assert.deepEqual(
    messages.map((entry) => entry.id),
    ["u1", "a1", "s2"],
  );
});

test("equal timestamps fall back to sequence", () => {
  const messages: Msg[] = [];
  insertWebMessageByTranscriptOrder(messages, message("late", "2026-11-08T10:00:00.000Z", 5));
  insertWebMessageByTranscriptOrder(messages, message("early", "2026-11-08T10:00:00.000Z", 3));

  assert.deepEqual(
    messages.map((entry) => entry.id),
    ["early", "late"],
  );
});

test("equal timestamps without sequences keep arrival order", () => {
  const messages: Msg[] = [];
  insertWebMessageByTranscriptOrder(messages, message("first", "2026-11-08T10:00:00.000Z"));
  insertWebMessageByTranscriptOrder(messages, message("second", "2026-11-08T10:00:00.000Z"));

  assert.deepEqual(
    messages.map((entry) => entry.id),
    ["first", "second"],
  );
});

test("rows without a sequence still land in timestamp order", () => {
  const messages: Msg[] = [];
  insertWebMessageByTranscriptOrder(messages, message("t2", "2026-11-08T10:00:05.000Z"));
  insertWebMessageByTranscriptOrder(messages, message("t1", "2026-11-08T10:00:00.000Z"));
  insertWebMessageByTranscriptOrder(messages, message("t3", "2026-11-08T10:00:09.000Z"));

  assert.deepEqual(
    messages.map((entry) => entry.id),
    ["t1", "t2", "t3"],
  );
});
