# AUTO-01：Claude Code 无头模式与 PilotDeck 18789 对照

最后更新：2026-11-06T17:22:48+08:00

## 结论与状态

**AUTO-01：`PARTIAL`。**

限定范围内的真实对照已经完成：两侧均跑通最小非交互任务、流式结果、结构化结果、错误路径和会话继续。限定工件包已完成零上下文独立复核及修正差异复核，三项非阻断发现均闭合；但本轮没有完成可重复自动测试入库、PilotDeck 服务重启恢复、取消与超时闭环，也没有验收所有旁路接口，因此不能记为 `PASS`。

核心判断：

- Claude Code 更像“一次调用交一份机器结果”：最终 `result`、结构化字段和进程退出码在同一调用链上，脚本接入直接。
- PilotDeck 更像“常驻任务服务”：WebSocket 事件更丰富，适合多客户端、重连、取消和长期会话；但 RPC 错误、任务错误、轮次耗尽与流结束分散在不同帧和事件里，机器调用方必须自行组装终态。
- 应借鉴 Claude 的结果契约，不应把常驻服务硬改成“一次任务退出一个进程”。

## 范围与基线

- Claude 源码：`/root/instructkr-claude-code`，HEAD `2768dd4b4e00c379420cddaf7a1c262cdaed928c`。
- PilotDeck：`/root/pilotdeck`，记录时 HEAD `0017523904c46c72ec55ed61bc8cc95129964667`。
- PilotDeck 工作区存在其他工作线的未提交修改。其中已核对的 `src/cli/createLocalGateway.ts` 差异是在会话消息读取处补充活动轮次标识，与模型选择无关；这些修改均不纳入本报告证据所有权。本报告的静态结论属于当前工作区；运行态结论属于实测时的 18789 进程，不能笼统归因于上述 HEAD。
- PilotDeck 使用钉版 Node `v22.13.0` 和仓库现有 `tsx`；Claude 使用当前源码的 `bun run start`。
- 只新增或更新 `docs/capability-alignment` 与 `tmp/capability-alignment` 工件，没有修改业务源码或正式测试。
- 原始输出与派生记录的 SHA-256 见 `tmp/capability-alignment/auto-01-artifacts.sha256`。

## 实测矩阵

| 能力 | Claude Code 实测 | PilotDeck 18789 实测 |
|---|---|---|
| 宿主形态 | 每次 `-p` 启动一个进程，结束退出 | 常驻 HTTP/WebSocket 服务；单轮没有进程退出语义 |
| 最小任务 | 无工具提示返回 `OK`，`is_error:false`，退出码 0 | 独立 `test` 会话返回 `PILOT_OK`，产生 `turn_completed`，无错误事件 |
| 流式事件 | `stream-json --verbose` 产生 system、assistant、user、result 共 7 份 JSON 事件 | `submit_turn` 产生输入、模型、增量文本、工具、状态和完成事件；帧带 `id/seq/final` |
| 结构化结果 | `--json-schema` 最终结果含 `structured_output:{status:"OK"}` | 模型调用结构化工具后产生 `structured_output` 事件，载荷为 `{status:"PILOT_STRUCTURED_OK"}` |
| 任务失败 | 达到轮次上限产生 `error_max_turns`、`is_error:true`，进程退出码 1 | 不存在的模型产生 `error` 事件，代码 `gateway_submit_failed`，没有真实 `turn_completed` |
| RPC 失败 | 命令参数错误走进程错误与退出码 | 未知方法返回独立错误响应，`code:gateway_request_failed` |
| 轮次耗尽 | 最终结果就是错误结果 | 有界结构化实测产生 `turn_completed.finishReason:"max_turns"`，没有额外 `error` 事件 |
| 会话继续 | 新的 CLI 进程用 `--resume <session-id>` 恢复，能回答上一轮的 `RESUMED` | 新 WebSocket 客户端调用 `resume_session` 后在同一常驻服务中继续，能回答上一轮的 `PILOT_OK` |
| 鉴权 | 当前分支由既有 CLI/API 环境提供 | 本机 `/auth/local-token` 取令牌，WS hello 校验；服务只绑定 localhost |
| 取消与超时 | 源码有参数和控制链，本轮未做中止故障注入 | 源码有 `abort_turn`、`timeoutMs` 和断连 abort，本轮未做中止故障注入 |

## 关键事实

### 1. Claude 最终结果与退出码直接对应

- `src/cli/print.ts:840-974` 负责文本、JSON 和流式 JSON 输出。
- `src/cli/print.ts:971-973` 按最终 `result.is_error` 选择退出码 1 或 0。
- `src/QueryEngine.ts:1070-1155` 定义成功与执行错误结果字段。
- `src/cli/print.ts:787-793` 要求 `stream-json` 与 `--verbose` 同用。

实测工件：

- `auto-01-claude-headless.json`：普通最小任务成功。
- `auto-01-claude-stream.jsonl`：流式事件和结构化结果成功。
- `auto-01-claude-max-turns.json`：`error_max_turns`，对应进程退出码 1。
- `auto-01-claude-resume.json`、`auto-01-claude-resume-context.json`：指定会话恢复及上文依赖性回答成功。

**当前分支特有问题：** 上述标准输出还混入启动调试日志。流式实测有 40 行非 JSON 启动日志（含空行），来源包括 `src/main.tsx:13`、`src/entrypoints/init.ts:58-246`。因此当前分支不能把整个 stdout 直接交给 JSON/JSONL 解析器；最后一行结果本身仍是合法 JSON。这一发现不外推为官方发行版的普遍行为。

