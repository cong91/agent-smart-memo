# ASM-73 — [ASM v5.1] Master legacy migration, compatibility & task lineage

> Issue: ASM-73 (child of ASM-69)  
> Strategy: `code_light`  
> Scope: Define legacy-data migration/compatibility contract and task-lineage model for ASM v5.1 rollout.

## 1) Purpose

This document specifies how ASM v5.1 handles:

1. Legacy format detection and inventory (Qdrant / SQLite / graph).
2. Compatibility read behavior during migration window.
3. Lazy/background migration with idempotent guarantees.
4. Rollback/recovery safety.
5. Task lineage retrieval patterns for project-aware engineering memory.
6. Backfill policy for project alias + external tracker mappings.

This story is architecture/design contract (`code_light`), not full runtime implementation wiring.

---

## 2) Legacy inventory model (old-format detection)

## 2.1 Inventory objectives

For each project scope, produce a migration inventory report with:

- Legacy schema families detected.
- Record counts by store/type.
- Migration readiness by family.
- Risk flags (missing key fields / ambiguous mapping / orphan links).

## 2.2 Detection sources

- **Qdrant payloads**: missing `schema_version`, legacy namespace-only keys, absent `project_id`, inconsistent lifecycle fields.
- **SQLite metadata**: older tables/columns, ad-hoc task note layouts, no registration completeness fields.
- **Graph index**: nodes/edges without explicit `project_id`, missing lifecycle flags, legacy relation labels.

## 2.3 Minimum inventory output

Each detected legacy family should include:

- `legacy_family_id`
- `store_type` (`qdrant|sqlite|graph`)
- `legacy_signature`
- `estimated_record_count`
- `project_binding_confidence`
- `requires_manual_review` (boolean)
- `notes`

---

## 3) Mapping contract: old -> v5.1

## 3.1 Schema version policy

- Canonical target schema version: `5.1`.
- Migrated artifacts must carry `schema_version=5.1`.
- Legacy records keep original shape physically unless a migration write operation explicitly materializes v5.1 copy/upsert.

## 3.2 Required mapping dimensions

1. **Identity mapping**
   - legacy namespace/path-only identity -> canonical `project_id`, `file_id`, `chunk_id`, `symbol_id`, `task_id`.

2. **Lifecycle mapping**
   - legacy delete/absence semantics -> `active`, `tombstone_at`, `index_state`.

3. **Lineage mapping**
   - free-form task references -> `parent_task_id`, `related_task_ids[]`, `files_touched[]`, `symbols_touched[]`, `decision_notes`.

4. **Tracker mapping**
   - ad-hoc Jira/Git references -> `project_tracker_mappings` contract (ASM-71 aligned).

## 3.3 Mapping registry (recommended)

Maintain explicit mapping registry entries:

- `mapping_id`
- `schema_from`
- `schema_to=5.1`
- `legacy_signature`
- `transform_checksum`
- `idempotency_key_strategy`
- `fallback_policy`

---

## 4) Compatibility read path (before full migration completion)

## 4.1 Dual-read principle

Read path must work even when migration is incomplete:

1. Attempt v5.1 canonical lookup first.
2. If insufficient results, fallback to legacy readers.
3. Normalize merged results into v5.1 response contract before returning.

## 4.2 Result normalization rules

- Always emit project-aware response envelope (`project_id` resolved or marked uncertain).
- Annotate provenance (`source_schema`, `compatibility_mode_used`).
- Preserve scoring/ranking transparency if mixing old/new sources.

## 4.3 Compatibility guardrails

- Compatibility path is read-safe and non-destructive.
- Legacy records are never deleted by read operations.
- Ambiguous identity merges must degrade safely (warn + lower confidence) rather than silently fabricate certainty.

---

## 5) Migration execution model (lazy/background + idempotent)

## 5.1 Execution modes

- **Lazy migration on access**: migrate/update hot records when accessed by retrieval flow.
- **Background batch migration**: scheduled scan-and-upsert for cold legacy datasets.
- **Repair migration**: targeted replay for failed/partial batches.

## 5.2 Idempotency requirements

Every migration write must be idempotent by:

- stable target key (`file_id|chunk_id|symbol_id|task_id`)
- `schema_version` transition guard
- content `checksum` / `transform_checksum`
- migration run identity (`migration_run_id`)

Replaying the same migration unit must not duplicate artifacts or corrupt lineage.

## 5.3 State tracking

Track migration unit state with:

