import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resumeAgentSession, type ResumeAgentSessionOptions } from "../../src/session/resume/resumeAgentSession.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

test("resume replays interrupted durable output without writing to the transcript", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-readonly-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-readonly-home-"));
  try {
    const sessionId = "web:s_readonly_resume";
    const turnId = "turn-interrupted";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId,
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    await storage.transcript.recordAcceptedInput(sessionId, turnId, [
      { role: "user", content: [{ type: "text", text: "run the tool" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionId, turnId, {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "bash", input: { command: "printf marker" } }],
    });
    await storage.transcript.recordDurableMessage(sessionId, turnId, {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "durable tool output marker" }],
      }],
    });

    const before = await readFile(storage.transcriptPath);
    const options: ResumeAgentSessionOptions = {
      sessionId,
      config: {
        provider: "test",
        model: "test",
        cwd: projectRoot,
        permissionMode: "bypassPermissions",
        permissionContext: {
          mode: "bypassPermissions",
          rules: { allow: [], deny: [], ask: [] },
          cwd: projectRoot,
          additionalWorkingDirectories: [],
          canPrompt: false,
          bypassAvailable: true,
        },
      },
      projectStorage: { projectRoot, pilotHome },
      dependencies: {
        now: () => new Date("2026-11-06T00:00:00.000Z"),
        tools: { registry: new ToolRegistry() },
        router: {
          async *stream() { throw new Error("not used"); },
          async *execute() { throw new Error("not used"); },
          async decide() { throw new Error("not used"); },
        },
      },
    };

    const first = await resumeAgentSession(options);
    assert.equal(digest(await readFile(storage.transcriptPath)), digest(before));
    assert.equal(first.session.snapshot().messages.length, 3);
    assert.match(JSON.stringify(first.session.snapshot().messages), /durable tool output marker/);
    assert.deepEqual(first.diagnostics.map(item => [item.code, item.turnId]), [
      ["transcript_turn_incomplete", turnId],
    ]);
    assert.equal(first.diagnostics.some(item => item.code === "transcript_entry_invalid"), false);

    const persisted = await readTranscript(storage.transcriptPath);
    assert.equal(persisted.entries.length, 3);
    assert.equal(persisted.entries.some(entry => entry.type === "turn_result"), false);

    const second = await resumeAgentSession(options);
    assert.equal(digest(await readFile(storage.transcriptPath)), digest(before));
    assert.deepEqual(second.session.snapshot().messages, first.session.snapshot().messages);
    assert.deepEqual(second.diagnostics, first.diagnostics);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