### 2. PilotDeck 的 WS 流结束不等于业务成功

- `src/gateway/server/GatewayServer.ts:40-77` 默认提供 18789 和 `/ws`。
- `src/gateway/server/GatewayWsConnection.ts:65-87` 校验 hello、协议版本和令牌。
- `src/gateway/server/GatewayWsConnection.ts:91-118` 逐条发送事件，最后发送 `final:true`。
- 最后这个 `final:true` 是服务端合成的流结束标记；没有真实 `turn_completed` 时，`finishReason` 会缺省写成 `completed`。
- `src/web/client/GatewayBrowserClient.ts:385-400` 会丢弃合成标记的载荷，只关闭事件流。

因此：

- 不能只看 `final:true` 或它附带的 `finishReason:"completed"` 判定任务成功。
- 浏览器客户端消费者要根据非 final 的 `error`、真实 `turn_completed` 和流异常共同收口。
- 不存在的模型实测只观察到 `agent_status`、`error`，随后流关闭，没有真实 `turn_completed`；这与正常完成是不同的可观察形状。

### 3. PilotDeck 的结构化工具不会天然结束普通主会话

- `src/tool/builtin/structuredOutput.ts` 把结构化结果实现为工具。
- `src/gateway/client/InProcessGateway.ts:2487-2493` 在最终结果含 `structuredOutput` 时依次映射 `structured_output` 与 `turn_completed`。
- `src/agent/loop/AgentLoop.ts:1936-1951` 只有 `stopOnStructuredOutput` 开启时才在结构化结果后立即结束。

两次实测分开登记：

1. **无轮次上限的一次观察**：客户端 90 秒先超时；持久化 transcript 显示模型连续调用结构化工具 13 次（限本 `turnId`，按唯一 `toolCallId` 去重），共 14 个 agent turn，服务端约 155 秒后最终以 `completed` 结束并取得目标结构。派生记录为 `auto-01-pilotdeck-structured-unbounded.json`。这是一次观察，不能推定每次都会重复相同次数，也不能据此判定断连 abort 是否失效。
2. **全新会话、`maxTurns:1` 的有界复验**：实际收到 `structured_output`，随后收到 `turn_completed.finishReason:"max_turns"`，没有 `error` 事件。原始记录为 `auto-01-pilotdeck-structured.json`。

所以“拿到了结构化载荷”与“任务成功完成”是两个判断；调用方还必须检查 `finishReason`，并给自动任务设置轮次或时间边界。

### 4. 会话恢复证据强度不同

- Claude 的两次恢复调用都是新的 OS 进程，证明指定会话可跨 CLI 进程继续。
- PilotDeck 的证明仅是新的 WS 客户端重连到同一常驻服务后继续；没有停止或重启 18789，因此不能升级为 REC-01 的服务重启恢复证据。

### 5. PilotDeck CLI 不是等价的结果出口

`src/adapters/channel/cli/CliChannel.ts:67-83` 只渲染事件；`cli-render.ts` 把结构化和错误渲染成文本。该路径没有按任务 `error` 或 `finishReason` 设置进程退出码的逻辑。本轮未独立实跑 CLI 全场景，故不写成“所有失败恒为 0”的实测结论；已确认的是：**18789 服务本身没有单任务退出码，现有 CLI 也没有暴露与 Claude 等价的机器终态契约。**

## 独立复核

- 首轮零上下文 Verification 判定 `PARTIAL`、无 `BLOCKER`，指出工具调用计数、客户端退出码证据和外来修改定性三项非阻断发现。
- 三项发现及行号精度建议已逐项修正；独立 delta 复核判定 `PASS`，按本 `turnId` 内唯一 `toolCallId` 重算为 13 次，18/18 工件哈希匹配，无新增阻断或非阻断发现。
- delta 复核另指出“只新增文档”措辞未覆盖既有文档更新，已改为“只新增或更新”；该复核仅证明工件与限定事实一致，不消除下述能力缺口，也不把 AUTO-01 升级为 `PASS`。

## 主要缺口

1. **统一机器终态缺口**：成功、任务错误、RPC 错误、轮次耗尽和流结束需要调用方分别理解，尚无单一最终结果对象。
2. **自动测试缺口**：本轮探针可重复运行，但尚未固化为正式 `node:test`；现有测试没有覆盖本次真实 18789 + 真实模型链。
3. **CLI 自动化缺口**：没有等价的结构化 stdout 和成功/失败退出码映射。
4. **结构化调用边界缺口**：没有在本次 WS 请求契约中验证类似 `--json-schema` 的直接选项；结构化工具本身不保证立即结束主循环。
5. **恢复与中止缺口**：PilotDeck 服务重启、异常终止、取消、超时和迟到事件未在本轮验收。
6. **覆盖范围缺口**：8642 OpenAI 兼容面、8643 Webhook、双协议与真实页面不属于本次实跑结论。

## 后续建议（未授权实施）

优先统一机器可消费的终态与错误语义，再把本次成功、错误、轮次耗尽和重连场景固化成真实 WS 自动测试，最后补 CLI 退出码及结构化输出选项。不要先复制 Claude 的命令外观，也不要用合成 `final:true` 代替业务终态。
