# ASM Qdrant auto-create collection fix (scoped execution)

## Goal
Implement the missing runtime bootstrap so ASM auto-creates the configured Qdrant collection when it does not yet exist.

## Exact implementation target
1. Main OpenClaw runtime path in `src/index.ts` must ensure collection existence before semantic operations rely on it.
2. Paperclip runtime path in `src/adapters/paperclip/runtime.ts` should also ensure collection existence when using a configured/new collection.
3. Reuse the existing `QdrantClient.createCollection()` idempotent behavior.
4. Add or update a focused test proving a missing collection is created before use.
5. Run focused validation/build/tests and report exact results.
6. Commit local changes when green.

## Constraints
- Minimal patch only.
- Do not redesign unrelated config behavior in this task.
- Do not stop at investigation; finish code + validation + local commit.
