# ASM-72 — [ASM v5.1] Master ingest & incremental reindex pipeline

> Issue: ASM-72 (child of ASM-69)  
> Strategy: `code_light`  
> Scope: Pipeline architecture for project-aware ingest + incremental reindex, aligned with ASM-70/ASM-71 contracts.

## 1) Purpose

Define the canonical ingest/reindex execution pipeline for ASM v5.1 so agent orchestration can quickly retrieve accurate project-scoped technical context without re-reading entire repositories.

This story focuses on **architecture contract and flow design** (not runtime production wiring).

---

## 2) Design goals

1. Project-root agnostic (no fixed `~/Work/projects` assumptions).
2. Fast incremental updates (avoid full rebuild by default).
3. Deterministic + idempotent indexing (stable keys, upsert semantics).
4. Strong lifecycle semantics (`indexing/indexed/stale/error`, tombstone-first deletes).
5. Retrieval-ready metadata for path/module/symbol/task scoped queries.
6. Integrated project alias + tracker mapping validation in registration/index flow.

---

## 3) End-to-end pipeline overview

## 3.1 Main phases

1. **Project registration intake**
   - Input hints: `project_id | project_alias | repo_root | repo_remote`.
   - Resolve/create canonical `project_id`.
   - Persist registration metadata and mapping draft.

2. **Pre-index validation**
   - Validate required registration + tracker mapping fields.
   - Compute `registration_status`, `validation_status`, `completeness_score`.
   - Fail fast (blocked) or continue with warnings.

3. **Ingest planning**
   - Determine trigger mode: `bootstrap | incremental | manual | repair`.
   - Build candidate file set by source change signals.
   - Apply filtering + chunk strategy profile.

4. **Extraction/index execution**
   - Parse semantic blocks (function/class/method + docs/task notes).
   - Chunk/embed/summarize.
   - Upsert Qdrant points + SQLite registries + graph edges.

5. **Lifecycle reconciliation**
   - Mark removed artifacts via `active=false` + `tombstone_at`.
   - Set stale/error states for failures/drift.
   - Publish health metrics and run summary.

6. **Optional enrich**
   - Targeted enrichment by hot module/task/symbol scope.
   - Mapping refresh (alias/tracker) if new context is learned.

---

## 4) Trigger model

## 4.1 Required triggers

- `add/register project` completion hook → **index eligibility check**.
- `Index now` action after registration → immediate job enqueue.
- `git diff` / commit change-set signal → incremental reindex.
- Manual scope request (`path/module/task`) → scoped reindex.
- Repair trigger when stale/error ratio exceeds policy threshold.

## 4.2 Trigger contract

Each job is keyed by:

- `project_id`
- `source_rev` (commit SHA or synthetic workspace rev for uncommitted changes)
- `index_profile`
- `trigger_type`

Dedup key:
`sha1(project_id + ":" + source_rev + ":" + index_profile + ":" + trigger_type)`

Idempotency rule: duplicate active/running jobs with same dedup key are collapsed.

---

## 5) Project root detection and fingerprinting

## 5.1 Root detection inputs

- explicit `repo_root`
- normalized git root discovery (`git rev-parse --show-toplevel` when available)
- fallback imported path

## 5.2 Fingerprint

`project_fingerprint = sha1(normalized_repo_remote + ":" + normalized_repo_root + ":" + tracker_space_key?)`

Used for candidate matching before canonical `project_id` assignment.

No hardcoded absolute base path is allowed.

---

## 6) File filtering and chunk sizing strategy

## 6.1 Filtering (Roo/Kilo-like policy)

Exclude by default:

- binary/media archives
- dependency/vendor trees (`node_modules`, `.venv`, `vendor`, build cache)
- generated artifacts (`dist`, `build`, coverage, lock snapshots when configured)
- oversized files above profile cap
- ignored paths from `.gitignore` + explicit ingest ignore rules

Include override list is supported for targeted exceptions.

## 6.2 Block/chunk sizing profile

- Primary boundary: semantic block (symbol-level) when parser confidence is sufficient.
- Fallback: paragraph/logical section chunking for non-code docs.
- Hard cap per chunk by token/char budget.
- Oversized symbol strategy: split by nested logical blocks while preserving semantic path.

Chunk identity remains deterministic via stable `chunk_id` policy from ASM-71.

---

## 7) Incremental reindex algorithm

## 7.1 Change-set sources

