# 实时同步架构审计：原生 WebSocket 与 Socket.IO

日期：2026-11-07  
状态：代码审计完成；单次界面事故未完成运行时因果复现  
范围：浏览器 ↔ 3001、3001 ↔ 18789、活动回合快照、timeline、模型请求生命周期、后台恢复与多客户端订阅。

## 1. 结论

推荐保留原生 WebSocket，先建设权威快照、统一事件版本、恢复协调器和模型请求状态机。Socket.IO 可以减少心跳、重连和短期断线恢复的自建成本，但不能替代业务状态同步，也不能补出模型请求生命周期。

本审计不推荐把“迁移 Socket.IO”作为当前故障的根因修复。只有运维或多节点需求证明收益后，才应把 Socket.IO 作为传输层替换另案评估。

## 2. 事实、推论与未验证项

- **FACT**：下文由代码、测试或官方文档直接支持。
- **INFERRED**：由代码时序推导出的风险，尚不能当作某次事故的运行时根因。
- **未验证**：需要真实浏览器、网络故障注入或运行日志才能结算。

## 3. 现有可复用机制

| 能力 | 证据 | 审计结论 |
| --- | --- | --- |
| 回合内内容排序 | `src/agent/stream/TurnTimeline.ts:10-19,37-40,66-85` | **FACT**：已有 `order/revision/offset`，但不覆盖所有普通事件。 |
| 内容去重与 gap 检测 | `ui/src/stores/sessionTimeline.ts:55-115` | **FACT**：客户端能检测内容块、前驱和 offset 缺口。 |
| 活动回合绝对内容投影 | `src/gateway/stream/ActiveTimeline.ts:3-37` | **FACT**：保留当前完整内容块，不是单纯增量日志。 |
| 活动回合回放 | `src/gateway/client/InProcessGateway.ts:988-1007` | **FACT**：普通事件与 timeline 投影共同组成快照。 |
| 状态查询防旧回包 | `ui/src/components/chat/sessionStatusProtocol.ts:67-96` | **FACT**：约束查询之间的新旧，不是全局事件序号。 |
| 3001 本地回合防旧快照 | `ui/server/pilotdeck-bridge.js:702-751` | **FACT**：有序列和 `activityRevision` 守卫及测试。 |
| 多浏览器独立订阅 | `ui/server/session-watch-registry.js:1-65` | **FACT**：每个客户端独立登记、取消与清理。 |
| 广播及单客户端退出 | `ui/server/index.js:235-264,2674-2689` | **FACT**：没有发现互抢订阅或退出时移除其他客户端的机制。 |
| 状态查询触发排队输入 | `ui/server/pilotdeck-bridge.js:2010-2022,2626-2640` | **FACT**：查询有副作用，但 `queueDispatching` 防重入。 |

现有 timeline 契约另见 `docs/architecture/session-timeline.md`。本审计不要求重造该协议。

## 4. 已确认缺口

### 4.1 模型请求生命周期不完整

`model_request_started` 在每次模型循环前发出（`src/agent/loop/AgentLoop.ts:550-556`），协议只有 started，没有请求级 ID 和正常结束事件（`src/agent/protocol/events.ts:18`）。

模型 `message_end` 会映射成 `assistant_stream_end`（`src/gateway/client/InProcessGateway.ts:2397-2413`），但前端 `stream_end` 只关闭 timeline，不清除 `model_request_started`（`useChatRealtimeHandlers.ts:745-755`）。普通状态主要由整回合 `complete` 或 inactive 快照清除（同文件 `:683-694,971-994`）。`clear_status` 分支存在，但仓库中没有生产端发出点。

UI 又优先把该状态显示为“调用模型中”（`MessagesPaneV2.tsx:1621-1637`）。

**FACT：协议允许正文或工具已经产出，工作状态仍为 `model_request_started`。这解释了视觉错序的一类机制，但不是单次事故唯一根因的证明。**

### 4.2 页面恢复触发面不足

浏览器每 30 秒发送应用层 `ping`（`WebSocketContext.tsx:128-132`），服务端直接返回、不发送 ACK（`ui/server/index.js:2408`）。只有 `close` 后才重连（`WebSocketContext.tsx:172-185`），重连后刷新历史与活动快照（`ChatInterfaceV2.tsx:380-408`）。

