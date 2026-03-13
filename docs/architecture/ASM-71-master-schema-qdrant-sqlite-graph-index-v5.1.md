# ASM-71 — [ASM v5.1] Master schema for Qdrant / SQLite / graph index

> Issue: ASM-71 (child of ASM-69)  
> Strategy: `code_light`  
> Scope: Canonical data schema for project-aware memory index (Qdrant + SQLite + graph), aligned with ASM-70 architecture.

## 1) Purpose and scope

This document defines the **master schema contract** for ASM v5.1 retrieval/indexing plane:

- Qdrant semantic payload schema
- SQLite metadata/control schema
- Graph index schema (nodes/edges)
- Stable IDs, lifecycle states, tombstone/deactivation rules
- Task lineage and tracker/project mapping schema
- Old schema → v5.1 mapping

Positioning follows ASM-70: this is **agent-facing engineering memory** for orchestration/research/coding workflows.

---

## 2) Canonical identity and stable IDs

All IDs are stable and deterministic within the same tenant/runtime boundary.

## 2.1 Project identity

- `project_id` (PK, immutable, canonical)
- `project_name` (display)
- `project_alias` (unique alias set, mutable)

## 2.2 File/chunk/symbol/task IDs

- `file_id` = `sha1(project_id + ":" + normalized_relative_path)`
- `chunk_id` = `sha1(file_id + ":" + chunk_kind + ":" + semantic_path + ":" + ordinal)`
- `symbol_id` = `sha1(project_id + ":" + language + ":" + symbol_fqn)`
- `task_id` = stable internal task key (mapped to external tracker when present)
- `task_link_id` = `sha1(parent_task_id + ":" + child_task_id + ":" + link_type)`

Notes:
- Keep legacy IDs as `legacy_*` fields when needed during migration.
- `project_id` is first-class partition key across all stores.

---

## 3) Qdrant semantic schema (payload contract)

## 3.1 Collection strategy

Recommended logical collections (single collection with `doc_kind` is also acceptable if operationally preferred):

- `asm_code_chunks_v51`
- `asm_project_docs_v51`
- `asm_task_context_v51`

## 3.2 Required payload fields

Every point must include:

- `schema_version` (e.g. `"5.1"`)
- `project_id`
- `chunk_id`
- `doc_kind` (`code_chunk|project_summary|module_summary|file_summary|decision_note|runbook|task_note`)
- `relative_path` (nullable for non-file docs)
- `language` (nullable)
- `module` (nullable)
- `symbol_name` (nullable)
- `symbol_id` (nullable)
- `task_id` (nullable)
- `commit_sha` (nullable)
- `checksum` (content hash)
- `indexed_at` (epoch ms / ISO timestamp)
- `active` (boolean, default true)
- `tombstone_at` (nullable)
- `index_state` (`indexed|stale|error`)

## 3.3 Optional payload fields

- `path_tokens[]`
- `module_tokens[]`
- `tracker_refs[]`
- `related_task_ids[]`
- `files_touched[]`
- `symbols_touched[]`
- `score_hints` (object)

## 3.4 Filter/search scope support

Qdrant filters must support:

- `project_id = ?`
- `relative_path LIKE prefix`
- `module IN (...)`
- `language IN (...)`
- `symbol_name = ?`
- `task_id IN (...)`
- `index_state IN (...)`
- `active = true`

---

## 4) SQLite master schema (metadata/control plane)

## 4.1 Core tables

### `projects`
- `project_id` TEXT PK
- `project_name` TEXT NOT NULL
- `repo_root` TEXT NOT NULL
- `active_version` TEXT NULL
- `is_active` INTEGER NOT NULL DEFAULT 1
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### `project_aliases`
- `id` TEXT PK
- `project_id` TEXT NOT NULL FK -> projects(project_id)
- `project_alias` TEXT NOT NULL UNIQUE
- `is_primary` INTEGER NOT NULL DEFAULT 0
- `created_at` TEXT NOT NULL

