# AGENTS.md

Guidance for AI agents working in this repository.

## Commits

Follow Conventional Commits: `<type>(<scope>): <subject>`

- English imperative subject, lower case, no trailing period; header ≤ 100 chars.
- Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`.
- One logical change per commit.

**The body is this repository's durable memory.** Future readers (including
agents) reconstruct context from `git log`, not from the original chat. For
non-trivial changes, record what the diff cannot show:

- **Problem**: what input or operation triggers the issue.
- **Root cause**: the mechanism, not the symptom.
- **Fix**: the approach, non-obvious external constraints (third-party API
  behavior, protocol requirements), and alternatives that were rejected.
- **Verification**: which tests prove the change works.

A few lines are enough; do not pad trivial commits. Write key conclusions
inline — chat logs and external links disappear.

## Verification

- Core (`src/`, `tests/`): run the relevant spec with
  `npx tsx --test tests/<area>/<file>.spec.ts`; run `npm run build` before
  pushing signature-affecting changes.
- UI (`ui/`): `pnpm --dir ui exec vitest run <file>`,
  `pnpm --dir ui typecheck`, `pnpm --dir ui build`.
  The `apps/desktop` electron type errors are pre-existing and unrelated.
