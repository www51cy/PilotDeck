# 当前恢复状态

最后更新：2026-11-07

## 当前坐标

- 阶段：阶段 0 已闭合；当前接续主线为长会话页面与 Token 双链治理，二者分别验收，不互相冒充。
- 页面链：`45cfe46d fix: bound long-session history rendering` 已形成本地提交；真实 4286 条消息会话首屏仅取尾窗 100 条，向上游标分页取 20 条成功，模型池可打开。该证据不等于全部页面性能场景或生产部署验收完成。
- Token 链：`6ef4411f fix(context): make long-session compaction reliable` 已形成本地提交；三份冻结测试 13/13、最终两轮真实 Provider 验收及零上下文 delta 复核均通过，CMP-01 由 `UNVERIFIED` 调整为 `PARTIAL`。
- 隔离复测：`6ef4411f` 的独立 detached worktree 构建成功，三份冻结测试源码直跑与构建后 dist 均为 13/13；报告为 `tmp/compaction-final-isolated-source-results.xml` 和 `tmp/compaction-final-isolated-dist-results.xml`。
- 下一步唯一动作：本轮收工并保留外来工作面；若继续，须另选压缩中取消、跨进程真实恢复、其他 Provider、熔断状态跨进程持久化或旧相邻红盘处置中的具体对象，不把当前 `PARTIAL` 自动升级为完整能力通过。

## 长会话 Token 链当前证据

- 预注册规格、旧实现基线、夹具修正、最终冻结测试和真实验收记录统一见 `tmp/compaction-prereg-evidence.md`；三份冻结测试哈希保持不变，最终 XML 为 13 通过、0 失败。
- 最终真实报告为 `tmp/pilotdeck-real-compaction-e2e-aCEXGv/real-compaction-report.json`：270 个真实仓库工具结果，原始历史 ratio 3.315543，micro 后 0.978703；两次摘要均成功，两轮实际 Provider 输入为 85369 与 85439，均低于 targetTokens 137625。
- 原始 transcript 的 3382822 字节前缀 SHA-256 在压缩前后保持 `d2bc111a9ce9b3252a0be532ae2e134f46ff8617e704b7e483f84756e8fa14ef`；最终 transcript 为 7580901 字节。该结论只证明种子落盘后的原始前缀 append-only。
- 第二轮合并前一份 rolling summary，最终 replay 使用持久化快照，replacementMessages=482，活跃态只有一个 compact boundary 消息和一个 wrapped summary。独立最终 delta verdict=`PASS`，阻断发现为零。
- 相邻旧套件仍有按旧预期失败的用例及 Node runner 超时，不能写成全套通过或已证明产品死循环；契约冲突和 runner 异常分别保留边界。
- `AgentLoop.ts` 的持久化静默 catch 继续挂账为可观测性缺口；本轮实际落盘和 replay 成功，没有数据丢失证据，也不表示该缺口已修。

## 基线事实

- 阶段 0 源码基线锚点：`11e6ce052827e519a7193e7c442b0f4a4975f442`（`feat: verify dev endpoints after startup`），不是最新 HEAD；截至该次记录时，其后能力对齐提交仅含 docs/tmp。当前长会话源码以 `45cfe46d` 与 `6ef4411f` 为准，恢复时仍须核对实际 src/tests 差异。
- 工具生命周期修复：`60823cef`。
- 子代理有界失败修复：`5e8cafde`。
- 钉版 Node：`v22.13.0`，位于 `/root/.local/share/pilotdeck-node/node-v22.13.0-linux-x64/bin/node`。
- `package.json` 声明 `pnpm@10.32.1`；本轮基线测试不依赖 corepack。
- 记录时 tracked diff SHA-256：`a8a592142e0f7e30db63e2e5f815fb5a63b9e7f0f2cb4362948524ec34d9ee09`。
- 记录时 staged diff 为空，其 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- EXE-01 的 6 个相关文件和 SUB-01 的 5 个相关文件相对 HEAD 无修改。

## 外来工作面

工作区仍有其他工作线的未提交修改，涉及不完整轮次恢复、项目路由和界面，以及未跟踪测试与其他 `tmp/` 内容。它们不是本轮压缩主线产物，必须保留且不纳入压缩提交；压缩相关修改已由 `6ef4411f` 精确承接。完整当前名单以 `git status --short` 为准。

上述阶段 0 基线测试证据属于“源码基线加记录时工作区”的实测，不得写成纯基线的独立复现证明。EXE-01 相关文件洁净只缩小直接差异面，不消除整个运行环境的差异；本轮压缩提交则另有上述隔离树复测证据。

## 已完成