### `project_tracker_mappings`
- `id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `tracker_type` TEXT NOT NULL (`jira|github|other`)
- `tracker_space_key` TEXT NULL
- `tracker_project_id` TEXT NULL
- `default_epic_key` TEXT NULL
- `board_key` TEXT NULL
- `active_version` TEXT NULL
- `external_project_url` TEXT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### `project_registration_state`
- `project_id` TEXT PK FK
- `registration_status` TEXT NOT NULL (`draft|registered|validated|blocked`)
- `validation_status` TEXT NOT NULL (`pending|ok|warn|error`)
- `validation_notes` TEXT NULL
- `completeness_score` INTEGER NOT NULL DEFAULT 0
- `missing_required_fields` TEXT NULL (JSON array)
- `last_validated_at` TEXT NULL
- `updated_at` TEXT NOT NULL

### `index_runs`
- `run_id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `index_profile` TEXT NOT NULL
- `trigger_type` TEXT NOT NULL (`bootstrap|incremental|manual|repair`)
- `state` TEXT NOT NULL (`indexing|indexed|stale|error`)
- `started_at` TEXT NOT NULL
- `finished_at` TEXT NULL
- `error_message` TEXT NULL

### `file_index_state`
- `file_id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `relative_path` TEXT NOT NULL
- `module` TEXT NULL
- `language` TEXT NULL
- `checksum` TEXT NOT NULL
- `last_commit_sha` TEXT NULL
- `index_state` TEXT NOT NULL (`indexed|stale|error`)
- `active` INTEGER NOT NULL DEFAULT 1
- `tombstone_at` TEXT NULL
- `indexed_at` TEXT NULL
- UNIQUE(`project_id`, `relative_path`)

### `chunk_registry`
- `chunk_id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `file_id` TEXT NULL FK
- `relative_path` TEXT NULL
- `chunk_kind` TEXT NOT NULL
- `symbol_id` TEXT NULL
- `task_id` TEXT NULL
- `checksum` TEXT NOT NULL
- `qdrant_point_id` TEXT NULL
- `index_state` TEXT NOT NULL (`indexed|stale|error`)
- `active` INTEGER NOT NULL DEFAULT 1
- `tombstone_at` TEXT NULL
- `indexed_at` TEXT NULL

