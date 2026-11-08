import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  MicroCompactionEngine,
  TokenAccountingRuntime,
} from "../src/context/index.js";
import type { CanonicalMessage } from "../src/model/index.js";
import { createModelRuntime } from "../src/model/index.js";
import { loadPilotConfig } from "../src/pilot/index.js";

const projectRoot = "/root/pilotdeck";
const snapshot = loadPilotConfig({ projectRoot });
const selected = snapshot.config.agent.model;
const modelRuntime = createModelRuntime(snapshot.config.model);
const capabilities = modelRuntime.getCapabilities(selected.provider, selected.model);
const maxContextTokens = snapshot.config.agent.maxContextTokens ?? capabilities.maxContextTokens;
const maxOutputTokens = snapshot.config.agent.maxOutputTokens ?? capabilities.maxOutputTokens;
const accounting = new TokenAccountingRuntime({ modelConfig: snapshot.config.model });
const micro = new MicroCompactionEngine({
  protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
});
const candidates = execFileSync("rg", ["--files", "src", "tests"], {
  cwd: projectRoot,
  encoding: "utf8",
}).split("\n").filter((path) => path.endsWith(".ts")).sort();
const sourcePool: Array<{ relativePath: string; content: string }> = [];
for (const relativePath of candidates) {
  const content = readFileSync(resolve(projectRoot, relativePath), "utf8");
  if (content.length >= 4_000) sourcePool.push({ relativePath, content });
  if (sourcePool.length >= 12) break;
}
assert.ok(sourcePool.length > 0);
const finalInstruction = "The repository inspection is complete. Confirm completion in one short sentence and do not call any tools.";
const messages: CanonicalMessage[] = [{
  role: "user",
  content: [{ type: "text", text: "Inspect the PilotDeck context, compaction, agent loop, transcript, and model code paths, preserving concrete findings for a final status response." }],
}];
console.log(JSON.stringify({ maxContextTokens, maxOutputTokens, sourcePool: sourcePool.length }));
for (let sourceFiles = 1; sourceFiles <= 360; sourceFiles += 1) {
  const { relativePath, content } = sourcePool[(sourceFiles - 1) % sourcePool.length]!;
  const toolCallId = `real-read-${sourceFiles}`;
  messages.push(
    { role: "assistant", content: [{ type: "tool_call", id: toolCallId, name: "read_file", input: { path: relativePath } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId, content: [{ type: "text", text: content.slice(0, 24_000) }] }] },
  );
  if (sourceFiles % 5 !== 0 || (sourceFiles % 20 !== 0 && sourceFiles < 240)) continue;
  const projectedMessages = micro.apply({
    messages: [...messages, { role: "user", content: [{ type: "text", text: finalInstruction }] }],
    trimToTokens: 768,
  }).messages;
  const projected = await accounting.evaluateRequestBudget({
    provider: selected.provider,
    model: selected.model,
    messages: projectedMessages,
    maxOutputTokens,
    stream: true,
  }, { maxContextTokens, reservedOutputTokens: maxOutputTokens });
  console.log(JSON.stringify({ sourceFiles, tokens: projected.tokens, ratio: projected.ratio }));
  if (projected.ratio >= 0.96) break;
}
