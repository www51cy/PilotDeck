import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import {
  AgentLoop,
  type AgentLoopInput,
} from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import { SubagentFailureError } from "../../../src/agent/sub/SubagentFailureGuard.js";
import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "../../../src/agent/sub/builtinSubagentTypes.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
} from "../../../src/permission/index.js";
import { createBashTool } from "../../../src/tool/builtin/bash.js";
import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import { createExecuteCodeTool } from "../../../src/tool/builtin/executeCode.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import {
  ToolRegistry,
  type PilotDeckSubagentForkApi,
  type PilotDeckToolDefinition,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";
import type { CanonicalMessage, CanonicalToolCall } from "../../../src/model/index.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const tempPilotHomes: string[] = [];

afterEach(() => {
  for (const dir of tempPilotHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type TestableSubAgentSession = {
  buildScopedRegistry(): ToolRegistry;
  buildConfig(): AgentRuntimeConfig;
};

type TestableAgentLoop = {
  buildSubagentForkApi(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): PilotDeckSubagentForkApi;
};

function createNoopTool(
  name: string,
  isReadOnly: PilotDeckToolDefinition["isReadOnly"],
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      data: {},
    }),
  };
}

function createOutcomeTool(
  name: string,
  attempts: unknown[],
  outcome: (input: unknown, attempt: number) => string | undefined,
): PilotDeckToolDefinition {
  return {
    ...createNoopTool(name, () => true),
    execute: async (input) => {
      attempts.push(input);
      const errorMessage = outcome(input, attempts.length);
      if (errorMessage !== undefined) {
        throw new PilotDeckToolRuntimeError("tool_execution_failed", errorMessage);
      }
      return {
        content: [{ type: "text", text: "ok" }],
        data: {},
      };
    },
  };
}

type ScriptedCall = Pick<CanonicalToolCall, "name" | "input">;

function createScriptedToolRouter(script: ScriptedCall[][]): {
  router: AgentRouterRuntime;
  requestCount: () => number;
} {
  const base = createRouter();
  let requestCount = 0;
  return {
    router: {
      ...base,
      execute: async function* () {
        const batch = script[requestCount] ?? [];
        requestCount++;
        yield { type: "message_start", role: "assistant" };
        if (batch.length === 0) {
          yield { type: "text_delta", text: FINAL_REPORT };
          yield { type: "message_end", finishReason: "stop" };
          return;
        }
        for (const [index, call] of batch.entries()) {
          const toolCall = {
            id: `scripted-${requestCount}-${index}`,
            name: call.name,
            input: call.input,
          };
          yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
          yield { type: "tool_call_end", toolCall };
        }
        yield { type: "message_end", finishReason: "tool_call" };
      },
    } as AgentRouterRuntime,
    requestCount: () => requestCount,
  };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

function createBlockingRouter(onStarted?: () => void): AgentRouterRuntime {
  return {
    ...createRouter(),
    execute: async function* (_decision, _request, context) {
      onStarted?.();
      await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal;
        if (!signal) {
          reject(new Error("blocking test router requires an abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  } as AgentRouterRuntime;
}

function parentConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createSubagentForkHarness(
  router: AgentRouterRuntime,
  registry = new ToolRegistry(),
): {
  events: AgentEvent[];
  fork: PilotDeckSubagentForkApi;
} {
  const events: AgentEvent[] = [];
  const loop = new AgentLoop(parentConfig(), {
    router,
    tools: {
      registry,
      scheduler: {} as never,
    },
    eventEmitter: (event) => {
      events.push(event);
    },
  }) as unknown as TestableAgentLoop;
  const fork = loop.buildSubagentForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [],
  }, []);
  return { events, fork };
}

function sessionFor(
  definition: SubagentDefinition,
  registry: ToolRegistry,
): TestableSubAgentSession {
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: {} as AgentRuntimeDependencies["router"],
      tools: {
        registry,
        scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"],
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
  };
  return new SubAgentSession(options) as unknown as TestableSubAgentSession;
}

function runtimeContext(config: AgentRuntimeConfig): PilotDeckToolRuntimeContext {
  return {
    sessionId: "child-session",
    turnId: "child-turn",
    cwd: config.cwd,
    runMode: config.runMode,
    permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  };
}

function writePilotConfig(raw: string): string {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-subagent-config-"));
  tempPilotHomes.push(pilotHome);
  writeFileSync(join(pilotHome, "pilotdeck.yaml"), raw, "utf8");
  return pilotHome;
}

function loadInlinePilotConfig(raw: string) {
  const pilotHome = writePilotConfig(raw);
  return loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
}

function pilotConfigWithSubagentDefault(defaultValue: string): string {
  return `
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    default: ${defaultValue}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`;
}

test("agent.subagents.default inherit keeps subagent model unset", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("inherit"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.default"), false);
});

test("agent.subagents.params is reported as unsupported instead of being silently discarded", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    params:
      maxOutputTokens: 4096
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal("params" in (snapshot.config.agent.subagents ?? {}), false);
  assert.deepEqual(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.params"),
    {
      code: "CONFIG_AGENT_SUBAGENTS_PARAMS_UNSUPPORTED",
      severity: "warning",
      message: "agent.subagents.params is not supported and will be ignored.",
      path: "agent.subagents.params",
      recoverable: true,
    },
  );
});

test("empty agent.subagents.params does not create a warning", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    params: {}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal(
    snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.params"),
    false,
  );
});

test("agent.subagents.default resolves a configured model", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/child-model"));

  assert.deepEqual(snapshot.config.agent.subagents?.default, {
    id: "child/child-model",
    provider: "child",
    model: "child-model",
  });
});

test("agent.subagents.default inherits with a warning when provider is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing/child-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.deepEqual(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default"),
    {
      code: "CONFIG_AGENT_SUBAGENT_PROVIDER_NOT_FOUND",
      severity: "warning",
      message: "agent.subagents.default references unknown provider missing. Inheriting agent.model instead.",
      path: "agent.subagents.default",
      recoverable: true,
    },
  );
});

