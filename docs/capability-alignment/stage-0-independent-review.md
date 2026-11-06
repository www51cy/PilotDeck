# 阶段 0 独立复核报告

- 复核日期：2026-11-06
- 复核角色：无实现上下文的新 Verification 会话
- 复核会话标识：`ad1-f7815ddb8ac639fa`
- 复核时 HEAD：`372aa38e`
- 总结论：`PASS`，仅针对阶段 0 工件包的“基线证据＋可恢复骨架”交付目的。
- 能力边界：EXE-01 仍为 `PARTIAL`；本报告不确认 A4、A5、P1、P2、U1 已闭合，也不把其他能力升级为 `PASS`。

## 独立性与实际范围

复核者未继承实现会话的对话、判断或记忆结论，实际读取了四份阶段 0 工件、指定源码与测试、两份原始测试输出及相关 Git 提交；共执行 47 次只读工具调用，并亲自重跑现有测试。复核者未编辑文件、安装依赖、启动或停止服务、提交或推送。

实际核对范围包括：

- `charter.md`、`capability-matrix.md`、`current-status.md`、`exe-01.md`。
- `ConcurrentToolScheduler.ts`、`AgentLoop.ts`、`ensureToolResultPairing.ts` 与 `tool-lifecycle.spec.ts`。
- `exe-01-baseline.tap` 与 `exe-01-bun.txt` 的路径、字节数、哈希及 Git 跟踪状态。
- 提交 `60823cef`、`5e8cafde`、`ca836f17`、`372aa38e`。
- 工作区 tracked/staged diff、EXE-01 六个相关文件和 SUB-01 五个相关文件的洁净度。
- Node、Bun、tsx 与项目声明的包管理器版本。
- SUB-01 的源码主张和两个测试文件；API-01 的 bridge 源码主张。
- A4/A5 是否已在仓库其他测试中获得直接故障注入覆盖。

## 机械核验结果

- Node TAP 为 875 字节，SHA-256 `165b2fddf8cf088d16f16f4654f738d0a1c6cc3223d22436416a588b367f3058`，与登记一致。
- Bun 输出为 80 字节，SHA-256 `978ae46aae6dfac9dbbea8a7ca1b586123fff59340e6a235efc9e649d4193eaa`，与登记一致。
- 两份证据均已 Git 跟踪，复核时无工作区修改。
- `current-status.md` 记录的 tracked diff 指纹 `a8a592142e0f7e30db63e2e5f815fb5a63b9e7f0f2cb4362948524ec34d9ee09` 与当时实测一致；staged diff 为空，其哈希为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `60823cef` 修改 6 个相关文件、`5e8cafde` 修改 5 个相关文件，文件名单与工件一致。
- `11e6ce05..372aa38e` 只包含能力对齐 docs/tmp 工件，src/tests 无差异。
- EXE-01 六个相关文件和 SUB-01 五个相关文件相对当时 HEAD 均无修改。
- 除下述半行级锚点外，工件中的源码行号均精确命中。
- Node `v22.13.0`、Bun `1.3.11`、tsx `4.22.3` 与 `pnpm@10.32.1` 声明均实测一致。
- 测试运行前后工作区状态均为 30 个条目，复核未产生文件副作用。

## 复核者独立实跑

以下结果是复核者在报告中交付的新证据；复核者没有单独保存这三次运行的原始输出，因此不得把它们伪装成已归档的 TAP/文本日志。

### EXE-01 / Node

```bash
env -C /root/pilotdeck PATH="/root/.local/share/pilotdeck-node/node-v22.13.0-linux-x64/bin:$PATH" node --import tsx --test --test-timeout=10000 tests/agent/loop/tool-lifecycle.spec.ts
```

退出码 0；3 项通过、0 失败、0 取消、0 跳过、0 todo。TAP 结构、测试名和 SQLite 警告与归档一致，仅 PID 和耗时不同。

### EXE-01 / Bun

```bash
env -C /root/pilotdeck bun test --timeout 10000 tests/agent/loop/tool-lifecycle.spec.ts
```

退出码 0；3 项通过、0 失败。版本横幅一致，仅耗时不同。仍只作辅助证据。

