# 压缩可靠性预注册证据

日期：2026-11-07
基线：`213abbaa2db0c67e71d4f76300f8ec68a15fa559`
Node：`v22.13.0`

## 最终冻结 SHA-256

- `tests/context/compaction-reliability.prereg.spec.ts`
  `0f667715bfc7096439b4cf41dad9523fd3918e6da164925fc98c3bae9ae8abd6`
- `tests/context/auto-compaction-reliability.prereg.spec.ts`
  `6111ec68fed773e4a2e2c0388a1cf2fff63fbf33c1257ce6ec59acad15fa1dc4`
- `tests/session/emergency-compaction-persistence.prereg.spec.ts`
  `cc56db1638c3081d174347f6df7a20af0136b98a62b639499e78e7686d4a3717`

主工作树与隔离基线树中的三份文件逐一同哈希。哈希冻结后不得随实现修改这些文件；如必须变更，整轮预注册与基线失败证据重新执行。

## 最终旧实现基线

报告：`tmp/compaction-baseline-results.xml`
执行目录：`tmp/compaction-prereg-baseline`，源码来自上述基线提交，复用主树 `node_modules`，没有复制候选实现。

共 13 项：11 项按规格失败，2 项正对照通过。

- FAIL：B1、R1、R2、F1、F2、C1、T1、E1、E2、E3、E4。
- PASS：T2（micro 从 17200/20000 降至 15200/20000，摘要调用零次）。
- PASS：E4-control（缺失、错误版本和空消息 emergency snapshot 均保留原始历史）。

关键非空真与失败原因：

- B1：同一夹具的未限预算请求实测 4287 tokens，严格大于 3500；旧实现限预算请求仍为 4287，预算断言失败。
- R1/R2：旧实现只调用摘要模型一次，未发生递减重试。
- F1/F2/C1：旧实现使用真实时钟，模型调用数分别为 1 而非规格要求的序列。
- T1：旧实现在 80% warning 返回 skipped。
- E1：旧实现可硬截断，但没有 `emergencyTruncation` 事实记录。
- E2：旧实现没有 `compact.result` 时不调用持久化回调。
- E3：旧 TurnRunner 丢弃 emergency subtype，未完成快照与 sync。
- E4：旧 Replay 不识别完整 emergency snapshot，回退到原始活跃历史。

## 作废与夹具修正记录

首轮报告保留为 `tmp/compaction-baseline-results.invalid-fixtures.xml`。发现两个夹具问题：AgentLoop 会向共享消息数组追加助手消息；T2 的文本判据没有读取工具结果内部文本。首轮受影响的持久化与 T2 证据作废。修复为每次生成独立截断消息、通过序列化候选检测 micro 标记，没有改任何预期。

第二轮报告保留为 `tmp/compaction-baseline-results.before-positive-control.xml`。11 个目标失败与 T2 通过已成立，但无效快照正对照跟在 E4 首个失败断言之后，没有独立结果。新增 `E4-control` 让该既有预期单独执行，再完成最终第三轮；未改变阈值、输入预算、调用次数或目标结果。

## 候选代码隔离

冻结前候选实现与旧测试改动已保存为：
`tmp/compaction-candidate-before-prereg.patch`
SHA-256：`49c6654f260df26109e0230113a82e21252cff418eccd7c6a21edbe004e06a7d`

该补丁只用于避免丢失未提交实验工作，不是验收证据。后续实现只能按冻结规格修正，不得反向调整冻结测试。

## 候选实现与相邻旧契约裁决

三份冻结测试保持上述 SHA-256，候选实现最终 13/13 通过。输出截断重试在后续输入已无法严格递减时停止，并保留最初的 `truncated at the token limit` 原因；旧错误文本回归与冻结 R1 均单独通过。

相邻旧套件 `compaction-engine.spec.ts` 与 `autoCompaction.spec.ts` 共 40 项，最终 27 项通过、13 项仍按旧预期失败。逐项对拍后，这些失败均不是放松冻结契约的理由：

- 12 项使用 1 或 100 Token 的总上下文，却要求实际调用摘要模型；这与 B1 的“system prompt、历史与末尾控制消息必须共同装进摘要输入预算”不可同时满足。其中一项另要求 micro 在 84% 直接结束，与 T1 的 80% 触发 full summary 冲突。
- `emergency compaction reports an explicit overflow...` 同时要求至少两次摘要调用和无成功摘要时仍存在 `result.diagnostics`；前者受小预算阻断，后者与 E1 的“真实硬截断不得伪造摘要检查点”冲突。
- 保留全部旧断言，没有通过改夹具、删断言或绕开预算把它们调绿。

上述 overflow 用例在 Node 测试运行器记录失败时会出现子进程 100% CPU 且不退出；独立探针执行同一产品调用可正常返回并自然退出，实测 `summaryCalls=0`、`type=compacted`、overflow 错误正确。故该现象登记为测试运行器异常，不能写成产品压缩死循环。相关日志为 `tmp/compaction-adjacent-final.log`、`tmp/auto-compaction-six-conflicts.log` 与 `tmp/probe-overflow-return.ts`。

