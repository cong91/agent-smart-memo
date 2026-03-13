# ASM-79 — [ASM v5.1][Implementation] Hybrid retrieval & task-lineage context assembly

Scope: `code_light` only.

This implementation follows the architecture contracts defined earlier in:
- `docs/architecture/ASM-70-master-architecture-spec-project-memory-v5.1.md`
- `docs/architecture/ASM-73-master-legacy-migration-compatibility-task-lineage-v5.1.md`

## Delivered

### 1) New use-cases
Added non-breaking use-cases to the core contract layer:
- `project.task_registry_upsert`
- `project.task_lineage_context`
- `project.hybrid_search`

Files:
- `src/core/contracts/adapter-contracts.ts`
- `src/core/usecases/default-memory-usecase-port.ts`

### 2) Task-lineage persistence + retrieval assembly
Extended `SlotDB` with code-light task lineage primitives on top of the existing `task_registry` schema:
- upsert task lineage records
- resolve task focus by `task_id`, `tracker_issue_key`, or partial `task_title`
- assemble parent chain + related tasks
- aggregate touched files, symbols, commit refs, and decisions

File:
- `src/db/slot-db.ts`

### 3) Hybrid retrieval primitive
Implemented a metadata-first hybrid retrieval surface over existing control-plane registries:
- `file_index_state`
- `symbol_registry`
- `task_registry`

Ranking blends:
- lexical match against query
- optional task-lineage context boost
- touched file/symbol/task affinity
- deterministic capped result ordering

File:
- `src/db/slot-db.ts`

### 4) OpenClaw tool surfaces
Added tools to expose the new primitives:
- `project_task_registry_upsert`
- `project_task_lineage_context`
- `project_hybrid_search`

File:
- `src/tools/project-tools.ts`

### 5) Validation
Executed:
- `npm run build:openclaw` ✅
- `npx tsx tests/test-project-registry.ts` ✅
- `npx tsx tests/test-project-reindex-diff.ts` ✅
- `npx tsx tests/test-project-hybrid-lineage.ts` ✅

### 6) Scope guard
Intentionally NOT included in ASM-79:
- no queue/scheduler/orchestrator wiring
- no parser/symbol extraction runtime expansion
- no vector/Qdrant fusion in this phase
- no deploy/release/runtime rollout changes

This keeps ASM-79 aligned with `code_light` implementation scope while making the control-plane retrieval and lineage assembly contract executable.