### `symbol_registry`
- `symbol_id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `relative_path` TEXT NOT NULL
- `module` TEXT NULL
- `language` TEXT NOT NULL
- `symbol_name` TEXT NOT NULL
- `symbol_fqn` TEXT NOT NULL
- `symbol_kind` TEXT NOT NULL
- `signature_hash` TEXT NULL
- `index_state` TEXT NOT NULL (`indexed|stale|error`)
- `active` INTEGER NOT NULL DEFAULT 1
- `tombstone_at` TEXT NULL
- `indexed_at` TEXT NULL

### `task_registry`
- `task_id` TEXT PK
- `project_id` TEXT NOT NULL FK
- `task_title` TEXT NOT NULL
- `task_type` TEXT NULL
- `task_status` TEXT NULL
- `parent_task_id` TEXT NULL
- `related_task_ids` TEXT NULL (JSON array)
- `files_touched` TEXT NULL (JSON array)
- `symbols_touched` TEXT NULL (JSON array)
- `commit_refs` TEXT NULL (JSON array)
- `diff_refs` TEXT NULL (JSON array)
- `decision_notes` TEXT NULL
- `tracker_issue_key` TEXT NULL
- `updated_at` TEXT NOT NULL

### `migration_state`
- `migration_id` TEXT PK
- `schema_from` TEXT NOT NULL
- `schema_to` TEXT NOT NULL
- `applied_at` TEXT NOT NULL
- `status` TEXT NOT NULL (`success|partial|failed|rolled_back`)
- `notes` TEXT NULL

## 4.2 Recommended indexes

- `idx_file_state_project_path` on (`project_id`, `relative_path`)
- `idx_chunk_project_state` on (`project_id`, `index_state`, `active`)
- `idx_symbol_project_module_name` on (`project_id`, `module`, `symbol_name`)
- `idx_task_project_parent` on (`project_id`, `parent_task_id`)
- `idx_index_runs_project_state` on (`project_id`, `state`, `started_at`)

---

## 5) Graph index schema (project/file/symbol/task relations)

## 5.1 Node model

- `PROJECT` (`project_id`, `project_name`)
- `FILE` (`file_id`, `project_id`, `relative_path`, `module`, `language`, `active`)
- `SYMBOL` (`symbol_id`, `project_id`, `symbol_name`, `symbol_fqn`, `symbol_kind`, `active`)
- `TASK` (`task_id`, `project_id`, `task_status`, `tracker_issue_key`, `active`)
- `COMMIT` (`commit_sha`, `project_id`, `timestamp`)
- `DECISION_NOTE` (`decision_id`, `project_id`, `task_id`, `summary`)

## 5.2 Edge model

Required edge families:

- `PROJECT -> FILE` (`HAS_FILE`)
- `FILE -> SYMBOL` (`DECLARES`)
- `SYMBOL -> SYMBOL` (`CALLS|IMPORTS|EXTENDS|IMPLEMENTS|USES`)
- `TASK -> TASK` (`PARENT_OF|RELATED_TO|BLOCKS|DEPENDS_ON`)
- `TASK -> FILE` (`TOUCHES_FILE`)
- `TASK -> SYMBOL` (`TOUCHES_SYMBOL`)
- `TASK -> COMMIT` (`INCLUDES_COMMIT`)
- `TASK -> DECISION_NOTE` (`HAS_DECISION`)

All nodes/edges carry:
- `project_id`
- `schema_version`
- `active`
- `tombstone_at` (nullable)
- `updated_at`

---

## 6) Fresh/stale/error + tombstone lifecycle

## 6.1 State semantics

- `indexed`: current and valid for retrieval
- `stale`: known drift from latest source revision; retrievable with lower confidence
- `error`: indexing/parsing failed; excluded by default unless explicitly requested

## 6.2 Deletion/deactivation

All artifact levels (file/chunk/symbol/task links/graph edges) support:

- `active` boolean flag
- `tombstone_at` timestamp
- optional `deactivate_reason`

Hard-delete is deferred; tombstone-first policy is default.

---

## 7) Task lineage schema contract

Task lineage fields (minimum):

- `parent_task_id`
- `related_task_ids[]`
- `files_touched[]`
- `symbols_touched[]`
- `commit_refs[]`
- `diff_refs[]`
- `decision_notes`

Lineage must be queryable both:
- relationally via `task_registry`
- graph traversal via `TASK` edges

---

## 8) Project registration metadata + alias/tracker mapping

Required metadata contract:

- `project_name`
- `project_alias`
- `tracker_type`
- `tracker_space_key`
- `tracker_project_id`
- `default_epic_key`
- `active_version`
- `board_key`
- `repo_remote`
- `repo_root`

Registration completeness/validation state:

- `registration_status`
- `validation_status`
- `completeness_score`
- `missing_required_fields[]`
- `validation_notes`

---

## 9) Old schema → v5.1 mapping (compatibility plan)

| Legacy concept | v5.1 target | Notes |
|---|---|---|
| Namespace-only memory key | `project_id` + optional namespace tags | Move to project-first partition |
| Path without stable file key | `file_id` + `relative_path` | Deterministic file identity |
| Ad-hoc chunk UUID | deterministic `chunk_id` | Stable by semantic location |
| Symbol text-only refs | `symbol_id` + `symbol_fqn` | Enables graph joins |
| Task notes without lineage links | `task_registry` + task graph edges | Parent/related/touches queryable |
| Soft delete missing | `active` + `tombstone_at` | Tombstone-first lifecycle |
| Index run logs without health state | `index_runs.state` + `file/chunk/symbol index_state` | Fresh/stale/error observability |
| Tracker fields dispersed | `project_tracker_mappings` | Canonical Jira/GitHub/other mapping |

Migration implementation rule:
- Dual-read during migration window.
- v5.1 canonical write; optional compatibility shadow write if rollout flag enabled.

---

## 10) Acceptance criteria coverage

- Stable IDs for project/file/chunk/symbol/task links: **Sections 2, 4, 5** ✅
- Semantic metadata (`project_id`, `relative_path`, `language`, `module`, `symbol_name`, `commit_sha`, `checksum`, `schema_version`, `indexed_at`): **Section 3.2 + 4** ✅
- Search scope by path/module: **Sections 3.4, 4.2** ✅
- Tombstone/deactivate fields: **Sections 3.2, 4, 5, 6** ✅
- Fresh/stale/error state: **Sections 3.2, 4, 6** ✅
- Task lineage schema: **Sections 4 (`task_registry`), 5, 7** ✅
- Project alias/tracker mapping fields (`project_name`, `project_alias`, `tracker_type`, `tracker_space_key`, `tracker_project_id`, `default_epic_key`, `active_version`, `board_key`, `repo_remote`, `repo_root`): **Sections 4.1, 8** ✅
- Old schema → new schema mapping: **Section 9** ✅
- Registration completeness/validation state: **Sections 4.1 (`project_registration_state`), 8** ✅

---

## 11) Implementation boundary note

This story defines canonical schema contracts only (code-light). Runtime migration scripts and production wiring are handled by follow-up implementation tasks under ASM-69 execution lane.
