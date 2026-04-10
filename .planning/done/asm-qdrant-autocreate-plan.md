# ASM Qdrant auto-create collection fix

## Goal
Ensure ASM runtime auto-creates the configured Qdrant collection when it does not exist, instead of failing on first write/search.

## Required changes
1. In the main runtime initialization path, ensure `QdrantClient.createCollection()` is called before semantic operations rely on the collection.
2. The behavior must be idempotent: existing collections should be reused safely.
3. Add at least one focused validation/test path showing that a missing collection is created before use.
4. Preserve shared-config-first behavior; collection name must come from ASM shared config / runtime config, not hardcoded defaults.

## Constraints
- Use OpenCode to make the code changes.
- Do not patch around by forcing manual pre-creation only.
- Keep changes minimal and product-correct.
