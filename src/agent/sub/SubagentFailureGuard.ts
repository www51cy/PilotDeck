import type { CanonicalToolCall } from "../../model/index.js";
import type { PilotDeckToolResult } from "../../tool/protocol/result.js";
import type { AgentEvent } from "../protocol/events.js";
import { stableStringify } from "../../pilot/config/hash.js";

export type SubagentFailureCode =
  | "subagent_no_progress_loop"
  | "subagent_max_turns_exceeded";

export class SubagentFailureError extends Error {
  constructor(readonly code: SubagentFailureCode, message: string) {
    super(message);
    this.name = "SubagentFailureError";
  }
}

const MAX_IDENTICAL_FAILED_BATCHES = 3;

/** Stops only consecutive, completely failed batches with identical calls and errors. */
export class SubagentFailureGuard {
  private pendingCalls: CanonicalToolCall[] = [];
  private readonly pendingResults = new Map<string, PilotDeckToolResult>();
  private previousFingerprint?: string;
  private repeatedBatches = 0;

  observe(event: AgentEvent): SubagentFailureError | undefined {
    if (event.type === "tool_calls_detected") {
      this.pendingCalls = event.calls;
      this.pendingResults.clear();
      return undefined;
    }
    if (event.type !== "tool_result" || this.pendingCalls.length === 0) {
      return undefined;
    }

    this.pendingResults.set(event.result.toolCallId, event.result);
    if (this.pendingResults.size < this.pendingCalls.length) return undefined;

    const calls = this.pendingCalls;
    const results = calls.map(call => this.pendingResults.get(call.id)!);
    const fingerprint = stableStringify(calls.map((call, index) => {
      const result = results[index]!;
      return {
        toolName: call.name,
        input: call.input,
        errorCode: result.type === "error" ? result.error.code : "success",
        errorMessage: result.type === "error" ? result.error.message : "",
      };
    }));
    this.pendingCalls = [];
    this.pendingResults.clear();

    if (results.some(result => result.type === "success")) {
      this.reset();
      return undefined;
    }

    this.repeatedBatches = fingerprint === this.previousFingerprint
      ? this.repeatedBatches + 1
      : 1;
    this.previousFingerprint = fingerprint;
    if (this.repeatedBatches < MAX_IDENTICAL_FAILED_BATCHES) return undefined;

    const toolNames = [...new Set(results.map(result => result.toolName))].join(", ");
    return new SubagentFailureError(
      "subagent_no_progress_loop",
      `Subagent stopped after ${MAX_IDENTICAL_FAILED_BATCHES} consecutive identical tool batches with no successful result. Failing tools: ${toolNames}. Change the command, inputs, or approach before retrying.`,
    );
  }

  private reset(): void {
    this.previousFingerprint = undefined;
    this.repeatedBatches = 0;
  }
}
