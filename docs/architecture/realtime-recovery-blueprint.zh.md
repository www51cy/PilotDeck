# 实时恢复架构图纸：版本化快照优先

日期：2026-11-07  
状态：实施设计；不是完成记录  
上游审计：`docs/architecture/realtime-sync-audit.zh.md`  
既有内容协议：`docs/architecture/session-timeline.md`

## 1. 设计目标

允许浏览器客户端随时掉线、冻结、刷新或漏消息；在客户端重新获得执行机会后，自动收敛到服务端当前真实状态。

本设计把四个问题分开：

1. **链路是否活着**：heartbeat ACK 与超时；
2. **客户端是否缺状态**：会话执行序号与 gap；
3. **当前真实状态是什么**：权威快照与持久化历史；
4. **界面正在做什么**：模型请求、工具、权限、压缩和回合的状态机。

不迁移 Socket.IO，不替换既有 timeline，不承诺无头进程崩溃后的执行续跑。

## 2. 当前拓扑

```text
浏览器 A ─┐
          ├─ 原生 WS /ws ─ 3001 ─ 一条共享 Gateway WS ─ 18789
浏览器 B ─┘                     │                         │
                                │                         ├─ AgentLoop
                                │                         ├─ ActiveTimeline
                                │                         └─ activeTurnReplays
                                │
                                ├─ watcher Set
                                ├─ input queue / queueDispatching
                                └─ snapshot RPC / live broadcast
```

多浏览器各自维护恢复进度。 watcher 只决定向谁广播，不是权威状态来源。3001 的共享上游断线与单个浏览器断线是两类故障，不得混用恢复语义。

## 3. 目标拓扑

```text
                     恢复触发源
       reconnect / visible / pageshow / online / heartbeat / gap
                                  │
                                  ▼
                     每会话 RecoveryCoordinator
                       单在途 · 作废旧代 · 防重入
                                  │
                       全量快照或增量 replay
                                  │
                                  ▼
┌──────────────────── 权威执行事件流 ────────────────────┐
│ epoch + sessionId + runId + seq + event               │
│ 同一分配点 → active snapshot / replay log / broadcast │
└────────────────────────────────────────────────────────┘
             │                              │
             ▼                              ▼
      版本化 SessionSnapshot           浏览器有序 reducer
      phase / activeRunId             epoch 检查 · seq 去重
      throughSeq / timeline           gap 检测 · 原子应用
      pending interactions            历史与实时 reconciliation
      queueRevision / tokenBudget
```

## 4. 协议坐标

### 4.1 不复用 timeline.order 作为全局序号

既有 `timeline.order/revision/offset` 继续负责内容块身份、排序与去重。新增执行事件坐标：

```ts
type ExecutionCursor = {
  epoch: string;
  sessionId: string;
  seq: number;
};

type ExecutionEnvelope = ExecutionCursor & {
  runId?: string;
  event: GatewayEvent;
};
```

- `epoch`：权威执行流代次；无头重启或流重建时改变。
- `seq`：该会话执行事件的单调序号；不能只在 timeline 内容帧上分配。
- `runId`：继续标识回合；跨 run 的 session 状态不能仅靠 run 内序号恢复。
- `eventId`：可由 `epoch/sessionId/seq` 派生，用于去重和诊断。

序号必须在事件进入回放存储与广播分叉之前统一分配。普通 status、stream_end、complete、task_result 等旁路事件必须纳入同一契约，否则仍有无序通道。

3001 自有队列事件不能伪装成无头执行序号；队列使用独立 `queueRevision`，或经明确的权威投影纳入快照。

`seq` 的适用范围必须写死，避免被当成通用的"帧序号"：

