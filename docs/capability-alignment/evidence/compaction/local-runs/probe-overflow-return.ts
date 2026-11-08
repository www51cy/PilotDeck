import { DefaultContextRuntime } from "../src/context/DefaultContextRuntime.js";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../src/context/compaction/CompactionEngine.js";
import type { CanonicalMessage } from "../src/model/index.js";

const tokenBudget = new TokenBudgetManager();
let summaryCalls = 0;
const engine = new CompactionEngine({
  provider: "test",
  model_: "test-model",
  tokenBudget,
  model: {
    async *stream() {
      summaryCalls += 1;
      yield { type: "text_delta", text: "## Objective\nKeep the current request." };
    },
  },
});
const runtime = new DefaultContextRuntime({
  tokenBudget,
  autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
  compactionEngine: engine,
  maxContextTokens: 100,
});
const messages = Array.from({ length: 20 }, (_, index): CanonicalMessage => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: [{ type: "text", text: `turn-${index}` }],
}));
const result = await runtime.tryAutoCompact({
  messages,
  budgetEvaluator: () => Promise.resolve(tokenBudget.snapshotFromTokens(120, 100)),
});
console.log("returned", { type: result.type, summaryCalls });