- `pending`
- `migrated`
- `skipped`
- `error`
- `rolled_back`

And persist reason metadata for non-success states.

---

## 6) No-destructive-default policy

Default policy is **non-destructive**:

- Do not hard-delete legacy records during rollout.
- Prefer additive write/upsert to v5.1 structures.
- Use tombstone/deactivate semantics for superseded artifacts when needed.
- Hard-delete is an explicit later-phase maintenance operation after stability gates.

---

## 7) Rollback and recovery strategy

## 7.1 Rollback boundaries

- Roll back migration *state pointers* and compatibility routing flags first.
- Keep migrated v5.1 artifacts available unless proven corrupt.
- If needed, quarantine problematic migration batches by `migration_run_id`.

## 7.2 Recovery playbook (minimum)

1. Freeze new migration jobs.
2. Switch retrieval to compatibility-priority mode.
3. Inspect failed signatures/batches.
4. Re-run repair migration for affected families.
5. Re-open progressive rollout after health gates pass.

## 7.3 Health gates

Recommended gates before tightening compatibility fallback:

- error ratio below threshold
- lineage integrity checks pass
- project alias/tracker mapping completeness above threshold
- retrieval parity sample checks pass (legacy vs canonical expected equivalence)

---

## 8) Task lineage model (stronger than flat task notes)

## 8.1 Required lineage capabilities

Support direct answers for:

1. **Task nào từng sửa file/module/symbol này?**
2. **Task cha/con nào liên quan?**
3. **Decision nào từng áp vào vùng code này?**

## 8.2 Canonical lineage joins

- Task hierarchy: `parent_task_id`, child links.
- Cross-task relations: `related_task_ids[]`, graph `RELATED_TO`/`DEPENDS_ON`/`BLOCKS`.
- Code touch map: task -> files/symbols/commits.
- Decision linkage: task -> decision notes -> affected code scope.

## 8.3 Retrieval usage plan

Inject lineage context into retrieval orchestration:

1. Resolve task family context near current request.
2. Pull historically touched symbols/files for that family.
3. Prioritize previously applied decisions and known constraints.
4. Return compact lineage summary + evidence references so agent avoids re-reading from scratch.

---

## 9) Backfill plan for project alias + tracker mapping

## 9.1 Backfill objectives

For already indexed legacy projects that were never formally registered via `add project`:

- infer/register canonical `project_id`
- backfill `project_aliases`
- backfill `project_tracker_mappings` where evidence exists
- mark registration completeness/validation state

## 9.2 Inference inputs

- repo root and git remotes
- existing namespace/path clusters
- task keys (e.g., Jira issue patterns)
- historical metadata from records/notes

## 9.3 Safety rules

- Low-confidence alias/tracker inference stays as draft with `validation_status=warn`.
- Ambiguous mappings require manual disambiguation.
- Backfill is additive and reversible.

---

## 10) Compatibility path for “indexed but never registered” projects

If a project has indexed artifacts but no registration record:

1. Build provisional identity from observed index metadata.
2. Route retrieval through compatibility resolver using provisional `project_id` mapping.
3. Emit registration warning in metadata (`registration_status=draft|blocked`).
4. Keep retrieval available while prompting registration completion.

This ensures legacy indexed data remains usable before formal project registration is complete.

---

## 11) Suggested phased rollout

1. **Phase A: Inventory + mapping registry**
2. **Phase B: Dual-read compatibility in retrieval**
3. **Phase C: Lazy migration for hot paths**
4. **Phase D: Background backfill + lineage normalization**
5. **Phase E: Health-gated tightening of fallback usage**

---

## 12) Acceptance criteria coverage (ASM-73)

- Inventory old formats: **Section 2** ✅
- Mapping old -> new by schema version: **Section 3** ✅
- Read path usable before full migration: **Section 4** ✅
- No default deletion of old data: **Section 6** ✅
- Rollback/recovery strategy: **Section 7** ✅
- Task lineage query patterns (file/module/symbol, parent-child, decisions): **Section 8** ✅
- Plan to inject lineage into retrieval context: **Section 8.3** ✅
- Backfill plan alias/tracker mapping: **Section 9** ✅
- Compatibility when indexed but never registered: **Section 10** ✅

---

## 13) Implementation boundary note

This ticket defines migration + compatibility + lineage architecture contract (`code_light`) for ASM-73.
Concrete migration runners, storage adapters, and runtime wiring will be implemented by follow-up execution tasks under ASM-69 rollout lane.
