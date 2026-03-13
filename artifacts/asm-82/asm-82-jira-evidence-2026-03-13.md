# ASM-82 Evidence — 2026-03-13

## Scope
- Issue: **ASM-82** — [ASM v5.1][Implementation] Telegram operator onboarding flow for project registration & Jira mapping
- Strategy: `code_light`
- Scope guard: only operator-facing onboarding flow wiring + tool/usecase contracts + tests; no deploy/runtime queue rewiring.

## Jira context read (before coding)
- Summary verified on Jira issue page: **[ASM v5.1][Implementation] Telegram operator onboarding flow for project registration & Jira mapping**
- Description verified:
  - Slash trigger (`/add_project <repo_url>`) + inline wizard steps (repo, alias, Jira space, default epic, index now)
  - Validation inline + confirm card + minimum action buttons
  - Must reuse ASM-80 command layer (`project_register_command`, `project_link_tracker`, `project_trigger_index`)
  - Keep backward compatibility

## Implementation delivered
1. Added new use-case contract and handler:
   - `project.telegram_onboarding`
   - Supports `mode=preview|confirm`
2. Implemented onboarding behavior in use-case layer:
   - `preview`: validates repo/Jira inputs and returns summary card with operator actions
   - `confirm`: bridges to ASM-80 command path by calling existing register/index flow
3. Added new OpenClaw tool surface:
   - `project_telegram_onboarding`
4. Added regression tests for Telegram onboarding flow:
   - validation error path (inline Jira mapping errors)
   - confirm/commit path (project registered + Jira mapped + index-now propagated)

## Files changed
- `src/core/contracts/adapter-contracts.ts`
- `src/core/usecases/default-memory-usecase-port.ts`
- `src/tools/project-tools.ts`
- `tests/test-project-registry.ts`

## Validation
- `npm run build:openclaw` ✅
- `npx tsx tests/test-project-registry.ts` ✅ (11/11)
- `npx tsx tests/test-project-reindex-diff.ts` ✅ (3/3)
- `npx tsx tests/test-project-hybrid-lineage.ts` ✅ (3/3)

## Commit evidence
- Commit: `<pending>`
- Message: `feat(asm-82): add telegram operator onboarding flow for project registration`

## Jira update evidence
- Added implementation comment in ASM-82 activity with scope + commit + validation.
- Transitioned status: **To Do -> Done**.
