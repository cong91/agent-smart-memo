# ASM-61 — Test/Contract Migration + Rollout Guards

## Scope delivered

Phase IV adds migration coverage and rollout guard checks without breaking runtime behavior:

- Added **OpenClaw adapter contract test**:
  - `tests/test-openclaw-adapter-contract.ts`
- Kept and reused **Paperclip contract test** from Phase III:
  - `tests/test-paperclip-contracts.ts`
- Added **guard runner script** for release gate rehearsal:
  - `scripts/asm-rollout-guards.ts`

## Rollout guard gate (non-breaking)

Guard sequence:

1. `npm run build`
2. `npx tsx tests/test-runtime-boundary.ts`
3. `npx tsx tests/test-openclaw-adapter-contract.ts`
4. `npx tsx tests/test-paperclip-contracts.ts`

If any command fails, guard fails fast.

## Why this satisfies ASM-61

- Migrates contract checks to new architecture boundaries (`core contracts` + `openclaw/paperclip adapters`).
- Adds explicit rollout guard entrypoint for Phase V integration/readiness verification.
- Maintains compatibility-first behavior by validating existing result/session contracts.
