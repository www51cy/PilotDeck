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

function toolCalls(...ids: string[]): CanonicalMessage {
  return {
    role: "assistant",
    content: ids.map(id => ({ type: "tool_call", id, name: "tool", input: {} })),
  };
}

function toolResult(id: string): CanonicalMessage {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: id,
      content: [{ type: "text", text: `result of ${id}` }],
    }],
  };
}

function userText(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
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

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
  assert.deepEqual(result.messages[1]?.content.map(block => block.type), ["tool_result", "text"]);
  assert.deepEqual(result.messages[1]?.content[1], input[1]?.content[0]);
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

test("merges a missing parallel call result into the partial first response", () => {
  const input = [
    toolCalls("c1", "c2"),
    toolResult("c1"),
    userText("intervening"),
    assistantText("next"),
  ];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
  const response = result.messages[1]!;
  assert.deepEqual(response.content.map(block =>
    block.type === "tool_result" ? block.toolCallId : block.type
  ), ["c1", "c2", "text"]);
  assert.deepEqual(response.content[2], { type: "text", text: "intervening" });
  const placeholder = response.content[1];
  if (placeholder?.type === "tool_result") {
    assert.deepEqual(placeholder.content, [{ type: "text", text: "[result truncated]" }]);
  }
  assert.deepEqual(result.warnings.map(warning => warning.code), ["tool_result_injected"]);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});

test("keeps a delayed parallel result in the first response and ahead of text", () => {
  const input = [
    toolCalls("c1", "c2"),
    toolResult("c1"),
    userText("intervening"),
    toolResult("c2"),
    assistantText("next"),
  ];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
  const response = result.messages[1]!;
  assert.deepEqual(response.content.map(block =>
    block.type === "tool_result" ? block.toolCallId : block.type
  ), ["c1", "c2", "text"]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});

test("patches a missing parallel result when the next assistant arrives immediately", () => {
  const input = [toolCalls("c1", "c2"), toolResult("c1"), assistantText("next")];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
  const response = result.messages[1]!;
  assert.deepEqual(response.content.map(block =>
    block.type === "tool_result" ? block.toolCallId : block.type
  ), ["c1", "c2"]);
  assert.deepEqual(result.warnings.map(warning => warning.code), ["tool_result_injected"]);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});

test("pairs an end-of-history interrupted call before a resumed user prompt", () => {
  const input = [
    userText("original request"),
    toolCalls("interrupted-call"),
    userText("continue after restart"),
  ];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(result.messages[2]?.content.map(block => block.type), ["tool_result", "text"]);
  assert.deepEqual(result.messages[2]?.content[1], { type: "text", text: "continue after restart" });
  assert.deepEqual(result.messages[2]?.content[0], {
    type: "tool_result",
    toolCallId: "interrupted-call",
    content: [{ type: "text", text: "[result truncated]" }],
  });
  assert.deepEqual(result.warnings.map(warning => warning.code), ["tool_result_injected"]);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});

test("drops orphaned durable tool results without discarding surrounding text", () => {
  const orphan: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "missing-call",
        content: [{ type: "text", text: "orphan output" }],
      },
      { type: "text", text: "keep this durable note" },
    ],
  };
  const orphanOnly = toolResult("also-missing");
  const input = [orphan, orphanOnly, userText("next prompt")];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages, [userText("keep this durable note"), userText("next prompt")]);
  assert.deepEqual(result.warnings.map(warning => warning.code), ["tool_result_orphaned", "tool_result_orphaned"]);
  assert.match(JSON.stringify(input), /orphan output/, "projection must not mutate replayed history");
});

test("hoists a delayed result above leading text without reversing user text", () => {
  const delayed: CanonicalMessage = {
    role: "user",
    content: [
      { type: "text", text: "second note" },
      {
        type: "tool_result",
        toolCallId: "c1",
        content: [{ type: "text", text: "result of c1" }],
      },
    ],
  };
  const input = [toolCalls("c1"), userText("first"), delayed, assistantText("next")];

  const result = new MessageProjector().project({ messages: input });

  assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
  const response = result.messages[1]!;
  assert.deepEqual(response.content.map(block => block.type), ["tool_result", "text", "text"]);
  assert.deepEqual(response.content.slice(1), [
    { type: "text", text: "first" },
    { type: "text", text: "second note" },
  ]);
  assert.deepEqual(new MessageProjector().project({ messages: result.messages }).messages, result.messages);
});
