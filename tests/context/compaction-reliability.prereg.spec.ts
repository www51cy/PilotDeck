import assert from "node:assert/strict";
import test from "node:test";

import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";

function rollingWorkMessages(label: string): CanonicalMessage[] {
  return Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{ type: "text" as const, text: `${label} work ${index} ${"context ".repeat(20)}` }],
  }));
}

function requestInputTokens(tokenBudget: TokenBudgetManager, request: CanonicalModelRequest): number {
  return tokenBudget.estimateMessagesTokens(request.messages)
    + tokenBudget.estimateTextTokens(request.systemPrompt ?? "");
}

function successfulSummaryEvents(text = "## Objective\nRecovered."): CanonicalModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "message_end", finishReason: "stop" },
  ];
}

test("B1: first summary request enforces a non-vacuous total input budget", async () => {
  const tokenBudget = new TokenBudgetManager();
  const messages = rollingWorkMessages(`Bounded ${"details ".repeat(200)}`);
  const makeEngine = (requests: CanonicalModelRequest[]) => new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield* successfulSummaryEvents("## Objective\nContinue.\n\n## Current State\nBounded.");
      },
    },
    provider: "local",
    model_: "local-chat",
    maxOutputTokens: 500,
  });
  const runInput = {
    trigger: "auto" as const,
    messages,
    keepTailRatio: 0.01,
    protectedToolNames: null,
  };

  const unboundedRequests: CanonicalModelRequest[] = [];
  const unbounded = await makeEngine(unboundedRequests).run(runInput);
  assert.equal(unbounded.error, undefined);
  assert.equal(unboundedRequests.length, 1);
  const unboundedTokens = requestInputTokens(tokenBudget, unboundedRequests[0]!);
  assert.ok(unboundedTokens > 3_500, `vacuous fixture: unbounded input was only ${unboundedTokens}`);

  const boundedRequests: CanonicalModelRequest[] = [];
  const bounded = await makeEngine(boundedRequests).run({
    ...runInput,
    effectiveContextTokens: 4_000,
  });
  assert.equal(bounded.error, undefined);
  assert.equal(boundedRequests.length, 1);
  const boundedTokens = requestInputTokens(tokenBudget, boundedRequests[0]!);
  assert.ok(boundedTokens <= 3_500, `summary input was ${boundedTokens}, unbounded was ${unboundedTokens}`);
});

