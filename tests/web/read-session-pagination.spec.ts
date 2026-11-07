import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

function completedTurn(sessionId: string, turnId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-08-02T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
  };
}

test("backward history returns the latest window and stable cursors for older pages", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-pagination-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-pagination-home-"));
  try {
    const sessionKey = "web:s_pagination";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    for (let index = 1; index <= 5; index += 1) {
      const turnId = `turn-${index}`;
      await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
        { role: "user", content: [{ type: "text", text: `message-${index}` }] },
      ]);
      await storage.transcript.recordTurnResult(sessionKey, turnId, completedTurn(sessionKey, turnId));
    }

    const full = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    assert.deepEqual(full.messages.map((message) => message.text), [
      "message-1", "message-2", "message-3", "message-4", "message-5",
    ]);

    const latest = await readWebSessionMessages(
      { sessionKey, limit: 2, direction: "backward" },
      { projectRoot, pilotHome },
    );
    assert.deepEqual(latest.messages.map((message) => message.text), ["message-4", "message-5"]);
    assert.deepEqual(latest.messages.map((message) => message.id), full.messages.slice(3).map((message) => message.id));
    assert.equal(latest.total, 5);
    assert.equal(latest.prevCursor, "3");
    assert.equal(latest.nextCursor, undefined);

    const middle = await readWebSessionMessages(
      { sessionKey, limit: 2, cursor: latest.prevCursor, direction: "backward" },
      { projectRoot, pilotHome },
    );
    assert.deepEqual(middle.messages.map((message) => message.text), ["message-2", "message-3"]);
    assert.deepEqual(middle.messages.map((message) => message.id), full.messages.slice(1, 3).map((message) => message.id));
    assert.equal(middle.prevCursor, "1");

    const oldest = await readWebSessionMessages(
      { sessionKey, limit: 2, cursor: middle.prevCursor, direction: "backward" },
      { projectRoot, pilotHome },
    );
    assert.deepEqual(oldest.messages.map((message) => message.text), ["message-1"]);
    assert.equal(oldest.prevCursor, undefined);

    const forward = await readWebSessionMessages(
      { sessionKey, limit: 2 },
      { projectRoot, pilotHome },
    );
    assert.deepEqual(forward.messages.map((message) => message.text), ["message-1", "message-2"]);
    assert.equal(forward.nextCursor, "2");
    assert.equal(forward.prevCursor, undefined);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("backward pages start on a user prompt instead of cutting a turn in half", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-align-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-align-home-"));
  try {
    const sessionKey = "web:s_align";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    for (let index = 1; index <= 3; index += 1) {
      const turnId = `turn-${index}`;
      await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
        { role: "user", content: [{ type: "text", text: `question-${index}` }] },
      ]);
      await storage.transcript.recordDurableMessage(sessionKey, turnId, {
        role: "assistant",
        content: [{ type: "text", text: `answer-${index}` }],
      });
      await storage.transcript.recordTurnResult(sessionKey, turnId, completedTurn(sessionKey, turnId));
    }

    const full = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    assert.deepEqual(
      full.messages.map((message) => message.text),
      ["question-1", "answer-1", "question-2", "answer-2", "question-3", "answer-3"],
    );

    // A raw window of 3 records would start at "answer-2"; the page must
    // backtrack so it begins on the turn's user prompt.
    const aligned = await readWebSessionMessages(
      { sessionKey, limit: 3, direction: "backward" },
      { projectRoot, pilotHome },
    );
    assert.equal(aligned.messages[0]?.kind, "text");
    assert.equal(aligned.messages[0]?.role, "user");
    assert.deepEqual(
      aligned.messages.map((message) => message.text),
      ["question-2", "answer-2", "question-3", "answer-3"],
    );
    assert.equal(aligned.prevCursor, "2");

    // Arbitrary later cursors must still align to a user prompt.
    const older = await readWebSessionMessages(
      { sessionKey, limit: 1, cursor: aligned.prevCursor, direction: "backward" },
      { projectRoot, pilotHome },
    );
    assert.equal(older.messages[0]?.role, "user");
    assert.deepEqual(older.messages.map((message) => message.text), ["question-1", "answer-1"]);
    assert.equal(older.prevCursor, undefined);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
