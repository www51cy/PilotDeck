# 压缩可靠性测试预注册 v1

日期：2026-11-07
基线提交：`213abbaa2db0c67e71d4f76300f8ec68a15fa559`
状态：规格冻结；测试字节哈希与基线结果另存，不在本文件事后补写。

## 初衷与证据边界

根治长会话反复发送大上下文的问题，而不是通过删除原始 transcript、另开会话或伪造摘要成功掩盖失败。当前工作区已有未验收候选实现和随实现改过的测试，它们全部退出本轮证据链。本轮先用独立测试文件固定契约，在隔离的基线源码上证明关键用例失败，再记录测试 SHA-256；此后才允许修改实现。

自动测试只证明所列机制契约。真实模型 Token 回落、原始 transcript 哈希不变和真实长会话验收仍须另行执行，不能由本预注册替代。

## 冻结测试文件

1. `tests/context/compaction-reliability.prereg.spec.ts`
2. `tests/context/auto-compaction-reliability.prereg.spec.ts`
3. `tests/session/emergency-compaction-persistence.prereg.spec.ts`

测试使用 Node test、真实 `TokenBudgetManager` 和可控模型 stub；不使用网络、不接触用户 transcript。

## B1：首次摘要请求总输入硬预算

场景：同一组明显超长的工作消息，分别执行一次不带 `effectiveContextTokens` 的摘要和一次 `effectiveContextTokens=4000`、摘要输出上限 500 的摘要。

非空真前置：先用真实 tokenizer 计算未限预算请求的 `systemPrompt + messages`，断言总输入严格大于 3500 tokens；若此断言失败，该用例是空真，证据作废。

预期：限预算请求成功且只调用模型一次；同一 tokenizer 计算的总输入不超过 3500；摘要结果无错误。预算包含系统提示、历史消息和末尾控制消息，不得只计算历史消息。

基线：未限预算前置应通过，限预算断言应失败。

## R1：输出 length 的有界递减重试

场景：模型连续三次返回文本但 `finishReason="length"`；`effectiveContextTokens=20000`。

预期：恰好三次请求；实际总输入逐次严格减小；第一次输出上限大于第二次，第二、三次均为 1536；重试系统提示保留核心 `Objective`，移除完整提示的 `Completed` 章节要求；耗尽后返回截断错误、`summaryGenerated=false` 且无 `summaryMessage`，不得接受截断文本。

基线：只请求一次，应失败。

## R2：provider prompt_too_long 的递减恢复

场景：模型前两次返回 `prompt_too_long` 错误事件，第三次返回完整 stop 摘要；`effectiveContextTokens=20000`。

预期：恰好三次请求，实际总输入逐次严格减小，第三次摘要成功且生成摘要消息。普通非超窗后端错误不在本用例中重试。

基线：第一次错误后即终止，应失败。

## F1：连续失败熔断与单半开探针

场景：注入可控时钟。普通摘要后端错误发生后推进 61 秒再执行下一次，累计三次完整 run 失败。随后在熔断期内发起 auto；推进 300001 毫秒后同时发起两个 auto，让首个半开探针暂停，再释放并成功；成功后立即再执行一次 auto。

预期：前三次各只调用模型一次；熔断期内零新调用；半开只有一个真实模型请求，并发调用返回“探针进行中”错误；探针成功后熔断与失败计数清零，下一次 auto 可正常调用。

基线：旧实现使用真实时钟且没有熔断，累计调用数不符合，应失败。

## F2：manual 人工恢复出口

场景：按 F1 方法形成三次连续 auto 失败，不等待五分钟，立即执行 manual，模型此次成功。

预期：manual 绕过自动熔断并实际调用模型，返回成功摘要。

基线：旧冷却或缺少熔断语义使调用序列不符合，应失败。

## C1：首次失败后的 60 秒冷却仍有效

场景：可控时钟下第一次普通后端失败；推进 59999 毫秒执行第二次，再推进 2 毫秒执行第三次。

预期：第二次不调用模型且仍处于冷却；第三次实际调用模型。总模型调用数为 2，防止熔断机制误删既有短冷却。

基线：旧实现使用真实时钟，第三次仍被冷却，应失败。

## T1：80% warning 触发 full summary

场景：无 micro 时初始为 16000/20000（80%），摘要成功后预算为 4000/20000。