test("R1: output length retries three times with strictly smaller inputs and rejects truncation", async () => {
  const tokenBudget = new TokenBudgetManager();
  const requests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield { type: "text_delta", text: "## Objective\nIncomplete" };
        yield { type: "message_end", finishReason: "length" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  const result = await engine.run({
    trigger: "auto",
    messages: rollingWorkMessages("Retry"),
    effectiveContextTokens: 20_000,
    keepTailRatio: 0.01,
    protectedToolNames: null,
  });

  assert.equal(requests.length, 3);
  const inputSizes = requests.map(request => requestInputTokens(tokenBudget, request));
  assert.ok(inputSizes.every(tokens => tokens > 0));
  assert.ok(inputSizes[1]! < inputSizes[0]!, inputSizes.join(" -> "));
  assert.ok(inputSizes[2]! < inputSizes[1]!, inputSizes.join(" -> "));
  assert.ok(requests[0]!.maxOutputTokens! > requests[1]!.maxOutputTokens!);
  assert.equal(requests[1]!.maxOutputTokens, 1_536);
  assert.equal(requests[2]!.maxOutputTokens, 1_536);
  assert.match(requests[0]!.systemPrompt ?? "", /## Completed/);
  assert.doesNotMatch(requests[1]!.systemPrompt ?? "", /## Completed/);
  assert.match(requests[1]!.systemPrompt ?? "", /## Objective/);
  assert.match(result.error ?? "", /truncated at the token limit/);
  assert.equal(result.summaryGenerated, false);
  assert.equal(result.summaryMessage, undefined);
});

test("R2: provider prompt_too_long retries with smaller input and can recover", async () => {
  const tokenBudget = new TokenBudgetManager();
  const requests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    tokenBudget,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        if (requests.length <= 2) {
          yield {
            type: "error",
            error: {
              provider: "local",
              protocol: "openai",
              code: "prompt_too_long",
              message: "prompt_too_long: summary input exceeds the context window",
              retryable: false,
              recoverableViaCompact: true,
            },
          };
          return;
        }
        yield* successfulSummaryEvents("## Objective\nRecovered after provider retry.");
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  const result = await engine.run({
    trigger: "auto",
    messages: rollingWorkMessages("Provider retry"),
    effectiveContextTokens: 20_000,
    keepTailRatio: 0.01,
    protectedToolNames: null,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.summaryGenerated, true);
  assert.ok(result.summaryMessage);
  assert.equal(requests.length, 3);
  const inputSizes = requests.map(request => requestInputTokens(tokenBudget, request));
  assert.ok(inputSizes[1]! < inputSizes[0]!, inputSizes.join(" -> "));
  assert.ok(inputSizes[2]! < inputSizes[1]!, inputSizes.join(" -> "));
});

test("F1: three failures open a circuit and permit only one half-open probe", async () => {
  let now = 1_000_000;
  let calls = 0;
  let releaseProbe!: () => void;
  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve; });
  const engine = new CompactionEngine({
    now: () => new Date(now),
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        calls += 1;
        if (calls <= 3) throw new Error("summary backend down");
        yield* successfulSummaryEvents();
        if (calls === 4) {
          markProbeStarted();
          await probeGate;
        }
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const run = (trigger: "auto" | "manual" = "auto") => engine.run({
    trigger,
    messages: rollingWorkMessages("Circuit"),
    keepTailRatio: 0.01,
  });

  await run();
  now += 61_000;
  await run();
  now += 61_000;
  await run();
  assert.equal(calls, 3);

  const blocked = await run();
  assert.equal(calls, 3);
  assert.match(blocked.error ?? "", /circuit breaker is open/);

  now += 300_001;
  const probe = run();
  await probeStarted;
  const concurrent = await run();
  assert.equal(calls, 4);
  assert.match(concurrent.error ?? "", /half-open probe is already running/);
  releaseProbe();
  const recovered = await probe;
  assert.equal(recovered.error, undefined);

  const afterSuccess = await run();
  assert.equal(afterSuccess.error, undefined);
  assert.equal(calls, 5);
});

test("F2: manual compaction is an explicit recovery exit from the circuit", async () => {
  let now = 1_000_000;
  let calls = 0;
  const engine = new CompactionEngine({
    now: () => new Date(now),
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        calls += 1;
        if (calls <= 3) throw new Error("summary backend down");
        yield* successfulSummaryEvents("## Objective\nManual recovery.");
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.run({ trigger: "auto", messages: rollingWorkMessages("Manual"), keepTailRatio: 0.01 });
    now += 61_000;
  }
  assert.equal(calls, 3);

  const recovered = await engine.run({
    trigger: "manual",
    messages: rollingWorkMessages("Manual"),
    keepTailRatio: 0.01,
  });
  assert.equal(recovered.error, undefined);
  assert.equal(calls, 4);
});

test("C1: the first failure retains the 60 second cooldown", async () => {
  let now = 1_000_000;
  let calls = 0;
  const engine = new CompactionEngine({
    now: () => new Date(now),
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        calls += 1;
        throw new Error("summary backend down");
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const run = () => engine.run({
    trigger: "auto",
    messages: rollingWorkMessages("Cooldown"),
    keepTailRatio: 0.01,
  });

  await run();
  assert.equal(calls, 1);
  now += 59_999;
  await run();
  assert.equal(calls, 1);
  now += 2;
  await run();
  assert.equal(calls, 2);
});
