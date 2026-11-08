import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

const now = () => new Date("2026-11-06T00:00:00.000Z");

async function recordIncompleteTurn(
  storage: ReturnType<typeof createAgentProjectSessionStorage>,
  sessionKey: string,
  turnId: string,
) {
  await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
    { role: "user", content: [{ type: "text", text: `input ${turnId}` }] },
  ]);
  await storage.transcript.recordDurableMessage(sessionKey, turnId, {
    role: "assistant",
    content: [{ type: "text", text: `output ${turnId}` }],
  });
}

function incompleteTurnIds(messages: Awaited<ReturnType<typeof readWebSessionMessages>>["messages"]) {
  for (const message of messages) {
    const payload = message.payload as { incompleteTurnIds?: string[] } | undefined;
    if (payload?.incompleteTurnIds) return payload.incompleteTurnIds;
  }
  return undefined;
}

test("web status excludes only the active turn and retains historical interruptions", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-active-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-active-home-"));
  try {
    const sessionKey = "web:s_active_mixed";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey, now });
    await recordIncompleteTurn(storage, sessionKey, "turn-historical");
    await recordIncompleteTurn(storage, sessionKey, "turn-active");
    const input = { sessionKey };

    const active = await readWebSessionMessages(input, {
      projectRoot, pilotHome, now, activeTurnId: "turn-active",
    });
    assert.deepEqual(incompleteTurnIds(active.messages), ["turn-historical"]);

    const otherActive = await readWebSessionMessages(input, {
      projectRoot, pilotHome, now, activeTurnId: "turn-historical",
    });
    assert.deepEqual(incompleteTurnIds(otherActive.messages), ["turn-active"]);

    const historical = await readWebSessionMessages(input, { projectRoot, pilotHome, now });
    assert.deepEqual(incompleteTurnIds(historical.messages), ["turn-historical", "turn-active"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("web does not label the sole in-flight turn as interrupted", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-active-only-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-active-only-home-"));
  try {
    const sessionKey = "web:s_active_only";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey, now });
    await recordIncompleteTurn(storage, sessionKey, "turn-active");

    const active = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now, activeTurnId: "turn-active" },
    );
    assert.equal(incompleteTurnIds(active.messages), undefined);
    assert.equal(active.messages.some(message => message.text?.includes("尚未写入最终结果")), false);

    const historical = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome, now });
    assert.deepEqual(incompleteTurnIds(historical.messages), ["turn-active"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
