# ASM-70 — [ASM v5.1] Master architecture spec for Project Memory

> Issue: ASM-70 (child of ASM-69)
> Strategy: `doc_only`
> Scope: Master architecture specification for project-aware memory in agent workflows.

## 1) Operational positioning (định vị vận hành)

ASM Project Memory v5.1 is **agent-facing engineering memory**, not an end-user Q&A bot.

Primary objective:
- Give orchestrator/research/coding lanes accurate, project-scoped context retrieval.
- Reduce “re-read codebase from scratch” cycles.
- Reduce context drift across multi-step implementation.
- Preserve task/code lineage for better planning, execution, and audits.

Non-goals:
- Not a generic workspace chat search layer.
- Not replacing source-of-truth tools (git/Jira) — it augments them.

---

## 2) Why `project_id`-centric (instead of workspace abstraction)

### Decision
ASM v5.1 chooses **`project_id` as first-class identity** for memory partitioning and retrieval.

### Rationale
1. **Stable engineering anchor**
   - Workspace labels can be transient (temporary folders, renamed contexts).
   - `project_id` is durable across sessions, agents, and runtime boundaries.

2. **Cross-lane consistency**
   - Orchestrator, research lane, and coding lane can share one canonical routing key.

3. **Cleaner policy & isolation**
   - Scope/filter, ACL, indexing state, and migrations are deterministic per project.

4. **Tracker mapping fit**
   - External systems (Jira/Git) naturally map to project-level identity.

### Compatibility stance
- Workspace-like inputs remain accepted at UX/command layer.
- They are resolved to canonical `project_id` through alias resolution before retrieval/indexing.

---

## 3) Memory model: conversation memory vs project memory

## 3.1 Conversation memory
- Granularity: run/session/turn/tool-call.
- Purpose: short-lived interaction continuity.
- Typical TTL/retention: shorter horizon, high write frequency.
- Retrieval use: immediate contextual grounding.

## 3.2 Project memory
- Granularity: code blocks, docs, symbols, task relations, historical decisions.
- Purpose: durable engineering intelligence tied to project identity.
- Retention: long-lived, migration-aware.
- Retrieval use: planning, implementation, debugging, architectural recall.

## 3.3 Interaction contract
- Conversation memory can reference project memory IDs.
- Project memory should not depend on ephemeral session IDs to stay valid.

---

## 4) `project_id` lifecycle and identity rules

## 4.1 Identity entities
- `project_id` (canonical internal key)
- `project_name` (human label)
- `project_alias[]` (short names/legacy names)
- `repo_root` (local path)
- `repo_remote[]` (git remotes)

## 4.2 Lifecycle
1. **Register**: create project record with minimal identity.
2. **Link**: attach repo + optional tracker mapping.
3. **Index bootstrap**: initial ingest + semantic parse.
4. **Operate**: incremental updates + retrieval.
5. **Evolve**: alias/remote/version updates.
6. **Archive**: read-only or frozen state if needed.

## 4.3 Invariants
- `project_id` immutable after creation.
- Aliases are mutable but unique within tenant/runtime boundary.
- `repo_root` must resolve to a normalized absolute path.
- Multiple remotes allowed; one may be marked primary.

---

## 5) High-level architecture (control plane + data plane)

## 5.1 Components
1. **Registration & Alias Service**
   - Resolves input (`project_name`/alias/path/remote) => canonical `project_id`.

2. **Code Ingestion Pipeline**
   - File filtering -> semantic block extraction -> embedding -> index write.

3. **Metadata/Control Plane (SQLite)**
   - Stores project catalog, index jobs, ingest manifests, lineage metadata, mappings.

4. **Semantic Index (Qdrant)**
   - Vectorized searchable units with metadata payload.

5. **Graph Index (symbol/task relations)**
   - Symbol dependencies, task links, and code touch graph for traversal queries.

6. **Retrieval Orchestrator**
   - Executes hybrid retrieval for `codebase_search`, `project_search`, `task_search`.

