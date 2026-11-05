# 火山方舟 Coding Plan 接入排查记录

日期：2026-11-05。记录一次接入火山方舟 Coding Plan（`doubao-seed-2.1-lite`）时的完整排查链，供后续遇到同类问题对照。

## 症状与根因

按出现顺序，共四层，前一层修复后才暴露下一层：

1. **项目接口 503**：Provider 尚未配置完成，Gateway 未启动。Gateway 启动后接口恢复 200，与模型本身无关。
2. **`volc_ark/auto` 报错**：会话保存的显式模型选择会覆盖 YAML 里的默认模型，`auto` 被当作真实模型名发给方舟，而方舟没有这个模型。排查模型问题时，应先看会话当前选择，再看全局默认。
3. **Lite 被误判为不可用**：把两套接口混用了——
   - 普通按量接口：`/api/v3` + OpenAI 协议 + 带日期的模型 ID；
   - Coding Plan 接口：`/api/coding/v1` + Anthropic 协议 + `doubao-seed-2.1-lite`。
   `/api/v3` 返回 `ModelNotOpen` 只表示该模型未在这个端点开通，**不能外推为模型整体不可用**。排错时应用最小请求直连目标端点验证。
4. **「拉取 API 模型」报 AK/SK 无效**：Coding Plan 端点没有模型列表路径，列举模型需走账号级 `/api/v3/models` + Bearer 认证（修复于 `04cbfc5e`）。

## 暴露出的模型池 UI 缺陷

- **删除不落盘**：已保存但无引用的模型（如 `auto`），确认删除时只从 React 草稿移除，未调用服务端删除接口，`pilotdeck.yaml` 中条目残留，刷新后「复活」。
- **协议不可见**：Provider 的 `protocol` 字段只在「编辑自定义 Provider」时显示，目录 Provider（如 `volc_ark`）看不到当前使用 OpenAI 还是 Anthropic，导致端点协议配错时界面无从发现。

## 修复（均已推送到 main）

| Commit | 内容 |
|---|---|
| `82ee8485` | 已保存模型删除走服务端落盘；Provider 协议始终显示，非编辑时禁用 |
| `04cbfc5e` | Coding Plan base URL 的模型列举改走 `/api/v3/models` + Bearer |
| `399e8471` | tool result 紧跟 tool call，延迟结果并入首个 user 响应 |
| `7ac9d1a2` | 并行工具交换归一化：placeholder 并入首个响应，投影保持幂等 |

## 验证

- `pilotdeck.yaml` 中 `auto` 条目消失，默认模型、Anthropic 协议、Coding Plan 地址不变；
- ProviderCard 33 项、关联 UI 35 项、server 163 项、projector 7 项及相关回归 44 项测试通过；`npm run build` 通过。

## 附：正确的 Provider 配置

```yaml
model:
  providers:
    volc_ark:
      protocol: anthropic
      url: https://ark.cn-beijing.volces.com/api/coding/v1
      apiKey: <Coding Plan API Key>
      models:
        doubao-seed-2.1-lite:
          capabilities:
            maxContextTokens: 262144
            maxOutputTokens: 32768
agent:
  model: volc_ark/doubao-seed-2.1-lite
```

注意：Coding Plan 使用不带日期的模型 ID；带日期的 ID（如 `doubao-seed-2-1-lite-260915`）属于按量端点。

## 附：修复涉及的代码文件

- `ui/src/components/settings/view/modelPool/components/DeleteConfirmationModal.tsx`：已保存模型一律走服务端删除。
- `ui/src/components/settings/view/modelPool/components/ProviderCard.tsx`：协议字段拆出隐藏条件，始终渲染。
- `ui/server/routes/config.js`：Coding Plan base URL 的模型列举改走 `/api/v3/models` + Bearer。
- `src/context/projection/MessageProjector.ts`：tool result 配对与并行交换归一化。

## 经验

- 排查模型接入问题按「会话选择 → Provider 配置 → 端点与协议 → 模型 ID」顺序逐层验证，不从单一报错外推结论。
- 错误结论不要过早固化成记录；本记录仅包含修复并验证后的事实。
