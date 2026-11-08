import type { AgentTranscriptEntry } from "./TranscriptEntry.js";

/**
 * Terminal state derived from persisted transcript evidence.
 *
 * `incomplete` means that a conversational turn has started or produced
 * durable output but has no turn_result. It is a normal crash/interruption
 * state, not evidence that the transcript is corrupt.
 */
export type AgentTurnTermination = "completed" | "aborted" | "failed" | "incomplete";

/**
 * Derive conversational turn termination from entries in replay order.
 * Control, metadata, status, and artifact records do not create turns.
 */
export function deriveAgentTurnTerminations(
  entries: readonly AgentTranscriptEntry[],
): ReadonlyMap<string, AgentTurnTermination> {
  const terminations = new Map<string, AgentTurnTermination>();

  for (const entry of entries) {
    if (entry.type === "turn_result") {
      terminations.set(entry.turnId, terminationFromResult(entry.result));
      continue;
    }

    const startsOrContinuesTurn = entry.type === "accepted_input" ||
      ((entry.type === "assistant_message" ||
        entry.type === "tool_result_message" ||
        entry.type === "durable_message") && entry.message.metadata?.compactReplacement !== true);
    if (startsOrContinuesTurn && !terminations.has(entry.turnId)) {
      terminations.set(entry.turnId, "incomplete");
    }
  }

  return terminations;
}

function terminationFromResult(
  result: Extract<AgentTranscriptEntry, { type: "turn_result" }>["result"],
): Exclude<AgentTurnTermination, "incomplete"> {
  switch (result.type) {
    case "success":
      return "completed";
    case "aborted":
      return "aborted";
    case "error":
    case "max_turns":
      return "failed";
  }
}