- committed diff (`source_rev_prev..source_rev_curr`)
- workspace uncommitted delta (`git status`/checksum drift)
- forced scoped list (`path_prefix[]`, `module[]`, `task_id[]`)

## 7.2 Reindex decision matrix

For each candidate file:

- **new file** → index all chunks/symbols.
- **checksum changed** → re-parse + upsert changed artifacts; stale/tombstone removed old artifacts.
- **unchanged checksum** → skip heavy extraction.
- **deleted file** → tombstone file/chunk/symbol + graph edges.

## 7.3 Neighborhood update

If symbol graph relations changed, refresh dependent edges within bounded radius (module-local default, configurable).

---

## 8) Persistence and upsert contract

Writes follow ASM-71 schema contracts:

- Qdrant payload with `schema_version=5.1`, `project_id`, `index_state`, `active`, `tombstone_at`.
- SQLite registries: `file_index_state`, `chunk_registry`, `symbol_registry`, `task_registry`, `index_runs`.
- Graph nodes/edges with `project_id`, lifecycle fields, and updated timestamps.

Upsert keys are stable IDs (`file_id`, `chunk_id`, `symbol_id`, `task_id`) to guarantee idempotent reruns.

---

## 9) Tombstone and lifecycle policy

Deletion/deactivation is tombstone-first:

- `active=false`
- `tombstone_at` set
- optional `deactivate_reason`

State model:

- `indexing` (run active)
- `indexed` (healthy/current)
- `stale` (source drift detected)
- `error` (pipeline failure)

Default retrieval path prefers `active=true` and excludes `error` unless explicitly requested.

---

## 10) Registration + alias/tracker mapping integration

## 10.1 Required registration flow behavior

1. `add/register project` writes/updates project + alias records.
2. Mapping validation executes before indexing.
3. If validation passes threshold → enable `Index now`.
4. During ingest/enrich, mapping can be attached/updated when higher-confidence data appears.

## 10.2 Validation outputs

Persist to `project_registration_state`:

- `registration_status`
- `validation_status`
- `completeness_score`
- `missing_required_fields[]`
- `validation_notes`

Blocked validation prevents bootstrap indexing unless operator overrides policy.

---

## 11) Observability and health

Per-run and per-project signals:

- state (`indexing/indexed/stale/error`)
- file processed / skipped / failed counts
- tombstone counts
- parser error ratio
- stale ratio
- queue lag
- last successful index timestamp

Minimum run summary artifact:

- `run_id`
- trigger metadata
- scope metadata
- elapsed time
- write counts by store (qdrant/sqlite/graph)
- warnings/errors

---

## 12) Scope-limited reindex modes

Supported reindex scopes:

- by `path_prefix[]`
- by `module[]`
- by `task_id[]`
- by explicit file list

Rules:

- Scope mode never forces full-repo rebuild unless dependency impact policy requires escalation.
- Escalation decision and reason are logged in run summary.

---

## 13) Safety, rollback, and compatibility

- Non-destructive migration-first approach (tombstone before hard-delete).
- Dual-read compatibility remains during rollout window.
- Retryable jobs with bounded backoff.
- Repair mode can rehydrate stale/error artifacts without full bootstrap.

---

## 14) Acceptance criteria coverage (ASM-72)

- No fixed path assumptions: **Sections 5, 6** ✅
- Filtering rules (Roo/Kilo-like): **Section 6.1** ✅
- Block/chunk sizing strategy: **Section 6.2** ✅
- Idempotent reindex (stable keys + upsert): **Sections 4.2, 8** ✅
- Avoid unnecessary full rebuilds: **Sections 7, 12** ✅
- Tombstone/deactivate for deletes: **Sections 7.2, 9** ✅
- Index status/observability: **Sections 9, 11** ✅
- Scope-limited reindex by path/module: **Section 12** ✅
- Attach/update alias + tracker mapping during ingest/enrich: **Section 10** ✅
- Trigger after add/register project: **Section 4.1, 10.1** ✅
- Validate mapping before index: **Section 10.1/10.2** ✅
- Option `Index now` after registration: **Sections 4.1, 10.1** ✅

---

## 15) Implementation boundary note

This ticket delivers the **master ingest/reindex architecture contract** (`code_light`).
Concrete runtime worker wiring, queue orchestration implementation, and production rollout scripts are handled in follow-up execution stories under ASM-69 lane.