- 只覆盖**权威执行事件**——即由无头执行侧产生、参与会话执行状态投影的事件。
- 不是 `timeline.order/revision/offset`；内容块身份与排序仍由既有 timeline 契约负责。
- 不是 18789 submit-stream 的请求内 `seq`（`GatewayWsConnection.ts` 中的每请求序号），后者只描述单次上游请求内部的顺序，不能跨请求、跨回合比较。
- 无 `seq` 的 legacy 帧与旁路帧（例如 3001 自有的 queue/传输事件、旧版无头部署发出的帧）必须继续被正常处理，但**不推进**客户端的 `lastAppliedSeq`，也**不得**被当作"无缺口"的证据。客户端处于有版本流时，收到无 `seq` 帧不能解除已标记的 gap。

### 4.2 权威快照

```ts
type SessionSnapshot = {
  epoch: string;
  sessionId: string;
  throughSeq: number;
  activeRunId: string | null;
  runState: 'inactive' | 'running' | 'unknown';
  phase: ExecutionPhase | null;
  activeTimeline: GatewayEvent[];
  pendingPermissions: unknown[];
  pendingElicitations: unknown[];
  queueRevision?: number;
  tokenBudget?: unknown;
  truncated?: false;
};
```

快照捕获必须在同一同步临界区读取 `throughSeq` 和投影，不能在两者之间 await。普通事件缓存截断后不得把不完整回放标成完整权威快照；应返回 `RESYNC_REQUIRED` 或使用真正完整的投影＋持久化历史。

`phase` 是当前状态字段，不是从历史 status 字符串临时猜测。活动回合结束后，持久化历史成为内容权威来源。

## 5. 模型请求状态机

```text
                         ┌─ retry ───────────────┐
                         │                       │
model.requested → model.waiting → model.streaming → model.completed
      │              │             │                  │
      │              │             ├─ tool.detected → tool.executing
      │              │             │                       │
      │              │             │                       └→ model.requested（下一轮）
      │              │             │
      │              │             └→ permission.waiting / compacting
      │              │
      └──────────────┴─ failed / aborted / turn.completed → inactive
```

每次模型调用分配独立 `modelCallId`。请求开始、首个响应、响应结束、重试和失败都携带该 ID。旧请求迟到的正文或结束帧不能推进新请求状态。

工具和权限是独立 phase，不能因为存在任意正文就简单清除“调用模型中”。同一回合可以发生多次模型请求。

**首个切片的实现边界（有意收窄）：**

- 只保证"显式终态"存在：`message_end` 产生一次模型请求完成，`error` 在 AgentLoop 判定终局时产生一次请求失败。
- `tool_call_start` **只结束当前正文流**（`assistant_stream_end`），不代表整个模型请求完成——它后面还会跟同一次请求的第二段正文，或同一回合的下一次请求。
- 终态清理依赖现有 run/turn 关联：只清理仍匹配该 run/turn 的模型请求状态，迟到终态不得清除新 run。
- 本切片**不**声称已实现完整 `modelCallId` 状态机；它是后续增强，等显式终态稳定后再引入。
- 夭折路径（无终态事件）仍由 turn `complete` 或 inactive 权威快照收敛。

模型级 `error` 需要额外谨慎：`InProcessGateway.mapModelEvent` 目前把 `error` 降级为 `assistant_stream_end`，因为 AgentLoop 可能自纠正重试，过早暴露会重复 `turn_failed` 并把重试显示成红色错误。因此**只有 AgentLoop 判定"终局放弃"时才发出请求失败**，模型级可恢复 error 继续只发 `assistant_stream_end`。

## 6. 恢复协调器

### 6.1 触发源

- WebSocket open/reconnect；
- `visibilitychange` 且重新 visible；
- `pageshow`（包括 BFCache 恢复）；
- `online`；
- heartbeat ACK 超时；
- timeline 或 execution seq gap。

### 6.2 不变量

1. 每个会话最多一个在途恢复。
2. 新恢复代次作废旧代次；旧响应不能修改当前状态。
3. heartbeat 成功只证明链路可通信，不证明没有 seq gap。
4. 页面隐藏时无需强行保持 UI 更新；恢复 visible 后必须对账。
5. 断线队列只保存明确幂等的请求；聊天提交、权限决定等命令不得由传输层静默重放。
6. 一个客户端的恢复不能取消其他客户端的 watcher 或活动回合。

