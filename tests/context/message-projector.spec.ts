import test from "node:test";
import assert from "node:assert/strict";

import { MessageProjector } from "../../src/context/projection/MessageProjector.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function interruptedToolExchange(id: string, userText: string): CanonicalMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "ask_user_question", input: {} }],
    },
    { role: "user", content: [{ type: "text", text: userText }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: id,
        content: [{ type: "text", text: "answer recorded" }],
      }],
    },
  ];
}

test("moves delayed tool results ahead of intervening user text without losing either", () => {
  const projector = new MessageProjector();
  const input: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    ...interruptedToolExchange("call-1", "first clarification"),
    { role: "assistant", content: [{ type: "text", text: "continue" }] },
    ...interruptedToolExchange("call-2", "second clarification"),
    { role: "user", content: [{ type: "text", text: "latest request" }] },
  ];

  const result = projector.project({ messages: input });

  assert.equal(result.messages.length, 7);
  for (const [index, id, text] of [[2, "call-1", "first clarification"], [5, "call-2", "second clarification"]] as const) {
    const message = result.messages[index];
    assert.equal(message?.role, "user");
    assert.deepEqual(message.content.map(block => block.type), ["tool_result", "text"]);
    assert.equal(message.content[0]?.type, "tool_result");
    if (message.content[0]?.type === "tool_result") assert.equal(message.content[0].toolCallId, id);
    assert.deepEqual(message.content[1], { type: "text", text });
  }
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(projector.project({ messages: result.messages }).messages, result.messages);
});

test("injects a missing tool result before intervening user text", () => {
  const input: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "missing-call", name: "ask_user_question", input: {} }],
    },
    { role: "user", content: [{ type: "text", text: "clarification" }] },
    { role: "assistant", content: [{ type: "text", text: "continue" }] },
  ];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "user", "assistant"]);
  assert.deepEqual(result.messages[1]?.content.map(block => block.type), ["tool_result"]);
  assert.deepEqual(result.messages[2], input[1]);
  assert.deepEqual(result.warnings.map(warning => warning.code), ["tool_result_injected"]);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});

test("keeps an ordinary user message after a tool-free assistant message unchanged", () => {
  const input: CanonicalMessage[] = [
    { role: "assistant", content: [{ type: "text", text: "What next?" }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages, input);
});