---

## 6) Parsing and chunking model (semantic blocks)

## 6.1 Extraction approach
- Prefer Tree-sitter (or equivalent parser) per language.
- Segment code by semantic units:
  - module/file header
  - class/interface/struct
  - function/method
  - exported symbol blocks
  - config/schema blocks
  - meaningful doc sections

## 6.2 Chunk sizing rules
- Target chunk token window tuned for retrieval quality (not fixed by file lines only).
- Keep semantic integrity first; split only when exceeding max token policy.
- Add overlap only at semantic boundaries to preserve context continuity.

## 6.3 File filtering policy
- Include: source, config, docs relevant to engineering workflows.
- Exclude by default: build artifacts, lock/temp files, vendor caches, binary media.
- Honor project-level include/exclude overrides.

---

## 7) Storage architecture details

## 7.1 Qdrant semantic index
Each indexed unit stores:
- `vector`
- `project_id`
- `repo_root`
- `file_path`
- `module`
- `symbol_id` (if available)
- `chunk_type` (function/class/doc/etc.)
- `language`
- `hash`
- `indexed_at`
- `index_version`

## 7.2 SQLite metadata/control plane
Core tables (logical):
- `projects`
- `project_aliases`
- `project_repos`
- `index_jobs`
- `index_manifests`
- `index_health`
- `task_nodes`
- `task_edges`
- `code_touches`
- `external_tracker_mappings`

## 7.3 Graph index
Graph nodes:
- symbols, files/modules, tasks, commits (optional), decision notes.

Graph edges:
- `imports`, `calls`, `extends`, `touches`, `relates_to`, `blocks`, `depends_on`, `implements`.

---

## 8) Retrieval architecture (hybrid, not vector-only)

## 8.1 `codebase_search`
Goal: symbol/module-level code retrieval.

Flow:
1. Resolve `project_id`.
2. Apply scope filters (repo/path/module/language).
3. Hybrid candidate generation:
   - lexical/keyword match
   - graph neighborhood expansion (symbol relations)
   - vector similarity from Qdrant
4. Re-rank with weighted blend + recency + file importance.
5. Return grouped evidence (file/symbol/snippet) with provenance.

## 8.2 `project_search`
Goal: high-level project knowledge (architecture docs, decisions, key modules).

Flow uses broader doc/code mix and prioritizes canonical docs + key modules.

## 8.3 `task_search`
Goal: task lineage + implementation history retrieval.

Flow:
1. Resolve task references (ID/title/alias).
2. Traverse parent-child and related-task edges.
3. Join code touch history and relevant semantic chunks.
4. Return lineage timeline + impacted modules/symbols.

## 8.4 Scope/filter model (required)
All search APIs accept optional filters:
- `project_root`
- `path_prefix[]`
- `module[]`
- `language[]`
- `task_id[]`
- `time_range`
- `index_status` preference

---

## 9) Auto reindex flow

## 9.1 Initial ingest
- Full scan for registered project.
- Build baseline semantic + graph + metadata manifests.

## 9.2 Incremental ingest
- Triggered by file diff/change-set.
- Reindex only impacted files/symbol neighborhoods.
- Update manifests and graph edges incrementally.

## 9.3 On-demand enrich
- Manual/automatic targeted enrichment for “hot” modules/tasks.
- Useful when retrieval confidence is low or stale pockets detected.

## 9.4 Job orchestration notes
- Idempotent jobs by `(project_id, source_rev, index_profile)`.
- Dedup chunk writes by content hash + parser signature.

---

## 10) Index status / health model

Per project and per index profile:
- `indexing`: ingest job active.
- `indexed`: healthy + current.
- `stale`: known drift against repo/tracker state.
- `error`: ingest failure requiring operator or retry flow.

Health signals:
- last success timestamp
- stale ratio
- parser error ratio
- failed file count
- queue lag

---

## 11) Task lineage architecture

