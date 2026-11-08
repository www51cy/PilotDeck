import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop } from "../../src/agent/loop/AgentLoop.js";
import type { AgentLoop as AgentLoopType, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/protocol/types.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import type { AgentControlBoundaryTranscriptEntry, AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const createdAt = "2026-11-07T00:00:00.000Z";
const originalMessages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "original context" }] },
];
function truncatedMessages(): CanonicalMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "latest request" }] },
  ];
}

function successfulModelEvents(text: string): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text },
    { type: "message_end", finishReason: "stop" },
  ];
}

test("E2: AgentLoop persists an emergency_truncate snapshot without summary success", async () => {
  const persisted: Array<{ boundary: unknown; messages: CanonicalMessage[] }> = [];
  const tokenBudget = new TokenBudgetManager();
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async input => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async input => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async () => ({
      type: "compacted",
      tier: "full",
      messages: truncatedMessages(),
      snapshot: tokenBudget.snapshotFromTokens(100, 2_000),
      emergencyTruncation: { preTokens: 1_900, postTokens: 100 },
    }),
  };
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield* successfulModelEvents("done");
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield* successfulModelEvents("done");
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "model-a",
    cwd: "/workspace/project",
    maxContextTokens: 2_000,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { async executeAll() { return []; } },
    },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number }) =>
        tokenBudget.snapshotFromTokens(100, options.maxContextTokens),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  };
  const loop = new AgentLoop(config, dependencies);

  for await (const _event of loop.run({
    sessionId: "emergency-loop",
    turnId: "emergency-loop-turn",
    messages: originalMessages,
    onCompactPersisted: ({ boundary, messages }) => {
      persisted.push({ boundary, messages });
    },
  })) {
    // Drain the completed turn.
  }

  assert.equal(persisted.length, 1);
  const boundary = persisted[0]!.boundary as {
    kind?: string;
    subtype?: string;
    compactMetadata?: Record<string, unknown>;
  };
  assert.equal(boundary.kind, "compact");
  assert.equal(boundary.subtype, "emergency_truncate");
  assert.notEqual(boundary.subtype, "compact_boundary");
  assert.equal(boundary.compactMetadata?.trigger, "reactive");
  assert.equal(boundary.compactMetadata?.preTokens, 1_900);
  assert.equal(boundary.compactMetadata?.postTokens, 100);
  assert.equal(boundary.compactMetadata?.summaryGenerated, false);
  assert.equal(boundary.compactMetadata?.messagesSummarized, 0);
  assert.equal(persisted[0]!.messages.length, 1);
  assert.equal(persisted[0]!.messages[0]!.metadata?.compactReplacement, true);
});

test("E3: TurnRunner and JSONL writer durably flush a complete emergency snapshot", async t => {
  const dir = await mkdtemp(join(tmpdir(), "emergency-compact-turn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  const handle = await open(path, "a+");
  const prototype = Object.getPrototypeOf(handle);
  const originalSync = prototype.sync;
  let syncs = 0;
  const syncMock = t.mock.method(prototype, "sync", async function (this: typeof handle) {
    await originalSync.call(this);
    syncs += 1;
  });
  await handle.close();
  let checkedBeforeTurnCompletion = false;
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await input.onCompactPersisted!({
        boundary: {
          kind: "compact",
          subtype: "emergency_truncate",
          compactMetadata: {
            trigger: "reactive",
            preTokens: 1_900,
            postTokens: 100,
            messagesSummarized: 0,
            summaryGenerated: false,
          },
        },
        messages: truncatedMessages(),
      });
      const during = await readTranscript(path);
      checkedBeforeTurnCompletion = during.entries.some(entry =>
        entry.type === "control_boundary" && entry.boundary.kind === "compact" &&
        (entry.boundary as { subtype?: string }).subtype === "emergency_truncate" &&
        entry.boundary.snapshot?.version === 1,
      ) && replayTranscriptEntries(during.entries).messages.length === 1 && syncs === 1;
      return {
        messages: truncatedMessages(),
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: createdAt,
          completedAt: createdAt,
        },
      };
    },
  } as unknown as AgentLoopType;
  const runner = new TurnRunner(loop, writer, undefined, undefined, undefined, {
    cwd: dir,
    transcriptPath: path,
    collectFileArtifacts: false,
  });

  for await (const _event of runner.run({
    sessionId: "emergency-session",
    turnId: "emergency-turn",
    messages: [],
    input: { type: "text", text: "original input" },
  })) {
    // Exhaust the turn.
  }

  assert.equal(checkedBeforeTurnCompletion, true);
  assert.equal(syncs, 1);
  syncMock.mock.restore();
  const raw = await readFile(path, "utf8");
  assert.match(raw, /original input/);
  assert.match(raw, /emergency_truncate/);
  const { entries } = await readTranscript(path);
  assert.deepEqual(entries.map(entry => entry.type), ["accepted_input", "control_boundary", "turn_result"]);
  assert.deepEqual(replayTranscriptEntries(entries).messages, truncatedMessages());
});