### SUB-01 / Node

```bash
env -C /root/pilotdeck PATH="/root/.local/share/pilotdeck-node/node-v22.13.0-linux-x64/bin:$PATH" node --import tsx --test --test-timeout=10000 tests/agent/sub/SubAgentSession.spec.ts tests/tool/builtin/agent-subagent-type.spec.ts
```

退出码 0；27/27 通过。这把矩阵中的“27 项仅为历史证据”推进为“当前工作区经独立复核实跑通过”，但不替代真实父任务和页面中止验收，SUB-01 保持 `PARTIAL`。

## 源码与覆盖判断

- `AgentLoop.ts` 的未知/重复 callId 去重、中止合成、缺失结果补配和原序返回均在源码中得到确认。
- I5 的“不发起下一次模型请求”有中止分支持久化后直接返回的结构性支撑，A2 也断言请求数为 1。
- A2 的迟到成功实际经过调度器回流并被去重守卫吞掉，构成 I3 的间接行为覆盖；但它不替代 A4 的直接故障注入。
- 全仓搜索未发现 A4/A5 的直接故障注入测试，二者保持未闭合。
- A2/A3 的“当次持久化”通过测试内 `onDurableMessage` 内存回调数组证明，没有触达真实 transcript、磁盘写入与 `captureTurn`；该缺口由 U1 继续承接。
- REC-01/CMP-01 没有认领外来未提交修改，Bun 没有替代 Node，SUB-01 没有因测试通过升级为完整能力，均未发现过度宣称。

## 复核发现与本次处置

### F1 低：源码基线锚点不是最新 HEAD

原发现：`current-status.md` 与 `charter.md` 中的 `11e6ce05` 是源码基线，复核时最新 HEAD 已为 `372aa38e`。两者之间只有 docs/tmp 变化，不影响事实正确性，但零上下文恢复者可能短暂误锚。

处置：已明确写成“源码基线锚点，非最新 HEAD”，并要求恢复时核对 `11e6ce05..HEAD` 的 src/tests 差异。不写入会自指失效的新 HEAD 哈希。

### F2 低：`onResult` 行号存在半行级偏差

原发现：`exe-01.md` 指向 `ConcurrentToolScheduler.ts:20`，实际方法签名始于该行，`onResult` 参数声明在第 23 行。

处置：锚点改为 `:20-24`，行为描述不变。

### F3 信息项：I5 持久化证据层级有限

原发现：当前自动场景只证明内存持久化回调，真实磁盘持久化仍由 U1 承接；工件没有过度宣称。

处置：在 EXE-01 覆盖矩阵后显式补充证据强度说明，U1 保持未闭合。

### F4 信息项：A4 有间接覆盖但仍未直接闭合

原发现：A2 已间接覆盖迟到结果去重，不等于正常流重复终态或返回数组重复的直接故障注入。

处置：保留间接覆盖事实，A4 状态不变，不重复计为直接场景。

### F5 信息项：历史 401 事件不属于复核者可独立证明的仓内事实

原发现：本仓没有首次 401 的独立原始工件；复核者只能确认本次通道可用并完成审查。

处置：401 仅保留为实现侧历史事件记录，不再列为当前阻断；独立复核结论以本报告和复核者实际执行范围为依据。

### F6 正向确认

未发现规格偏差、过度宣称或漏报反证。两处低优先精度项已经订正，其余信息项均已保留边界，无自动豁免。

## 未覆盖范围

- 未创建纯 HEAD 洁净 worktree，未做洁净树复现。
- 只运行三个 spec 文件共 30 项测试，没有运行全量套件。
- A4/A5、P1/P2、U1 仍开放。
- 传递依赖只抽查直接导入层，未穷举完整 import 图。
- 复核者可重放当前命令，但不能逆向证明归档 TAP 的实际产生时刻。
- 本报告后的文档结算由实现侧按上述发现完成，不涉及 src/tests 或业务行为修改。

## 结算结论

阶段 0 的工件、证据和恢复机制可交付，独立复核阻断解除。能力推进仍需按各验收卡取得对应证据；本报告不创造 A4/A5、双协议、真实页面或其他后续工作的执行授权。
