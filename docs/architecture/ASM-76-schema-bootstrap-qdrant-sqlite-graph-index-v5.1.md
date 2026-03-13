# ASM-76 — [ASM v5.1][Implementation] Schema bootstrap for Qdrant / SQLite / graph index

> Issue: ASM-76 (child of ASM-75)
> Strategy: `code_light`
> Scope: Bootstrap storage schema/index surfaces only, aligned to ASM-71 master schema; no full ingest/reindex runtime wiring.

## 1) What was implemented

### 1.1 SQLite bootstrap (metadata/control plane)

Updated `SlotDB.migrate()` to create v5.1 bootstrap tables (scoped by `scope_user_id`, `scope_agent_id`):

- `index_runs`
- `file_index_state`
- `chunk_registry`
- `symbol_registry`
- `task_registry`
- `migration_state`

Added recommended indexes aligned with ASM-71 intent:

- `idx_index_runs_project_state`
- `idx_file_state_project_path`
- `idx_chunk_project_state`
- `idx_symbol_project_module_name`
- `idx_task_project_parent`

Notes:
- Existing v5.1 registration tables (`projects`, `project_aliases`, `project_tracker_mappings`, `project_registration_state`) were preserved.
- This ticket only bootstraps schema/table availability; no migration job orchestration introduced.

### 1.2 Qdrant bootstrap (semantic payload index surfaces)

Updated `QdrantClient.createCollection()` to create payload indexes for v5.1 retrieval filterability:

- `schema_version`
- `project_id`
- `chunk_id`
- `doc_kind`
- `relative_path`
- `language`
- `module`
- `symbol_name`
- `symbol_id`
- `task_id`
- `commit_sha`
- `checksum`
- `indexed_at`
- `tombstone_at`
- `active`
- `index_state`

Notes:
- Existing legacy indexes (`namespace`, `agent`, `source_*`, `timestamp`, `userId`) remain for backward compatibility.

### 1.3 Graph index scope for this ticket

No new graph runtime API added in ASM-76.
Current `GraphDB` DDL remains as bootstrap baseline (entities/relationships).
Follow-up stories can extend graph node/edge families (`PROJECT/FILE/SYMBOL/TASK/...`) and lifecycle attributes in query/model layer.

## 2) Files changed

- `src/db/slot-db.ts`
- `src/services/qdrant.ts`
- `docs/architecture/ASM-76-schema-bootstrap-qdrant-sqlite-graph-index-v5.1.md`

## 3) Out-of-scope (explicit)

- No full ingest worker, queue, or reindex orchestrator wiring.
- No destructive migration of legacy records.
- No behavior claim beyond schema/index bootstrap availability.

## 4) Acceptance mapping (ASM-76)

- Qdrant bootstrap fields/indexes available for project-aware filters: ✅
- SQLite control-plane registries for ingest/index lifecycle available: ✅
- Graph index treated as bootstrap baseline (non-breaking): ✅
- Scope remains implementation-light (`code_light`): ✅