聊天恢复链没有统一监听 `visibilitychange/focus/online/pageshow`。因此，页面冻结但没有发生 `close` 时，恢复可见不会自动进入聊天对账；当前 ping 也没有 ACK 超时来判定应用层半开。

页面冻结期间无法继续更新 UI。实际可靠性目标只能是恢复执行后自动收敛。

### 4.3 普通事件与快照没有统一版本

`statusRequestId` 只能防旧查询覆盖新查询。收到 `started` 或 `complete` 会作废在途查询（`useChatRealtimeHandlers.ts:971-976,1134-1138`），所以不能笼统声称旧快照会复活已结束回合。

普通状态帧、工具状态和快照之间没有共同会话序号。`recordActiveTurnEvent` 先于 `queue.enqueue` 是有价值的防护，但不等于客户端可消费的 `snapshotThroughSeq`。

**INFERRED：快照捕获后，如果新的非终态状态帧先应用，旧快照随后回放，旧普通状态仍可能覆盖新状态。当前事故日志没有证明这一交错实际发生。**

### 4.4 截断信号未进入 UI 恢复协议

普通活动事件缓存上限为 500 条／256KB，溢出设置 `truncated`（`InProcessGateway.ts:1459-1475`）。3001 返回浏览器时只转换 `activeTurnMessages`，没有传递或消费该字段（`pilotdeck-bridge.js:2642-2649`）。

客户端因此不能区分完整活动快照和普通事件前缀已丢失的不完整回放。

### 4.5 上游是另一套独立协议

3001 → 18789 使用自定义 `hello/request/response/event`：

- submit stream 已生成 `seq`：`GatewayWsConnection.ts:89-140`；
- 客户端没有检查该 `seq`：`GatewayWsClient.ts:210-220`；
- 断链使 pending 请求和流失败：`GatewayWsClient.ts:224-233`；
- 无头服务会中止该连接上的在途回合：`GatewayWsConnection.ts:22-32`。

只迁移浏览器到 3001 的传输，不会改变这些行为。

## 5. 快照、序号与其他机制的边界

### 带版本的权威快照可以解决

- 后台页面重新可见、F5 和正常重连后的状态对账；
- 当前正文、思考和工具的最新绝对投影；
- 当前权限请求、令牌预算、活动 run 与执行阶段；
- 回合结束后的持久化历史对齐；
- 重复快照和重复幂等内容的安全合并；
- 增量缓存不足后的最终回退。

### 必须增加序号和 gap 检测才能解决

- 页面一直可见且 WebSocket 未关闭时发现静默漏帧；
- 判断正文、普通状态、工具、权限和 complete 的跨类型先后；
- 从 `lastAppliedSeq` 精确补发；
- 非幂等通知或副作用的可靠去重；
- 判断缓存能否覆盖缺口，不能覆盖时明确回退。

### 两者都不能单独解决

- 半开连接检测：还需要 heartbeat ACK 和超时；
- 模型请求状态错误：还需要请求级状态机；
- 无头进程崩溃后的执行续跑：属于持久化执行问题；
- 严格一次副作用：需要命令 ID、幂等和消费去重。

## 6. Socket.IO 对照

| 方案 | 能解决 | 不能解决 | 成本与适用条件 |
| --- | --- | --- | --- |
| 原生 WS＋业务可靠性协议 | 完全控制序号、快照、回放、恢复和幂等；复用现有 timeline | 心跳、重连、恢复协调器需自己维护 | 当前推荐，改动集中于协议和恢复链。 |
| 只迁浏览器 ↔ 3001 | 内置心跳、自动重连、ACK/超时、短期 Connection State Recovery | 不解决模型状态、权威快照和业务序号；18789 仍是自定义协议 | 中等；适合明确需要其运维能力或多节点时。 |
| 两条链路全部迁移 | 两条链路统一使用成熟传输机制 | 仍不能自动恢复业务状态或保证执行不中断 | 高；牵涉所有 Gateway 客户端及断线即 abort 语义。 |

