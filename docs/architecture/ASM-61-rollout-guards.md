# ASM-61 — Test/Contract Migration + Rollout Guards

> **Historical note (2026-04-09, bead agent-smart-memo-r4t.26):** Paperclip support was removed from active ASM runtime/package/test surfaces. Any Paperclip references below are archived design history, not current supported runtime behavior.

## Scope delivered

Phase IV adds migration coverage and rollout guard checks without breaking runtime behavior:

- Added **OpenClaw adapter contract test**:
  - `tests/test-openclaw-adapter-contract.ts`
- Added **guard runner script** for release gate rehearsal:
  - `scripts/asm-rollout-guards.ts`
- Paperclip guard lane is archived (removed from active guard sequence in bead `agent-smart-memo-r4t.26`).

## Rollout guard gate (non-breaking)

Guard sequence:

1. `npm run build`
2. `npx tsx tests/test-runtime-boundary.ts`
3. `npx tsx tests/test-openclaw-adapter-contract.ts`

If any command fails, guard fails fast.

## Why this satisfies ASM-61

- Migrates contract checks to new architecture boundaries (`core contracts` + OpenClaw adapter).
- Adds explicit rollout guard entrypoint for Phase V integration/readiness verification.
- Maintains compatibility-first behavior by validating existing result/session contracts.