## 2026-11-07 接续复跑

- 三份冻结测试的 SHA-256 与上述最终冻结值逐一相同；Node 22.13.0 源码直跑和构建后的 `dist` 均为 13/13 通过。核心构建与 UI 构建通过。
- `message-projector.spec.ts`、`transcript-replay-compaction.spec.ts` 与 `compact-snapshot-crash.spec.ts` 合计 18/18 通过，覆盖工具配对、完整快照恢复、无效快照保守回退、落盘与 fsync。
- 相邻旧套件复跑仍非全绿；`compaction-engine.spec.ts` 保持 6 项旧预期失败，`autoCompaction.spec.ts` 在 Node 测试运行器内触发 60 秒超时。该结果不能写成旧套件通过，也不能仅凭超时判成产品死循环；冲突契约与运行器问题由独立复核另行结算。
- 真实模型 E2E 第一次接续运行未进入任何模型调用：历史构造在 240 个工具结果后仅达到有效预算的 0.858，低于脚本冻结的 0.96 进入门限，因 `buildRealRepositoryHistory` 断言退出。原始输出为 `tmp/real-compaction-e2e-rerun.log`。本轮证据无效，不记为产品压缩失败；不得通过降低 0.96 门限取得通过，须修正历史构造使非空真前置实际成立后重跑。

## 终版冻结证据与独立复核 delta

- 独立复核指出旧 `compaction-candidate-frozen-results.xml` 早于两处最终源码字节，不能单独证明终版。已按当前最终实现重新执行三份冻结测试并归档 `tmp/compaction-candidate-final-frozen-results.xml`：13 项通过、0 失败，XML SHA-256 `4d0fa2d1d1b7a481cb94880350e1aa0aec0aa8e2b2e1e79287a07ce6cad00bbf`，生成时间晚于全部承重源码。
- 终版复跑时三份冻结测试哈希仍逐一等于本文件第 7–16 节的冻结值。独立复核要求的原始 transcript 前缀哈希、两轮真实 Provider 输入 Token 硬上限和非空真断言已加入 E2E；其最终执行结果另记，不以先前成功报告冒充新增断言已经运行。

## 真实 E2E 历史构造修正

- 独立无模型探针 `tmp/probe-real-compaction-history.ts` 复用真实配置、真实仓库源码、同一 `MicroCompactionEngine` 与 `TokenAccountingRuntime`，输出保存为 `tmp/probe-real-compaction-history.log`。探针与日志 SHA-256 分别为 `5efc6481934ebd0d4f0331d460ad8651b33062544f9e9ced2a2be1f22ed131bd`、`3ace5c80ebf45413070b4b536ddf1ad2ad43ba74c2190326c02e96c1e8b0ff82`。
- 实测 240 个工具结果时为 196757 tokens、ratio 0.857792；265 个为 218434、0.952297；270 个为 224491、0.978703，首次超过 0.96 后探针停止。原失败是历史构造上限过低，不是投影渐近无法触发，也没有调用模型。
- `run-real-compaction.ts` 仅把构造上限从 240 调整为 320；达到 0.96 仍立即停止，768-token micro 投影、最近四条完整工具结果、模型参数和全部后续验收断言均未改变。钉版 Node 22.13.0 构建通过；真实两轮重跑输出另存 `tmp/real-compaction-e2e-after-history-fix.log`，不得覆盖第一次无效证据。
- 修正后真实 E2E 完成全部断言：270 个真实仓库工具结果，原始历史 760506 tokens，micro 后 224491、ratio 0.978703。两次真实摘要调用均成功；第一次 postTokens 72649，第二次 preTokens 297180、postTokens 72694，最终校准快照 85447，低于 targetTokens 137625。第二次摘要请求包含 `<previous-rolling-summary>` 与完整替换指令，第二个边界 `checkpointMerged=true`；最终仅一个 compact boundary 消息和一个 wrapped summary，replay 使用持久化快照，真实 Agent 返回最终文本。
- 报告为 `tmp/pilotdeck-real-compaction-e2e-yeEANi/real-compaction-report.json`，transcript 为同目录 `projects/root-pilotdeck/chats/real-compaction-1794019753611.jsonl`。直接解析 transcript 得 14 条记录、2 个 compact boundary，快照各 482 条消息；最初 `real-read-1` 和最后 `real-read-270` 原始工具记录仍在，未以快照覆盖原始历史。
- 报告、transcript、完整运行日志 SHA-256 分别为 `47cbd68369147c70409a492430f899a46b669085ef564b3b80983174c5ea7b07`、`7ca4e1a0b10db48413dba941dd926a758a5086d46c7428a64818e0c31acfb740`、`07ae133cf14f23a3c57767a4bdd5f064c67e92ba1d7e5b376df2631883cd0e1e`。此结果闭合本脚本的两轮真实压缩与恢复路径，不外推为压缩中取消、所有 Provider 或全部 CMP-01 场景通过。

## 新增硬断言最终真实重跑与独立 delta 复核

