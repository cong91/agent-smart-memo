# ASM-78 — [ASM v5.1][Implementation] Incremental reindex by diff/checksum/watch state

> Issue: ASM-78 (Phase B under ASM v5.1)
> Strategy: `code_light`
> Scope: Implement control-plane primitives for incremental reindex decisions via file diff + checksum and persistent watch state.

## 1) What was implemented

### 1.1 New use-cases and tool surfaces

Added new project use-cases and tool wiring:

- `project.reindex_diff`
- `project.index_watch_get`

Files:

- `src/core/contracts/adapter-contracts.ts`
- `src/core/usecases/default-memory-usecase-port.ts`
- `src/tools/project-tools.ts`

New OpenClaw tools:

- `project_reindex_diff`
- `project_index_watch_get`

### 1.2 Persistent watch-state schema

Extended SQLite migration (`SlotDB.migrate`) with table/index:

- `project_index_watch_state`
  - `project_id`
  - `scope_user_id`
  - `scope_agent_id`
  - `last_source_rev`
  - `last_checksum_snapshot` (JSON map `relative_path -> checksum`)
  - `updated_at`

- index: `idx_project_watch_updated`

File:

- `src/db/slot-db.ts`

### 1.3 Incremental diff/checksum algorithm (control-plane)

Implemented `reindexProjectByDiff(...)` in `SlotDB`:

1. Validate `project_id` exists in project registry.
2. Load previous watch snapshot (`project_index_watch_state`).
3. Build current snapshot from `paths[]` (`relative_path`, `checksum`).
4. Compute:
   - `changed`: checksum changed or new file
   - `unchanged`: checksum unchanged
   - `deleted`: existed before but no longer present
5. Record lifecycle run in `index_runs`:
   - insert `indexing`
   - finalize `indexed` or `error`
6. Update `file_index_state`:
   - changed => upsert `index_state='indexed', active=1`
   - deleted => tombstone-style mark `index_state='stale', active=0, tombstone_at`
7. Persist latest watch snapshot + `last_source_rev`.

### 1.4 Typed API additions

Added exported interfaces in `slot-db.ts`:

- `ProjectReindexDiffInput`
- `ProjectIndexWatchState`
- `ProjectReindexDiffResult`

## 2) Tests and validation

### 2.1 Build

- `npm run build:openclaw` ✅

### 2.2 Targeted tests

- Existing regression:
  - `npx tsx tests/test-project-registry.ts` ✅ (5/5)
- New ASM-78 test:
  - `npx tsx tests/test-project-reindex-diff.ts` ✅ (3/3)

`test-project-reindex-diff.ts` verifies:

- first bootstrap run => all files `changed`
- stable checksums => `unchanged`
- checksum update + missing previous file => `changed` + `deleted`
- watch-state retrieval matches latest `source_rev` and checksum snapshot

## 3) Scope boundary (explicit)

- No runtime queue/scheduler/orchestrator wiring.
- No parser/chunker extraction logic expansion (ASM-77 concern).
- No Qdrant/graph write-path runtime fanout beyond existing schema scaffolding.
- No deploy/release workflow changes.

## 4) Acceptance mapping (ASM-78)

- Incremental reindex decision via diff/checksum: ✅
- Watch state persistence per project scope: ✅
- Lifecycle run tracking (`index_runs`): ✅
- Delete handling via tombstone/deactivate state: ✅
- Non-breaking code-light implementation boundary: ✅