Socket.IO 官方边界：

1. Connection State Recovery 需要显式启用，并使用有界 `maxDisconnectionDuration`；官方明确说明恢复不总成功，仍需状态同步。
2. 默认情况下，断线期间服务端事件没有通用补发保证。
3. `retries + ackTimeout` 可构建至少一次投递，但必须处理重复和幂等。
4. heartbeat/ACK 不等于业务状态已同步。
5. 多节点通常涉及 sticky session、adapter 和代理超时；不能假设所有 adapter 都支持恢复。
6. `skipMiddlewares` 涉及恢复连接时是否重新执行鉴权的安全取舍。

只迁浏览器链路至少需要处理 `WebSocketContext.tsx`、`ui/server/index.js`、`useSessionWatch.ts`、`vite.config.js`、WebSocket mock 与 Playwright `routeWebSocket` 用例。`/shell`、`/plugin-ws` 和 TaskMaster 可暂时保留原生 WS；18789 全栈无需改动。

## 7. 推荐改造顺序

1. 冻结协议不变量与对抗测试。
2. 实现模型请求状态机、版本化权威快照和统一恢复协调器。
3. 先以全量快照处理 gap，达到最终一致。
4. 确有性能或精确补发需求，再增加 Replay。
5. Socket.IO 仅作为后续可替换传输层评估，业务协议保持传输无关。

## 8. 回归测试矩阵

| 场景 | 必须通过的判据 |
| --- | --- |
| 同一回合两次模型请求＋工具 | 旧请求正文不能清除新请求状态；只有真实新请求显示“调用模型中”。 |
| 正文、工具、权限、压缩交错 | 当前 phase 不被旧普通 status 覆盖。 |
| 运行中 F5 | 活动快照恢复一次，内容不重复，phase 与权威快照一致。 |
| 完成后 F5 | 从持久化历史恢复，不复活活动状态。 |
| 后台冻结后 visible，WS 未 close | 自动对账到最新快照，不依赖手动刷新。 |
| 半开连接，无 close、无 ACK | 在限定超时内判死、重连并恢复快照。 |
| ACK 正常但漏一帧 | heartbeat 不掩盖 seq gap，仍触发恢复。 |
| 漏 100 帧，缓存足够 | 完整方案按序补齐且每帧只应用一次。 |
| 漏帧缓存不足 | 明确回退全量快照，不无限 replay、不假装补齐。 |
| 快照 N 与实时 N+1 反序到达 | 旧快照不得覆盖新状态。 |
| 快照与实时缓冲重复 | `throughSeq` 以下只应用一次。 |
| epoch 改变、seq 重置 | 客户端立即全量对账，不等待不存在的旧序号。 |
| 普通事件缓存 truncated | 客户端识别不完整快照并走全量恢复。 |
| 两浏览器看同一会话 | 收到相同事件序号，各自维护 `lastAppliedSeq`。 |
| 一个浏览器关闭或 unwatch | 另一个持续接收，不被移除订阅。 |
| 一个前台、一个长期后台 | 后台恢复后，两者权威投影一致。 |
| 两浏览器并发状态查询且有排队输入 | 只 dispatch 一次，不产生两个 accepted turn。 |
| 3001 ↔ 18789 断链 | UI 不永久停留在调用态，按实际终态或 unknown 收敛。 |
| 无头服务重启 | 不使用旧 epoch 回放；执行是否可恢复按明确产品语义验证。 |
| Socket.IO ACK 重试 | 非幂等提交不因自动缓冲或重试重复执行。 |

测试分三层：Vitest reducer/协议测试、真实 3001 WebSocket 集成测试、真实浏览器双页面/冻结/半开注入测试。jsdom 的 `visibilitychange` 只能验证监听逻辑，不能证明真实浏览器冻结恢复。

## 9. 官方资料

- [Socket.IO Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery)
- [Socket.IO Delivery Guarantees](https://socket.io/docs/v4/delivery-guarantees)
- [Socket.IO Server Options](https://socket.io/docs/v4/server-options)
- [Socket.IO Using Multiple Nodes](https://socket.io/docs/v4/using-multiple-nodes)
