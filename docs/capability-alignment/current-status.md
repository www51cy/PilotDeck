# 当前恢复状态

最后更新：2026-11-06T15:32:32+08:00

## 当前坐标

- 阶段：阶段 0 已闭合，基线证据与可恢复工件包经独立复核判定 `PASS`。
- 当前目标：保持各能力的真实证据边界；阶段 0 的 `PASS` 不等于 EXE-01 或整个能力对齐工程完成。
- 下一步唯一动作：等待后续阶段授权；A4/A5、P1/P2、U1、SUB-01 真实任务验收及其他能力推进均不自动开始。

## 基线事实

- 源码基线锚点：`11e6ce052827e519a7193e7c442b0f4a4975f442`（`feat: verify dev endpoints after startup`），不是最新 HEAD；其后能力对齐提交仅含 docs/tmp，恢复时须核对 `11e6ce05..HEAD` 的 src/tests 差异。
- 工具生命周期修复：`60823cef`。
- 子代理有界失败修复：`5e8cafde`。
- 钉版 Node：`v22.13.0`，位于 `/root/.local/share/pilotdeck-node/node-v22.13.0-linux-x64/bin/node`。
- `package.json` 声明 `pnpm@10.32.1`；本轮基线测试不依赖 corepack。
- 记录时 tracked diff SHA-256：`a8a592142e0f7e30db63e2e5f815fb5a63b9e7f0f2cb4362948524ec34d9ee09`。
- 记录时 staged diff 为空，其 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- EXE-01 的 6 个相关文件和 SUB-01 的 5 个相关文件相对 HEAD 无修改。

## 外来工作面

工作区有其他工作线的未提交修改，涉及会话、恢复、压缩、项目路由和界面，以及未跟踪测试与其他 `tmp/` 内容。它们不是本工程产物，必须保留且不纳入本工程提交；`tmp/capability-alignment/exe-01-baseline.tap` 与 `tmp/capability-alignment/exe-01-bun.txt` 是本工程明确拥有的例外。完整当前名单以 `git status --short` 为准。

因此，本轮测试证据属于“上述源码基线加记录时工作区”的实测，不得写成纯基线的独立复现证明。EXE-01 相关文件洁净只缩小直接差异面，不消除整个运行环境的差异。

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

## 未完成与限制

- 双协议、真实页面任务、重复终态与缺失结果的直接场景尚未闭合，因此 EXE-01 不是 `PASS`。
- SUB-01 虽新增当前工作区 27/27 独立实跑证据，真实父任务和页面中止仍未验收，保持 `PARTIAL`；其他能力没有因本次复核获得完成证据。
- 首次独立复核曾在读取文件前因上游 `401 authentication_error` 失败，0 次工具调用；这只是实现侧历史事件记录。重启恢复模型继承后复核已完成，401 不再是当前阻断。
- 本地提交状态以文件底部命令和 `git status --short` 为准；本文不预写自指哈希。

## 环境与操作决策

- 直接调用 corepack 时曾落到系统 Node 20 且 pnpm 缓存缺失；不安装、不升级依赖，改用钉版 Node 和仓库现有 `tsx`。
- 不安装 Spec Kit 或 EGM；只采用工件化、独立复核和硬验收方法。
- 不改业务代码，不清理或暂存外来修改，不改写历史，不推送。
- 审查发现不得自动接受；本次 F1-F5 的修复或留账已逐项写入 `stage-0-independent-review.md`。

## 压缩后恢复顺序

1. 阅读本文件、`charter.md`、`capability-matrix.md`、`exe-01.md` 和 `stage-0-independent-review.md`。
2. 运行 `git status --short`、`git log -5 --oneline`，核对 HEAD 与外来工作面是否变化。
3. 阅读当前涉及的真实源码与测试，不以本文件代替源码。
4. 核对已有测试证据的命令、时间和适用范围。
5. 从“下一步唯一动作”继续；若事实已变化，先更新本文件再执行。

## 本工程提交定位

运行 `git log -1 --format='%H %s' -- docs/capability-alignment` 查询最新工件提交；不在文件内预写会造成自指的提交哈希。原始基线日志随本工程按精确路径提交，其他 `tmp/` 内容不属于本工程。
