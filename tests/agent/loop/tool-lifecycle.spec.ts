import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolCall,
} from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import type { PilotDeckToolResult } from "../../../src/tool/protocol/result.js";
import type { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successResult(call: Pick<CanonicalToolCall, "id" | "name">): PilotDeckToolResult {
  const timestamp = new Date().toISOString();
  return {
    type: "success",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `${call.name} completed` }],
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ["slow", "fast"]) {
    registry.register({
      name,
      description: name,
      kind: "custom",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [] }),
    });
  }
  return registry;
}

function createLoop(
  registry: ToolRegistry,
  runtime: ToolRuntime,
  requests: CanonicalModelRequest[],
): AgentLoop {
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (_decision, request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "message_start", role: "assistant" };
        for (const name of ["slow", "fast"]) {
          const toolCall = { id: name, name, input: {} };
          yield { type: "tool_call_start", id: name, name };
          yield { type: "tool_call_end", toolCall };
        }
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
    stream: async function* () {
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  return new AgentLoop(config, {
    router,
    tools: {
      registry,
      scheduler: new ConcurrentToolScheduler(runtime, registry),
    },
  });
}

function terminalEvents(events: AgentEvent[]) {
  return events.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> =>
    event.type === "tool_result");
}

function projectedToolCallIds(messages: CanonicalMessage[]): string[] {
  return messages.flatMap(message => message.content.flatMap(block =>
    block.type === "tool_result" ? [block.toolCallId] : []));
}

const inputMessages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "run both tools" }] },
];

test("tool completion events are independent while model results retain call order", { timeout: 5_000 }, async () => {
  const slow = deferred<PilotDeckToolResult>();
  const runtime = {
    execute: async (call: CanonicalToolCall) =>
      call.name === "slow" ? slow.promise : successResult(call),
  } as unknown as ToolRuntime;
  const registry = createRegistry();
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(registry, runtime, requests);
  const events: AgentEvent[] = [];
  const durable: CanonicalMessage[] = [];
  let fastFinishedBeforeSlow = false;

  for await (const event of loop.run({
    sessionId: "tool-progress-independence",
    turnId: "turn-1",
    messages: inputMessages,
    onDurableMessage: async message => { durable.push(message); },
  })) {
    events.push(event);
    if (event.type === "tool_result" && event.result.toolCallId === "fast") {
      fastFinishedBeforeSlow = requests.length === 1;
      slow.resolve(successResult({ id: "slow", name: "slow" }));
    }
  }

  assert.equal(fastFinishedBeforeSlow, true);
  assert.deepEqual(terminalEvents(events).map(event => event.result.toolCallId), ["fast", "slow"]);
  assert.deepEqual(projectedToolCallIds(durable), ["slow", "fast"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(projectedToolCallIds([requests[1]!.messages.at(-1)!]), ["slow", "fast"]);
});

test("abort closes pending tools once and ignores their late results", { timeout: 5_000 }, async () => {
  const slow = deferred<PilotDeckToolResult>();
  const runtime = {
    execute: async (call: CanonicalToolCall) =>
      call.name === "slow" ? slow.promise : successResult(call),
  } as unknown as ToolRuntime;
  const registry = createRegistry();
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(registry, runtime, requests);
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const durable: CanonicalMessage[] = [];

  for await (const event of loop.run({
    sessionId: "tool-abort-closure",
    turnId: "turn-1",
    messages: inputMessages,
    abortSignal: controller.signal,
    onDurableMessage: async message => { durable.push(message); },
  })) {
    events.push(event);
    if (event.type === "tool_result" && event.result.toolCallId === "fast") {
      controller.abort();
      controller.abort();
    }
  }

  const terminal = terminalEvents(events);
  assert.deepEqual(terminal.map(event => event.result.toolCallId), ["fast", "slow"]);
  assert.equal(terminal[0]!.result.type, "success");
  assert.equal(terminal[1]!.result.type, "error");
  assert.equal(terminal[1]!.result.type === "error" && terminal[1]!.result.error.code, "tool_aborted");
  assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
  assert.equal(events.find(event => event.type === "turn_completed")?.result.type, "aborted");
  assert.deepEqual(projectedToolCallIds(durable), ["slow", "fast"]);
  assert.equal(requests.length, 1);

  const eventCount = events.length;
  slow.resolve(successResult({ id: "slow", name: "slow" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, eventCount);
});

test("abort before dispatch closes announced calls without executing them", { timeout: 5_000 }, async () => {
  const executed: string[] = [];
  const runtime = {
    execute: async (call: CanonicalToolCall) => {
      executed.push(call.id);
      return successResult(call);
    },
  } as unknown as ToolRuntime;
  const registry = createRegistry();
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(registry, runtime, requests);
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const durable: CanonicalMessage[] = [];

  for await (const event of loop.run({
    sessionId: "tool-abort-before-dispatch",
    turnId: "turn-1",
    messages: inputMessages,
    abortSignal: controller.signal,
    onDurableMessage: async message => { durable.push(message); },
  })) {
    events.push(event);
    if (event.type === "assistant_message") controller.abort();
  }

  assert.deepEqual(executed, []);
  const terminal = terminalEvents(events);
  assert.equal(terminal.length, 2);
  assert.ok(terminal.every(event =>
    event.result.type === "error" && event.result.error.code === "tool_aborted"));
  assert.deepEqual(projectedToolCallIds(durable), ["slow", "fast"]);
});
