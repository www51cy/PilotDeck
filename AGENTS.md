# AGENTS.md

本文件为在本仓库中工作的 AI 智能体提供指引。

## 提交（Commit）

遵循 Conventional Commits：`<type>(<scope>): <subject>`

- 主题使用英文祈使句，首字母小写，结尾不加句号；标题总长不超过 100 字符。
- 常用类型：`feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
- 每个提交只做一件事。

**正文是本仓库的持久记忆。** 未来的读者（包括 AI 智能体）通过 `git log` 重建上下文，看不到当初的对话。对于非琐碎改动，记录 diff 看不出来的信息：

- **问题**：什么输入或操作触发。
- **根因**：真正的机制，而不是表面症状。
- **修复**：所采用的方案、非显然的外部约束（第三方 API 行为、协议要求），以及被否决的替代方案。
- **验证**：哪些测试证明修复有效。

几行即可，琐碎提交不要硬凑模板。关键结论直接写进正文——聊天记录和外部链接都会消失。

## 验证

- 核心（`src/`、`tests/`）：用 `npx tsx --test tests/<area>/<file>.spec.ts` 运行相关测试；涉及函数签名改动的，推送前运行 `npm run build`。
- UI（`ui/`）：`pnpm --dir ui exec vitest run <file>`、`pnpm --dir ui typecheck`、`pnpm --dir ui build`。`apps/desktop` 的 electron 类型报错是历史遗留问题，与本次改动无关。