- 建立 `charter.md`，固定初衷、目标、状态语义、方法和授权边界。
- 建立 `capability-matrix.md`，登记当前事实与未验证面。
- 建立 `exe-01.md`，冻结 EXE-01 的不变量、已有覆盖和完整验收缺口。
- 核对两个修复提交的实际文件范围及 EXE-01 关键源码路径。
- 2026-11-06T13:47:30+08:00 至 13:47:32+08:00，使用 Node `v22.13.0`、`tsx 4.22.3` 复测 EXE-01：3 项通过、0 失败、0 取消、0 跳过，退出码 0。
- 原始输出：`tmp/capability-alignment/exe-01-baseline.tap`，875 字节，SHA-256 `165b2fddf8cf088d16f16f4654f738d0a1c6cc3223d22436416a588b367f3058`。
- EXE-01 已从 `UNVERIFIED` 调整为 `PARTIAL`，只确认 A1-A3 当前基线通过。
- 2026-11-06T14:49:21+08:00 至 14:49:22+08:00，Bun `1.3.11` 对拍同一 EXE-01 文件：3 项通过、0 失败、退出码 0。原始输出 `tmp/capability-alignment/exe-01-bun.txt`，80 字节，SHA-256 `978ae46aae6dfac9dbbea8a7ca1b586123fff59340e6a235efc9e649d4193eaa`；仅作辅助证据，不替代 Node 生产基线。
- 2026-11-06，无实现上下文的 Verification 新会话完成独立复核，阶段 0 工件包判定 `PASS`；报告与逐项处置见 `stage-0-independent-review.md`。
- 复核者独立重跑 EXE-01 的 Node/Bun 场景，均各 3/3 通过；另实跑 SUB-01 两个 spec，27/27 通过。三次实跑未单独归档原始输出，不得写成已有原始日志。
- 两项低级文档精度发现已订正；持久化证据层级、A4 间接覆盖与历史 401 的可证性均按报告保留边界，没有自动豁免。
- 2026-11-06，完成 AUTO-01 当前源码与真实服务对照：Claude 无头最小任务、结构化流式结果、轮次失败退出码和跨进程恢复均已实跑；18789 的最小任务、结构化事件、RPC/任务错误和同进程重连恢复也已实跑。
- AUTO-01 调整为 `PARTIAL`，报告见 `auto-01.md`，原始与派生工件见 `tmp/capability-alignment/auto-01-*`，校验清单为 `auto-01-artifacts.sha256`。运行记录时 PilotDeck HEAD 为 `0017523904c46c72ec55ed61bc8cc95129964667`，工作区含外来修改，结论不伪装成纯 HEAD 复现。
- AUTO-01 限定工件包已完成零上下文独立复核；三项非阻断发现修正后，独立 delta 复核判定 `PASS`，无新增阻断或非阻断发现。这仅闭合工件与限定事实的一致性，AUTO-01 本体仍为 `PARTIAL`。

## 未完成与限制

- 双协议、真实页面任务、重复终态与缺失结果的直接场景尚未闭合，因此 EXE-01 不是 `PASS`。
- SUB-01 虽新增当前工作区 27/27 独立实跑证据，真实父任务和页面中止仍未验收，保持 `PARTIAL`；其他能力没有因本次复核获得完成证据。
- 首次独立复核曾在读取文件前因上游 `401 authentication_error` 失败，0 次工具调用；这只是实现侧历史事件记录。重启恢复模型继承后复核已完成，401 不再是当前阻断。
- AUTO-01 未覆盖正式自动测试、PilotDeck 服务重启、取消与超时；其恢复证据只限同一常驻服务内的新 WS 客户端重连，不能升级为 REC-01。
- 本地提交状态以文件底部命令和 `git status --short` 为准；本文不预写自指哈希。

## 环境与操作决策

- 直接调用 corepack 时曾落到系统 Node 20 且 pnpm 缓存缺失；不安装、不升级依赖，改用钉版 Node 和仓库现有 `tsx`。
- 不安装 Spec Kit 或 EGM；只采用工件化、独立复核和硬验收方法。
- 不改业务代码，不清理或暂存外来修改，不改写历史，不推送。
- 审查发现不得自动接受；本次 F1-F5 的修复或留账已逐项写入 `stage-0-independent-review.md`。

## 压缩后恢复顺序

1. 阅读本文件、`charter.md`、`capability-matrix.md`、`exe-01.md`、`auto-01.md` 和 `stage-0-independent-review.md`；长会话 Token 链另读 `tmp/compaction-reliability-prereg.md` 与 `tmp/compaction-prereg-evidence.md`。
2. 运行 `git status --short`、`git log -5 --oneline`，核对 HEAD 与外来工作面是否变化。
3. 阅读当前涉及的真实源码与测试，不以本文件代替源码。
4. 核对已有测试证据的命令、时间和适用范围。
5. 从“下一步唯一动作”继续；若事实已变化，先更新本文件再执行。

## 本工程提交定位

运行 `git log -1 --format='%H %s' -- docs/capability-alignment` 查询最新工件提交；不在文件内预写会造成自指的提交哈希。原始基线日志随本工程按精确路径提交，其他 `tmp/` 内容不属于本工程。