Required relations:
- Parent-child task hierarchy.
- Related/cross-linked tasks.
- Code touch history per task (files/symbols/change windows).

Primary use cases:
- Ask “what changed for this ticket family?”.
- Trace regressions to task clusters.
- Improve planning by reusing prior task trajectories.

---

## 12) Project alias + external tracker mapping

## 12.1 Alias resolution contract
Input may include any of:
- `project_id`
- `project_name`
- `project_alias`
- `repo_root`
- `repo_remote`

Resolution order (deterministic):
1. exact `project_id`
2. exact alias
3. exact normalized `repo_root`
4. remote match (`repo_remote`)
5. fuzzy name fallback (requires confidence threshold)

Ambiguity => fail with disambiguation candidates.

## 12.2 External tracker mapping model
Stored mapping fields:
- `tracker_type` (jira/github/other)
- `tracker_space_key`
- `tracker_project_id`
- `default_epic_key`
- `active_version`
- `board_key`

Purpose:
- unify task lineage across internal memory + external issue systems.

---

## 13) Backward compatibility and migration-first strategy

## 13.1 Compatibility rules
- Old-format memory records remain readable.
- Read path supports dual-format during migration window.
- Write path emits v5.1 canonical shape (with optional compatibility shadow write when enabled).

## 13.2 Migration-first rollout
1. Schema expansion (non-breaking).
2. Backfill project identity + alias mappings.
3. Reindex-by-project in waves.
4. Enable hybrid retrieval defaults.
5. Deprecate legacy retrieval routes after health gates pass.

## 13.3 Rollback principles
- Keep reversible migrations where possible.
- Preserve old reader until v5.1 stability threshold achieved.

---

## 14) Project registration UX / command layer

Minimum commands:
1. `add project`
2. `link jira`
3. `index project`

## 14.1 Command intent examples
- Add project with alias and repo root.
- Link tracker defaults (space/project/epic/board/version).
- Trigger initial or incremental indexing.

## 14.2 Minimal input contract from user/agent
At least one identity hint:
- `project_id` OR alias OR normalized `repo_root` OR `repo_remote`.

Optional enrichment:
- tracker mapping fields
- include/exclude path rules
- priority index profiles

---

## 15) Chat/Telegram execution guideline (inline buttons + short forms)

For constrained chat surfaces:
1. Use short forms with progressive disclosure.
2. Offer inline actions:
   - `Add project`
   - `Link Jira`
   - `Index now`
   - `Show health`
3. If alias resolution ambiguous, return top candidates as inline pick-list.
4. Keep one-step confirm before irreversible operations.

Recommended compact flow:
- Step A: identify project (ID/alias/path)
- Step B: optional Jira mapping
- Step C: indexing choice (full/incremental)
- Step D: status response (`indexing/indexed/stale/error`)

---

## 16) Acceptance criteria coverage matrix

- Project_id-centric justification: **Section 2** ✅
- Hybrid retrieval (not vector-only): **Section 8** ✅
- Scope/filter by root/path/module: **Section 8.4** ✅
- File filtering/chunk sizing/semantic extraction: **Section 6** ✅
- Task lineage architecture: **Section 11** ✅
- Alias resolution (`project_id`, `project_name`, `project_alias`, `repo_root`, `repo_remote`): **Section 12.1** ✅
- External tracker mapping fields: **Section 12.2** ✅
- Backward compatibility rules: **Section 13.1** ✅
- Migration-first strategy: **Section 13.2** ✅
- Registration UX/command layer (`add project`, `link jira`, `index project`): **Section 14** ✅
- Alias resolution + minimal input: **Sections 12.1, 14.2** ✅
- Chat/Telegram inline-button guideline: **Section 15** ✅

---

## 17) Final note

This document is the architecture source-of-truth for ASM-70 and is intentionally scoped as `doc_only`.
Implementation details, concrete schema migrations, and runtime wiring belong to subsequent execution stories under ASM-69 rollout plan.
