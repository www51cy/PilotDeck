import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import { MicroCompactionEngine } from "../../src/context/compaction/MicroCompactionEngine.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";

function textMessages(...texts: string[]): CanonicalMessage[] {
  return texts.map((text, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text }],
  }));
}

function textFrom(messages: CanonicalMessage[]): string {
  return messages.flatMap(message => message.content.flatMap(block =>
    block.type === "text" ? [block.text] : [],
  )).join("\n");
}

function hasCompactSummary(messages: CanonicalMessage[]): boolean {
  return textFrom(messages).includes("[CONTEXT COMPACTION - REFERENCE ONLY]");
}

function largeToolResultFixture(): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `read-${index}`, name: "read_file", input: { file_path: `/tmp/file-${index}.txt` } }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: `read-${index}`,
        content: [{ type: "text", text: `output-${index} `.repeat(1_200) }],
      }],
    });
  }
  return messages;
}

test("T1: 80 percent warning runs full summary before the blocking tier", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "text_delta", text: "## Objective\nKeep working at warning." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 20_000,
  });

  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 12 }, (_, index) => `turn-${index}`)),
    budgetEvaluator: candidate => Promise.resolve(tokenBudget.snapshotFromTokens(
      hasCompactSummary(candidate) ? 4_000 : 16_000,
      20_000,
    )),
  });

  if (result.type !== "compacted") assert.fail("80% warning must compact");
  assert.equal(result.tier, "full");
  assert.equal(summaryRequests.length, 1);
  assert.equal(result.result?.summaryGenerated, true);
  assert.match(textFrom(result.messages), /Keep working at warning/);
});

test("T2: micro pruning below 80 percent finishes without a summary call", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "text_delta", text: "unused" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    microCompaction: new MicroCompactionEngine(),
    maxContextTokens: 20_000,
  });

  const result = await runtime.tryAutoCompact({
    messages: largeToolResultFixture(),
    budgetEvaluator: candidate => Promise.resolve(tokenBudget.snapshotFromTokens(
      JSON.stringify(candidate).includes("[Old tool result content compacted]") ? 15_200 : 17_200,
      20_000,
    )),
  });

  if (result.type !== "compacted") assert.fail("effective micro pruning must compact");
  assert.equal(result.tier, "micro");
  assert.equal(summaryRequests.length, 0);
});

test("E1: failed summaries expose real emergency truncation without a fake checkpoint", async () => {
  const tokenBudget = new TokenBudgetManager();
  const engine = new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        yield {
          type: "error",
          error: {
            provider: "local",
            protocol: "openai",
            code: "server_error",
            message: "summary provider unavailable",
            retryable: true,
          },
        };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const messages = textMessages(
    "Original task: preserve the artifact map.",
    ...Array.from({ length: 20 }, (_, index) => `earlier turn ${index} ${"context ".repeat(20)}`),
    "Final recent question: continue.",
  );
  const original = structuredClone(messages);
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 2_000,
  });

  const result = await runtime.tryAutoCompact({
    messages,
    allowFallbackOnFailure: true,
    budgetEvaluator: candidate => Promise.resolve(tokenBudget.snapshotFromTokens(
      textFrom(candidate).includes("Original task: preserve the artifact map.") ? 1_900 : 100,
      2_000,
    )),
  });

  if (result.type !== "compacted") assert.fail("hard truncation must produce an active replacement");
  assert.equal(result.result, undefined);
  assert.doesNotMatch(textFrom(result.messages), /<compact-boundary/);
  assert.doesNotMatch(textFrom(result.messages), /Original task: preserve the artifact map/);
  assert.match(textFrom(result.messages), /Final recent question: continue/);
  assert.deepEqual(messages, original);
  const emergencyTruncation = (result as typeof result & {
    emergencyTruncation?: { preTokens: number; postTokens: number };
  }).emergencyTruncation;
  assert.deepEqual(emergencyTruncation, { preTokens: 1_900, postTokens: 100 });
});
