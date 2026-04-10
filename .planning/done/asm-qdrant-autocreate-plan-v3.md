# ASM Qdrant auto-create collection fix (implementation-only)

## Goal
When ASM is configured with a Qdrant collection name that does not exist yet, runtime must create the collection automatically from config and then continue. If the collection already exists, skip safely.

## Exact required behavior
1. In the main OpenClaw runtime path, after constructing `QdrantClient`, ensure the configured collection exists by calling the existing idempotent collection creation logic.
2. In the Paperclip runtime path, do the same.
3. Do not rework unrelated config semantics in this task.
4. Add or update focused tests proving the auto-create behavior.
5. Run focused validation/build/tests.
6. Commit local changes when green.

## Acceptance criteria
- New collection name in config does not fail on first semantic write due to missing collection.
- Existing collection path remains safe/idempotent.
- Build + focused tests pass.