test("agent.subagents.default inherits with a warning when model is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/missing-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_NOT_FOUND",
  );
});

test("agent.subagents.default inherits with a warning when malformed", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing-format"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_INVALID",
  );
});

test("agent.model still fails fast when provider is missing", () => {
  assert.throws(
    () => loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: missing/main-model
  subagents:
    default: child/child-model
model:
  providers:
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`),
    (error) =>
      error instanceof PilotConfigError &&
      error.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_AGENT_PROVIDER_NOT_FOUND"),
  );
});

test("explore subagent does not probe tool safety before execution", async () => {
  const readOnlyChecks: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createNoopTool("execute_code", (input) => {
    readOnlyChecks.push("execute_code");
    return (input as { code: string }).code.length === 0;
  }));
  registry.register(createNoopTool("read_file", () => {
    readOnlyChecks.push("read_file");
    return true;
  }));

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the provided files.",
    parentConfig: {
      provider: "test",
      model: "test-model",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: process.cwd(),
        mode: "bypassPermissions",
        canPrompt: true,
        bypassAvailable: true,
      }),
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown, FINAL_REPORT);
  assert.deepEqual(readOnlyChecks, []);
});

test("parent abort emits an aborted subagent completion event", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { events, fork } = createSubagentForkHarness(
    createBlockingRouter(() => markStarted?.()),
  );
  const controller = new AbortController();

  const running = fork.fork({
    definitionId: "explore",
    directive: "Wait until the parent stops.",
    subagentId: "subagent-aborted",
    abortSignal: controller.signal,
    timeoutMs: 60_000,
  });
  await started;
  controller.abort("parent stopped");
  await assert.rejects(running, /subagent turn aborted/);

  const completed = events.find((event) => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, true);
});

test("subagent timeout remains a failure instead of a cancellation", async () => {
  const { events, fork } = createSubagentForkHarness(createBlockingRouter());

  await assert.rejects(fork.fork({
    definitionId: "explore",
    directive: "Wait until timeout.",
    subagentId: "subagent-timeout",
    timeoutMs: 5,
  }), /Subagent timed out after 5ms/);

  const completed = events.find((event) => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, false);
});

test("subagent default turn cap returns a specific failure instead of a report", async () => {
  const attempts: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("succeed", attempts, () => undefined));
  const scripted = createScriptedToolRouter(
    Array.from({ length: 12 }, () => [{ name: "succeed", input: { command: "next" } }]),
  );
  const { events, fork } = createSubagentForkHarness(scripted.router, registry);

  await assert.rejects(fork.fork({
    definitionId: "general-purpose",
    directive: "Keep using tools.",
    subagentId: "subagent-max-turns",
    timeoutMs: 60_000,
  }), (error: unknown) => {
    assert.ok(error instanceof SubagentFailureError);
    assert.equal(error.code, "subagent_max_turns_exceeded");
    assert.match(error.message, /12-turn limit/);
    return true;
  });

  assert.equal(attempts.length, 12);
  assert.equal(scripted.requestCount(), 12);
  const completed = events.find(event => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, false);
});

test("three identical all-failed tool batches trip the no-progress fuse", async () => {
  const attempts: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("fail", attempts, () => "exit 128: same failure"));
  const scripted = createScriptedToolRouter(
    Array.from({ length: 4 }, () => [{ name: "fail", input: { command: "git status" } }]),
  );
  const { events, fork } = createSubagentForkHarness(scripted.router, registry);

  await assert.rejects(fork.fork({
    definitionId: "general-purpose",
    directive: "Retry the failing command.",
    subagentId: "subagent-no-progress",
    timeoutMs: 60_000,
  }), (error: unknown) => {
    assert.ok(error instanceof SubagentFailureError);
    assert.equal(error.code, "subagent_no_progress_loop");
    assert.match(error.message, /3 consecutive identical tool batches/);
    return true;
  });

  assert.equal(attempts.length, 3);
  assert.equal(scripted.requestCount(), 3);
  const completed = events.find(event => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, false);
});

test("a successful third retry is allowed to finish", async () => {
  const attempts: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("flaky", attempts, (_input, attempt) =>
    attempt < 3 ? "temporary failure" : undefined,
  ));
  const call = { name: "flaky", input: { command: "same retry" } };
  const scripted = createScriptedToolRouter([[call], [call], [call], []]);
  const { fork } = createSubagentForkHarness(scripted.router, registry);

  const report = await fork.fork({
    definitionId: "general-purpose",
    directive: "Retry until the transient failure clears.",
    subagentId: "subagent-retry-success",
    timeoutMs: 60_000,
  });

  assert.equal(report.markdown, FINAL_REPORT);
  assert.equal(attempts.length, 3);
  assert.equal(scripted.requestCount(), 4);
});

test("changing the call input resets the repeated-failure count", async () => {
  const attempts: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("probe", attempts, input =>
    (input as { path: string }).path === "c" ? undefined : "same failure",
  ));
  const a = { name: "probe", input: { path: "a" } };
  const b = { name: "probe", input: { path: "b" } };
  const c = { name: "probe", input: { path: "c" } };
  const scripted = createScriptedToolRouter([[a], [a], [b], [b], [c], []]);
  const { fork } = createSubagentForkHarness(scripted.router, registry);

  const report = await fork.fork({
    definitionId: "general-purpose",
    directive: "Change inputs while investigating.",
    subagentId: "subagent-changed-input",
    timeoutMs: 60_000,
  });

  assert.equal(report.markdown, FINAL_REPORT);
  assert.equal(attempts.length, 5);
});

test("changing the error resets the repeated-failure count", async () => {
  const attempts: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("probe", attempts, (_input, attempt) => {
    if (attempt <= 2) return "failure a";
    if (attempt <= 4) return "failure b";
    return undefined;
  }));
  const call = { name: "probe", input: { path: "same" } };
  const scripted = createScriptedToolRouter([[call], [call], [call], [call], [call], []]);
  const { fork } = createSubagentForkHarness(scripted.router, registry);

  const report = await fork.fork({
    definitionId: "general-purpose",
    directive: "Change the failing path while investigating.",
    subagentId: "subagent-changed-error",
    timeoutMs: 60_000,
  });

  assert.equal(report.markdown, FINAL_REPORT);
  assert.equal(attempts.length, 5);
});

test("a successful sibling prevents an all-failed batch from tripping the fuse", async () => {
  const failures: unknown[] = [];
  const successes: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(createOutcomeTool("always_fails", failures, () => "same failure"));
  registry.register(createOutcomeTool("always_succeeds", successes, () => undefined));
  const batch = [
    { name: "always_fails", input: { command: "same" } },
    { name: "always_succeeds", input: { command: "same" } },
  ];
  const scripted = createScriptedToolRouter([batch, batch, batch, []]);
  const { fork } = createSubagentForkHarness(scripted.router, registry);

  const report = await fork.fork({
    definitionId: "general-purpose",
    directive: "Run a mixed batch.",
    subagentId: "subagent-mixed-batch",
    timeoutMs: 60_000,
  });

  assert.equal(report.markdown, FINAL_REPORT);
  assert.equal(failures.length, 3);
  assert.equal(successes.length, 3);
});

test("explore registry ignores an unallowed dynamic execute_code tool without probing it", () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  registry.register(createBashTool({
    runner: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
    },
  }));

  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();

  assert.deepEqual(scoped.list().map((tool) => tool.name), ["bash"]);
  assert.equal(session.buildConfig().runMode, "ask");
});

test("subagent config uses configured default model without copying caps to top-level overrides", () => {
  const registry = new ToolRegistry();
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect the provided files.",
    parentConfig: {
      ...parentConfig(),
      provider: "main",
      model: "main-model",
      modelMultimodal: { input: ["text"] },
      maxContextTokens: 100000,
      maxOutputTokens: 20000,
      subagentModel: {
        provider: "child",
        model: "child-model",
        modelMultimodal: { input: ["text", "image"] },
        maxContextTokens: 32000,
        maxOutputTokens: 4096,
      },
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  }) as unknown as TestableSubAgentSession;

  const config = session.buildConfig();

  assert.equal(config.provider, "child");
  assert.equal(config.model, "child-model");
  assert.deepEqual(config.modelMultimodal, { input: ["text", "image"] });
  assert.equal(config.maxContextTokens, undefined);
  assert.equal(config.maxOutputTokens, undefined);
  assert.deepEqual(config.subagentModel, {
    provider: "child",
    model: "child-model",
    modelMultimodal: { input: ["text", "image"] },
    maxContextTokens: 32000,
    maxOutputTokens: 4096,
  });
  assert.equal(config.isSubagent, true);
});

test("subagent config inherits parent model when no default is configured", () => {
  const registry = new ToolRegistry();
  const session = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);

  const config = session.buildConfig();

  assert.equal(config.provider, "test");
  assert.equal(config.model, "test-model");
  assert.equal(config.isSubagent, true);
});

test("configured subagent default remains a router baseline, not a router override", async () => {
  const seen: Array<{ stage: "decide" | "execute"; provider: string; model: string; isMainAgent?: boolean }> = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request, isMainAgent }) => {
      seen.push({
        stage: "decide",
        provider: request.provider,
        model: request.model,
        isMainAgent,
      });
      return {
        provider: "routed",
        model: "tier-model",
        scenarioType: "default",
        isSubagent: true,
        orchestrating: false,
        resolvedFrom: "tokenSaver",
        mutations: {},
      };
    },
    execute: async function* (_decision, request) {
      seen.push({
        stage: "execute",
        provider: request.provider,
        model: request.model,
      });
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    ...parentConfig(),
    provider: "main",
    model: "main-model",
    subagentModel: {
      provider: "child",
      model: "child-model",
    },
  }, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {} as never,
    },
    eventEmitter: (event) => {
      events.push(event);
    },
  }) as unknown as TestableAgentLoop;
  const fork = loop.buildSubagentForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [],
  }, []);

  await fork.fork({
    definitionId: "explore",
    directive: "Inspect routing.",
    subagentId: "subagent-routed",
    timeoutMs: 60_000,
  });

  assert.deepEqual(seen, [
    {
      stage: "decide",
      provider: "child",
      model: "child-model",
      isMainAgent: false,
    },
    {
      stage: "execute",
      provider: "routed",
      model: "tier-model",
    },
  ]);
  assert.ok(events.some((event) => event.type === "subagent_completed"));
});

test("read-only subagent evaluates bash safety from the real command", async () => {
  const commands: string[] = [];
  const runner: PilotDeckCommandRunner = {
    async run(command) {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: `${command}\n`,
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  const readResult = await runtime.execute(
    { id: "read-command", name: "bash", input: { command: "pwd" } },
    runtimeContext(config),
  );
  assert.equal(readResult.type, "success");
  assert.deepEqual(commands, ["pwd"]);

  const writeResult = await runtime.execute(
    { id: "write-command", name: "bash", input: { command: "touch blocked.txt" } },
    runtimeContext(config),
  );
  assert.equal(writeResult.type, "error");
  assert.equal(writeResult.type === "error" ? writeResult.error.code : "", "ask_mode_violation");
  assert.deepEqual(commands, ["pwd"], "blocked command must not reach the shell runner");
});

test("read-only execute_code checks the real code instead of crashing on registry setup", async () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  const definition: SubagentDefinition = {
    ...SUBAGENT_DEFINITIONS.explore,
    allowedTools: ["execute_code"],
  };
  const session = sessionFor(definition, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  assert.equal(scoped.has("execute_code"), true);
  const result = await runtime.execute(
    {
      id: "write-code",
      name: "execute_code",
      input: {
        code: "from pilotdeck_tools import write_file\nwrite_file('blocked.txt', 'no')",
      },
    },
    runtimeContext(config),
  );
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : "", "ask_mode_violation");
});