test("E4: replay accepts only complete emergency snapshots and retains raw history", () => {
  const base = { sessionId: "emergency-replay", turnId: "old-turn", createdAt };
  const oldEntry: AgentTranscriptEntry = {
    ...base,
    type: "accepted_input",
    sequence: 1,
    messages: originalMessages,
  };
  const completeEntry = {
    ...base,
    type: "control_boundary",
    sequence: 2,
    boundary: {
      kind: "compact",
      subtype: "emergency_truncate",
      compactMetadata: {
        trigger: "reactive",
        preTokens: 1_900,
        postTokens: 100,
        messagesSummarized: 0,
        summaryGenerated: false,
      },
      snapshot: { version: 1, messages: truncatedMessages() },
    },
  } as unknown as AgentTranscriptEntry;
  const laterMessages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "later input" }] },
  ];
  const laterEntry: AgentTranscriptEntry = {
    ...base,
    type: "accepted_input",
    turnId: "next-turn",
    sequence: 3,
    messages: laterMessages,
  };
  const entries = [oldEntry, completeEntry, laterEntry];

  const replay = replayTranscriptEntries(entries);
  assert.deepEqual(replay.messages, [...truncatedMessages(), ...laterMessages]);
  assert.equal(replay.lastCompactBoundary, completeEntry);
  assert.equal(entries[0], oldEntry);
  assert.match(JSON.stringify(entries), /original context/);

  const invalidSnapshots: unknown[] = [
    undefined,
    { version: 2, messages: truncatedMessages() },
    { version: 1, messages: [] },
  ];
  for (const [index, snapshot] of invalidSnapshots.entries()) {
    const invalid = {
      ...completeEntry,
      sequence: 4 + index,
      boundary: {
        ...(completeEntry as AgentControlBoundaryTranscriptEntry).boundary,
        snapshot,
      },
    } as unknown as AgentTranscriptEntry;
    const fallback = replayTranscriptEntries([oldEntry, invalid]);
    assert.deepEqual(fallback.messages, originalMessages);
    assert.equal(fallback.lastCompactBoundary, undefined);
    const prior = replayTranscriptEntries([oldEntry, completeEntry, invalid]);
    assert.deepEqual(prior.messages, truncatedMessages());
    assert.equal(prior.lastCompactBoundary, completeEntry);
  }
});

test("E4-control: incomplete emergency snapshots conservatively retain original history", () => {
  const oldEntry: AgentTranscriptEntry = {
    sessionId: "emergency-replay-control",
    turnId: "old-turn",
    createdAt,
    type: "accepted_input",
    sequence: 1,
    messages: originalMessages,
  };
  const invalidSnapshots: unknown[] = [
    undefined,
    { version: 2, messages: truncatedMessages() },
    { version: 1, messages: [] },
  ];
  for (const [index, snapshot] of invalidSnapshots.entries()) {
    const invalid = {
      sessionId: "emergency-replay-control",
      turnId: "old-turn",
      createdAt,
      type: "control_boundary",
      sequence: 2 + index,
      boundary: {
        kind: "compact",
        subtype: "emergency_truncate",
        compactMetadata: {
          trigger: "reactive",
          preTokens: 1_900,
          postTokens: 100,
          messagesSummarized: 0,
          summaryGenerated: false,
        },
        snapshot,
      },
    } as unknown as AgentTranscriptEntry;
    const replay = replayTranscriptEntries([oldEntry, invalid]);
    assert.deepEqual(replay.messages, originalMessages);
    assert.equal(replay.lastCompactBoundary, undefined);
  }
});
