import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";

export type PilotDeckToolScheduler = {
  /** onResult fires as each call finishes; the returned array retains call order. */
  executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
    onResult?: (result: PilotDeckToolResult) => void,
  ): Promise<PilotDeckToolResult[]>;
};