## 7. 最小可靠方案：快照回退，不做增量补发

这是首个实施目标。

```text
实时帧 seq = last + 1       → 应用
实时帧 seq ≤ last           → 去重
实时帧 seq > last + 1       → 标记 gap，请求权威快照
快照 throughSeq < last      → 丢弃旧快照
快照 epoch 改变             → 清空旧执行基线，原子应用新快照
快照不可信 / truncated      → 持久化历史＋新的完整快照
```

最小方案仍需序号或等价的版本切面来判断快照新旧和检测缺口，但不需要服务端增量 replay API。出现 gap 时直接全量对账。

**gap 的唯一恢复动作是权威全量快照。** 本阶段不实现 `afterSeq` 补发、不缓冲缺口期间的后续帧、不在客户端做增量拼接；§8 描述的能力全部推迟。

### 文件级实施边界

| 层 | 目标改动 |
| --- | --- |
| `src/agent/protocol/events.ts`、`src/agent/loop/AgentLoop.ts` | 显式请求完成/失败事件，沿用既有 run/turn 关联；`modelCallId` 列为后续增强；保持每回合多次调用语义。 |
| `src/gateway/protocol/types.ts`、`src/gateway/client/InProcessGateway.ts` | 执行序号、epoch、快照基线和可信截断语义。 |
| `src/gateway/server/GatewayWsConnection.ts`、`src/gateway/client/GatewayWsClient.ts` | 保留并校验上游 stream seq；不自行创造跨连接恢复。 |
| `ui/server/pilotdeck-bridge.js`、`ui/server/index.js` | 透传快照版本、phase、truncated/resync；应用层 heartbeat ACK。 |
| `ui/src/contexts/WebSocketContext.tsx` | ACK 超时、恢复触发；保留现有订阅接口，避免无关 UI 改动。 |
| `ui/src/components/chat-v2/reconnectRecovery.ts`、`ChatInterfaceV2.tsx` | 统一 visible/pageshow/online/reconnect 对账。 |
| `ui/src/components/chat/sessionStatusProtocol.ts`、`useChatRealtimeHandlers.ts` | 快照版本与实时状态合并；作废旧恢复。 |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | 从当前 phase 派生状态文案，不从旧 status 推断。 |

实施时保留工作树中与本任务无关的修改，提交只包含本设计涉及的文件和测试。

## 8. 完整可靠方案：Snapshot＋Replay

在最小方案验收后按需增加：

1. 客户端保存 `(epoch, lastAppliedSeq)`。
2. 服务端提供有界 `afterSeq` replay。
3. 小缺口按序补齐；补发期间缓冲后续帧。
4. 缓存不足、epoch/run 不一致或冲突时返回 `RESYNC_REQUIRED`。
5. 回退到权威快照，以 `throughSeq` 为界丢弃旧缓冲，再继续实时流。
6. 客户端命令重试使用命令 ID 与幂等键。

Replay 是减少全量对账成本和保留中间事件的增强，不是最终一致性的前提。

## 9. 预注册验证要求

实现前先冻结目标测试及 SHA-256，并证明旧实现命中目标断言失败。夹具错误必须作废后重新冻结，不得通过削弱断言使测试转绿。

### 第一层：协议与 reducer

- 同回合两次模型请求＋工具；旧请求迟到帧不推进新请求。
- 普通 status、正文、工具、权限、complete 的统一顺序。
- 快照 N 与实时 N+1 反序；旧快照不得覆盖。
- 重复、乱序、gap、epoch 改变、truncated 和 resync。
- heartbeat ACK 与 gap 分离：ACK 正常仍必须发现缺口。

### 第二层：真实 3001 WebSocket 集成