- 最终运行使用钉版 Node 22.13.0 的绝对路径执行新构建的 `dist/tests/agent/e2e/run-real-compaction.js`。日志无 `AssertionError`，报告正常写出；三份冻结测试 SHA-256 仍逐一等于第 7–16 节冻结值，最终 XML 保持 13/13。
- 报告为 `tmp/pilotdeck-real-compaction-e2e-aCEXGv/real-compaction-report.json`，transcript 为同目录 `projects/root-pilotdeck/chats/real-compaction-1794020954210.jsonl`，完整日志为 `tmp/real-compaction-e2e-final.log`。三者 SHA-256 分别为 `b24becdbda85ce9a00b5ac0c8c634ba4fe684c59b8df28e5e265903e4b3c09ef`、`3d4b9756af3a0f9a336b72565be77b2d48cbf63c64ac981010f385563697196b`、`466923b67fe34fa95bcd06364382625dc17b9539a53604fc1aefc3149e5f5f74`。
- 非空真与 Token 硬上限均实际通过：原始历史 760506 tokens、ratio 3.315543；micro 后 224491、ratio 0.978703，严格下降且达到 0.96 进入门限。两轮真实 Provider usage 非空，实际输入分别为 85369、85439，均严格小于 targetTokens 137625；transcript 两个 `turn_result` 的 usage 与之逐值一致。
- 原始 transcript 前缀为 3382822 字节，独立截取最终 transcript 的同一前缀复算 SHA-256 为 `d2bc111a9ce9b3252a0be532ae2e134f46ff8617e704b7e483f84756e8fa14ef`，与压缩前捕获值一致；最终文件 7580901 字节。该事实只证明种子落盘后的原始前缀 append-only，不冒充全部历史语义审查。
- 两次摘要均成功；第二轮 `checkpointMerged=true`，合并前一份 rolling summary 的执行件断言已随本轮运行通过。独立复核用产品编译件从磁盘重放，14 条记录无诊断，最后快照被选中，replayMessages=483、compactReplacement=482，活跃态仅一个 compact boundary 消息和一个 wrapped summary，最终文本为 `The second repository inspection is complete.`。两条 compact 控制边界记录不等于两个活跃 boundary 消息。
- 零上下文 Verification 最终 delta  verdict=`PASS`，阻断发现为零；最终真实 E2E 可进入精确提交与隔离复测。CMP-01 仍只能登记为 `PARTIAL`：本轮仅覆盖 volc_ark/ark-code-latest、同进程 syntheticMessages 重灌和已执行场景，不证明跨进程真实恢复、压缩中取消、其他 Provider 或熔断状态跨进程持久化。
- 非阻断发现逐项结算：①摘要提示词原文不落盘，`<previous-rolling-summary>` 的证据类型是执行件断言加跑通，保留该证据边界，不改写成可事后逐字重放；②`AgentLoop.ts` 的持久化静默 catch 继续挂账为可观测性缺口，本轮两条边界实际落盘且 replay 可读，没有数据丢失证据，也未宣称该挂账已修；③最终日志本身不打印 Node 版本，实际启动命令的钉版绝对路径作为运行时证据，不复用复核者另一 PATH 的探测结果；④终轮三工件哈希原先未入账，已在本节补齐。

## 本地提交与隔离复测

- 压缩实现、三份冻结测试、E2E 脚本和主要证据已按精确路径及 hunk 本地提交为 `6ef4411f10b8f6c393d5dfbf6ac495d1faf418d0`。`TranscriptEntry.ts` 只纳入 emergency snapshot 与 micro 联合类型两个压缩改动，`transcript_turn_incomplete` 和 `turnId` 诊断仍属外来恢复线；项目区、Web 不完整轮次及其他未提交修改均未纳入。
- 从该提交创建独立 detached worktree `tmp/compaction-final-isolated`，复用主树 `node_modules`，`src` 与 `tests` 相对提交无差异。第一次构建在隔离树没有 Cua 驱动时停在 GitHub 下载，未进入 TypeScript 主构建；随后复制主树已由 manifest 校验的 0.34.1 驱动并重跑构建成功，不降低任何构建或测试判据。
- 钉版 Node 22.13.0 下，三份冻结测试源码直跑与构建后 dist 均为 13/13 通过、0 失败。报告分别为 `tmp/compaction-final-isolated-source-results.xml` 与 `tmp/compaction-final-isolated-dist-results.xml`，SHA-256 分别为 `eba728230e0465273b2828ae329a5b7ddd398362e49009275f694de5288f904a`、`9e58568ca7f17118ce76183333f5e63d6aa4ee6724d0251e4e4de14a1b292a93`；成功构建日志为 `tmp/compaction-final-isolated-build-reuse.log`，SHA-256 为 `6763a98387f6a3c0ee7ab160aae9b01e936907eeb35e97727ab9b7b14f25d385`。
- 隔离树中的三份冻结测试哈希仍逐一等于最终冻结值。该复测证明实际提交内容可独立构建并通过冻结契约，不重复发起真实模型请求，也不改变前述 CMP-01 `PARTIAL` 射程。
