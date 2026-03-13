# ASM-81 Evidence — 2026-03-13

## Scope
- Issue: **ASM-81** — [ASM v5.1][Implementation] Legacy compatibility, migration & backfill
- Strategy: `code_light`
- Scope guard: only legacy compatibility/backfill implementation in ASM v5.1 memory layer; no deploy/runtime supervisor wiring.

## Jira context read (before coding)
- Key: `ASM-81`
- Summary: `[ASM v5.1][Implementation] Legacy compatibility, migration & backfill`
- Status at start: `To Do`
- Description preview validated on Jira: `Triển khai compatibility read path, lazy/background migration, alias/tracker backfill và indexed-but-unregistered compatibility; bám ASM-73.`

## Implementation delivered
1. Added canonical use-case: `project.legacy_backfill`
   - supports `mode=dry_run|apply`
   - supports selectors `only_project_ids`, `only_aliases`
   - supports `source=repo_root|repo_remote|task_registry|mixed`
2. Added legacy backfill engine in SlotDB:
   - infer alias from repo root / repo remote
   - infer tracker mapping from task registry issue keys (Jira space inference)
   - upsert registration state normalization (registered/validated + completeness)
   - upsert `migration_state` marker per project (`legacy-backfill:<project_id>`)
   - non-destructive default behavior (dry-run no writes, apply additive updates)
3. Added OpenClaw tool surface:
   - `project_legacy_backfill`
4. Added regression test suite:
   - `tests/test-project-legacy-backfill.ts`
   - verifies dry-run safety, apply behavior, alias targeting, inferred Jira mapping, migration_state upsert

## Files changed
- `src/core/contracts/adapter-contracts.ts`
- `src/core/usecases/default-memory-usecase-port.ts`
- `src/db/slot-db.ts`
- `src/tools/project-tools.ts`
- `tests/test-project-legacy-backfill.ts`

## Validation
- `npm run build:openclaw` ✅
- `npx tsx tests/test-project-registry.ts` ✅ (9/9)
- `npx tsx tests/test-project-reindex-diff.ts` ✅ (3/3)
- `npx tsx tests/test-project-hybrid-lineage.ts` ✅ (3/3)
- `npx tsx tests/test-project-legacy-backfill.ts` ✅ (3/3)

## Commit evidence
- Commit: `<pending-commit>`
- Message: `feat(asm-81): implement legacy compatibility backfill usecase and tool`

## Jira update draft
- Comment draft should include: context read, scope guard, implementation bullets, validation matrix, commit hash.
- Transition plan: `To Do -> Done` after comment posted and branch evidence attached.
