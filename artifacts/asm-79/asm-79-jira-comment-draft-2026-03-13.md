ASM-79 update (`code_light`) — Hybrid retrieval & task-lineage context assembly

Completed ASM-79 with a strict non-breaking control-plane implementation aligned to ASM v5.1 architecture docs (`ASM-70`, `ASM-73`).

## What was delivered

1) Core use-case surfaces
- Added new use-cases:
  - `project.task_registry_upsert`
  - `project.task_lineage_context`
  - `project.hybrid_search`
- Files:
  - `src/core/contracts/adapter-contracts.ts`
  - `src/core/usecases/default-memory-usecase-port.ts`

2) Task lineage assembly on top of existing schema
- Implemented task registry upsert/read primitives against existing `task_registry`
- Added lineage context assembly with:
  - focus resolution by `task_id` / `tracker_issue_key` / partial `task_title`
  - parent-chain traversal
  - related-task expansion
  - aggregation of touched files, touched symbols, commit refs, and decision notes
- File:
  - `src/db/slot-db.ts`

3) Hybrid retrieval primitive
- Implemented metadata-first hybrid retrieval over existing registries:
  - `file_index_state`
  - `symbol_registry`
  - `task_registry`
- Ranking blends lexical query match with task-lineage context boosts and project/task filters
- File:
  - `src/db/slot-db.ts`

4) OpenClaw tool surfaces
- Added tools:
  - `project_task_registry_upsert`
  - `project_task_lineage_context`
  - `project_hybrid_search`
- File:
  - `src/tools/project-tools.ts`

5) Tests and validation
- New targeted test:
  - `tests/test-project-hybrid-lineage.ts`
- Validation run:
  - `npm run build:openclaw` ✅
  - `npx tsx tests/test-project-registry.ts` ✅
  - `npx tsx tests/test-project-reindex-diff.ts` ✅
  - `npx tsx tests/test-project-hybrid-lineage.ts` ✅

6) Scope guard
Not included in ASM-79:
- no queue/orchestrator wiring
- no parser/runtime symbol extraction expansion
- no vector/Qdrant fusion in ranking yet
- no deploy/release changes

## Evidence
- Design/implementation note:
  - `docs/architecture/ASM-79-hybrid-retrieval-task-lineage-context-v5.1.md`
- Branch:
  - `work/asm-79-hybrid-retrieval-lineage-20260313`

## Proposed transition
- **In Progress -> Done** (if reviewer accepts code_light scope + evidence)

## Commit
- `<pending_commit_hash>` feat(asm-79): add hybrid retrieval and task-lineage context assembly