预期：调用摘要模型一次，返回 full compaction 和真实摘要，不进入 emergency。

基线：旧实现等到 90% 才摘要，应返回 skipped，测试失败。

## T2：micro 降到 80% 以下可收尾

场景：初始 17200/20000，micro 后出现既有压缩标记并为 15200/20000（76%）。

预期：返回 micro compaction，摘要模型调用数为零。该用例是防回归红线和基线正对照，基线也应通过。

## E1：摘要失败后的真实硬截断结果

场景：auto 与 reactive 摘要均失败，初始预算为 1900/2000（95%），硬截断后预算为 100/2000。输入包含旧任务和最新请求。

预期：返回 compacted；`result` 保持 `undefined`，不得生成摘要或 `<compact-boundary>`；活跃消息移除旧任务并保留最新请求；原输入数组不被修改；返回显式 `emergencyTruncation={preTokens:1900, postTokens:100}`。该字段只陈述真实发生的头部硬截断，不表示摘要成功。

基线：消息可截断但没有 `emergencyTruncation`，应失败。

## E2：AgentLoop 发出真实 emergency 快照

场景：context stub 返回无摘要 `result`、带 `emergencyTruncation` 的 compacted 结果，AgentLoop 完成当前模型轮次。

预期：`onCompactPersisted` 恰好一次；边界为 `kind="compact", subtype="emergency_truncate"`；元数据记录真实 pre/post、`summaryGenerated=false`、`messagesSummarized=0`；快照消息为截断后的活跃消息并带 `compactReplacement` 标记；不得写成 `compact_boundary`。

基线：没有 `compact.result` 时直接返回，回调次数为零，应失败。

## E3：TurnRunner/Writer 落盘并 flush

场景：TurnRunner 的 loop stub 调用 E2 形式的 `onCompactPersisted`；使用真实 JSONL writer，并观察真实 FileHandle.sync。

预期：当前 turn 完成前，JSONL 同时保留原始 `accepted_input` 与完整 `control_boundary`；subtype 为 `emergency_truncate`，snapshot.version=1；sync 恰好一次；replay 得到截断快照而不是原始活跃上下文。

基线：TurnRunner 丢弃该 subtype，缺边界且 sync 为零，应失败。

## E4：Replay 完整性与原始档案保留

场景：构造原始 accepted input、完整 emergency snapshot 和后续输入；另构造缺失 snapshot、空 messages 和错误 version 的 emergency 边界。

预期：只有完整 emergency snapshot 替换活跃上下文并保留后续输入；无效边界保守回退到原始历史，且不得覆盖此前的有效快照；原始 entry 仍存在于 entries 数组，replay 只是活跃分支投影。

基线：完整 emergency snapshot 不被识别，应失败；无效快照回退是基线正对照。

## 允许与禁止的测试变更

- 三个新文件在哈希冻结前只允许修复语法、导入和夹具可达性；任何预期变化都必须作废对应基线证据并重新执行整轮基线。
- 哈希冻结后不得随实现调整输入、阈值、调用次数或断言。发现规格错误只能登记新一轮预注册并重新证明旧实现失败。
- `tests/context/compaction-engine.spec.ts` 与 `tests/context/autoCompaction.spec.ts` 中尚未验收的候选改动恢复到基线字节；相关有效需求由上述独立冻结测试承载，不将此前绿色结果算作证据。
- 不允许删除“失败摘要不得生成假 compact boundary”“原始 transcript 保留”“无效快照不得隐藏历史”“工具调用/结果配对”等既有红线。
- 测试若在任何实现上因空夹具而恒通过，不计为支持证据。

## 冻结与验收顺序

1. 隔离展开基线提交，复用同一 Node 22.13 与依赖，不复制当前候选源码。
2. 将三个测试文件原样放入基线树，运行并保存逐用例结果；B1 非空真前置和 T2/无效快照正对照必须通过，标红用例须按上述原因失败。
3. 对三个测试文件记录 SHA-256；哈希后字节保持不变。
4. 回到工作树后才允许按规格修改实现。现有候选代码只作实验材料，不倒推测试预期。
5. 实现后运行冻结测试、恢复的既有相邻测试、typecheck/build；再进行真实模型与真实长会话验收、独立复核。