- 两浏览器 watcher 广播、一个退出不影响另一个。
- 两客户端并发状态查询且有排队输入时只 dispatch 一次。
- ping ACK、ACK 超时、close、重连与 watch 恢复。
- 3001 ↔ 18789 断链后 UI 不永久停留在调用态。

### 第三层：真实浏览器

- 运行中刷新与结束后刷新。
- 一个前台、一个长期后台；后台恢复后权威投影一致。
- 页面冻结后无 close 的恢复。
- 半开连接故障注入与自动重连。
- 工具、正文、多次模型调用的最终视觉顺序。

jsdom 只能验证监听和 reducer，不得把其通过表述为真实浏览器冻结恢复已验收。

## 10. 非目标与保留边界

- 本阶段不安装 Socket.IO。
- 不迁移 `/shell`、`/plugin-ws` 或其他 Gateway 客户端。
- 不把无头进程崩溃后的模型执行续跑混入本方案。
- 不把 heartbeat 成功写成状态已同步。
- 不把工程测试 PASS 升级为单次事故根因已复现。
- 不做增量 replay，直到最小可靠方案通过上述验收。

## 11. 实施状态

按切片推进，每切片独立提交。本表只记录**已合并到工作树且有测试证据**的部分，未完成项保持"未开始"，不用计划语气冒充完成。

| 切片 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| C-1 | 3001 对 `ping` 返回 `pong` | 已实现 | `15ec0779`；`ui/server/session-heartbeat.test.js` 9 例；2026-11-07 真实 3001 经 supervisor 重启后 `/health` 正常，认证 `/ws` 返回匹配 `requestId` 的 `pong` |
| C-2 | 客户端 ACK 跟踪与有界超时 | 已实现 | `67872a6a`＋`9beb1a8f`；`WebSocketContext.heartbeat.test.tsx` 11 例（异常路径先红后绿） |
| A | 显式模型请求完成/失败事件 | 已实现（首期收窄版） | `bced4fee`＋`9beb1a8f`；AgentLoop 36 例、实时处理器 27 例；独立复核 PASS |
| B | execution epoch/seq 与版本化快照 | 未开始 | — |
| C-3 | 统一 RecoveryCoordinator | 未开始 | — |

A 切片的已知收窄：只覆盖"正常完成"与"终局失败（模型异常、流中断耗尽、未知结束耗尽）"，
自纠正重试路径不单独发终态（下一条 `model_request_started` 覆盖）；其余夭折路径仍由
turn `complete` 与 inactive 快照兜底。完整 `modelCallId` 状态机未实现。
`9beb1a8f` 补齐两处应急压缩仍溢出及通用带内模型错误的显式 `model_request_failed`，
并让 `retry_progress` 保留模型请求状态所有权；heartbeat 发送、打开时队列冲刷及构造器异常
也统一进入既有单次 settle 与指数退避。

审计修复的三份冻结测试 SHA-256：
- `useChatRealtimeHandlers.test.tsx`：`53d6ae8b3d928297d9c0448ab5773fe31c197f52e694e177b62c622ffdd84efd`
- `stream-interruption-recovery.spec.ts`：`e0326e1eb77654b248838d8fe3ec4742c7191df3c9a5990bd08144e789e80991`
- `WebSocketContext.heartbeat.test.tsx`：`de91225da6f2789e196bec907c5cc22fe59538a97eff629053ea38520593fdc4`

最终 Agent 冻结测试在隔离旧实现上为 35/36，唯一失败准确命中缺少 `model_request_failed`；
当前实现目标测试 36/36、UI 目标测试 38/38，独立复核的 Agent 相邻回归 77/77、UI 相邻回归
178/178（默认并行运行出现 1 个预存 5 秒超时，30 秒复跑全绿），UI 生产构建成功。

真实 3001 的 ping/pong 只验证生产接线和链路活性，不证明业务状态已同步。真实浏览器验收
（重试后的视觉状态、BFCache、页面冻结、半开连接）仍未完成，不因 jsdom 测试通过而标为完成。
