# ASM-139 — ASMv2 Phase 3 QMD Storage + Migration Architecture (Final)

## 0) Scope and decision lock

This document is the **final Phase-3 architecture packet** for bead `agent-smart-memo-r4t.19`.

Premises locked by source-of-truth Phase-2 work:

- r4t.15 bootstrap-safe raw-first
- r4t.16 same-agent isolated continuation + structured fallback
- r4t.17 deterministic apply layer + explicit loop guards
- r4t.18 drafts/promotion gate/briefing-first refinement

Phase-3 objective is **how to use QMD**, not whether to use QMD.

---

## 1) Current-state diagnosis

### 1.1 Current behavior

Current storage/retrieval is Markdown file-backed and scans whole trees:

- Wiki write path is markdown-oriented (`writeMarkdownFile`, `writeWikiMemoryCapture`) and always writes `raw`, then `draft` or `live` + `briefing` by `promotionState` (`src/core/usecases/semantic-memory-usecase.ts:347-758`).
- Search loads **all** files under `briefings`, `live`, and `drafts` via recursive walk (`walkMarkdownFiles` + `loadWikiDocuments`) (`src/core/usecases/semantic-memory-usecase.ts:761-846`).
- Default memory tools and recall use this wiki search path (`src/tools/memory_search.ts:148-159`, `src/hooks/auto-recall.ts:695-770`).

### 1.2 Why performance degrades

- Retrieval cost scales with markdown file count due to directory traversal + full file reads before ranking (`src/core/usecases/semantic-memory-usecase.ts:761-845`).
- Briefings are regenerated after live writes by reading/sorting all entries in the live file (`src/core/usecases/semantic-memory-usecase.ts:658-684`).
- Raw capture is append-only and unbounded in current layout (`src/core/usecases/semantic-memory-usecase.ts:711-731`).

### 1.3 Guarantees that must not regress

- No same-session distill primitive regression: isolated continuation remains mandatory (`src/hooks/auto-capture.ts:718-734`).
- Deterministic apply + loop guards remain mandatory (`src/core/usecases/distill-apply-usecase.ts:42-47, 141-146, 178-185, 222-224, 263-266`; `src/hooks/auto-capture.ts:1131-1135`).
- Raw is non-canonical for recall by default (already encoded in prior design and behavior).

---

## 2) Final storage architecture decision

### 2.1 Decision summary (explicit, final)

| Mandatory decision              | Final decision                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Raw uses QMD?                   | **YES**                                                                        |
| Drafts uses QMD?                | **YES**                                                                        |
| Live uses QMD?                  | **YES**                                                                        |
| Briefings uses QMD?             | **YES**                                                                        |
| Canonical retrieval truth layer | **LIVE QMD**                                                                   |
| Default search reads drafts?    | **NO** (opt-in only)                                                           |
| Default search excludes raw?    | **YES**                                                                        |
| Final shard strategy            | **Layer-aware deterministic shard keys + catalog-indexed candidate retrieval** |
| Migration style                 | **Incremental cutover**                                                        |
| Dual-read / dual-write needed?  | **Dual-read YES (temporary), Dual-write NO**                                   |

### 2.2 Core design

Adopt **QMD as canonical wiki storage format** for all layers.

Definition in ASMv2:

- QMD = markdown-compatible content with strict machine frontmatter + deterministic entry blocks + `.qmd` extension.
- Same semantic model as current wiki memory, but with shard contracts + retrieval catalog so search does not recursively scan all files.

---

## 3) Layer-by-layer mapping (raw / drafts / live / briefings)

## 3.1 Raw layer (QMD = yes)

Purpose:

- Forensic append log and bootstrap-safe capture sink.
- Not canonical recall truth.

Write behavior:

- Always append on any capture/apply event.
- No promotion required to enter raw.

Read behavior:

- Excluded from default `memory_search` and default `auto-recall`.
- Available only with explicit `includeRaw=true` (debug/forensic flows).

## 3.2 Drafts layer (QMD = yes)

Purpose:

- Intermediate refinement space before live truth.

Write behavior:

- Upsert when promotion state is `raw` or `draft`.

Read behavior:

- Excluded from default search/recall.
- Included only when caller sets `includeDrafts=true`.

## 3.3 Live layer (QMD = yes)

Purpose:

- Canonical semantic recall truth layer.

Write behavior:

- Upsert when promotion state is `distilled` or `promoted`.
- Deterministic ID, deterministic ordering preserved.

Read behavior:

- Primary semantic retrieval layer for memory search and recall.

## 3.4 Briefings layer (QMD = yes)

Purpose:

- Short injection-oriented distilled view derived from live.

Write behavior:

- Materialized/refresh from live updates (top-k deterministic summary).

Read behavior:

- Read-first for cheap context injection, but non-canonical versus live.

---

## 4) QMD schema (frontmatter + body shape)

## 4.1 File-level frontmatter

```yaml
---
qmd_version: 1
schema_version: memory_foundation_v1
layer: live # raw | drafts | live | briefings
namespace: agent.assistant.working_memory
memory_scope: agent
memory_type: episodic_trace
source_agent: assistant
session_id: agent:assistant:telegram:direct:5165741309
user_id: "5165741309"
page_key: entities/assistant/5165741309
shard_key: live:agent.assistant.working_memory:entities/assistant/5165741309
shard_seq: 0
entry_count: 37
time_from: 2026-04-08T00:00:00.000Z
time_to: 2026-04-08T06:30:00.000Z
updated_at: 2026-04-08T06:30:00.000Z
---
```

## 4.2 Entry block body contract

Keep current deterministic marker pattern (for compatibility and low-risk migration), with required fields:

```markdown
# Assistant Working Memory (Live)

<!-- ASM-MEMORY-START:9f02d2d8fa2c1b73 -->

timestamp: 2026-04-08T06:30:00.000Z
namespace: agent.assistant.working_memory
source_type: auto_capture
memory_scope: agent
memory_type: episodic_trace
promotion_state: distilled
confidence: 0.84
sessionId: agent:assistant:telegram:direct:5165741309
userId: 5165741309
text:
Finalized deterministic apply loop-guard constraints for Phase 3 rollout.

<!-- ASM-MEMORY-END:9f02d2d8fa2c1b73 -->
```

## 4.3 Catalog sidecar (required)

Add machine catalog file: `memory/wiki-qmd/catalog.json`.

Minimum per-shard index fields:

- `shard_key`
- `path`
- `layer`
- `namespace`
- `session_id`
- `user_id`
- `entry_count`
- `time_from`
- `time_to`
- `updated_at`
- `token_hints` (short lexical hints for prefilter)

Retrieval must use this catalog first; no full-tree blind scan by default.

---

## 5) Final shard strategy

Deterministic shard key:

`{layer}:{namespace}:{page_key}:{bucket}`

Where:

- `page_key` = stable canonical page identity (project/concept/entity grouping).
- `bucket` = layer-specific bucket.

Bucket policy:

- `raw`: monthly bucket (`YYYY-MM`) with rollover.
- `drafts`: monthly bucket (`YYYY-MM`) with rollover.
- `live`: `stable` bucket (identity shard; rollover only by size/entry ceiling).
- `briefings`: `stable` bucket (single active shard per page key).

Rollover thresholds (hard limits):

- `max_entries_per_shard = 200`
- `max_bytes_per_shard = 256KB`

If limit exceeded, create next shard sequence (`shard_seq + 1`) under same `shard_key`.

---

## 6) Retrieval model (final)

Retrieval precedence remains:

1. SlotDB runtime state
2. canonical project index for project/code-aware truth
3. QMD semantic memory

QMD semantic retrieval order:

1. briefing shards (candidate prefilter via catalog)
2. live shards (candidate prefilter via catalog)
3. drafts only if `includeDrafts=true`
4. raw only if `includeRaw=true`

Default policy:

- `includeDrafts = false`
- `includeRaw = false`

Scoring/ranking:

- Keep existing lexical + policy scoring stack and scope guards.
- Preserve deterministic tie-break (score desc -> timestamp desc -> id asc).

---

## 7) Promotion model (final)

Promotion state routing (authoritative):

- `raw` -> write to `raw` + upsert `drafts`
- `draft` -> write to `raw` + upsert `drafts`
- `distilled` -> write to `raw` + upsert `live` + refresh `briefings`
- `promoted` -> write to `raw` + upsert `live` + refresh `briefings`

Invariants:

- Promotion is still applied by deterministic apply path.
- Distill/apply loop guards and metadata (`autoCaptureSkip`, `internalLifecycle=distill_apply`) are unchanged.
- No same-session direct distill event primitive is introduced.

---

## 8) Growth-control policy

## 8.1 Retention

- `raw`: active 30 days; archive 180 days; beyond 180 days prune.
- `drafts`: TTL 21 days without promotion; then archive to raw-summary entry and delete from drafts.
- `live`: no TTL (canonical memory truth), but compaction enabled.
- `briefings`: keep latest + previous version only.

## 8.2 Compaction

- Trigger compaction when shard exceeds `200 entries` or `256KB`.
- Compaction is deterministic: merge duplicate IDs, keep latest timestamp block, preserve first-seen timestamp in provenance metadata.
- Compaction must never bypass loop guards or write through same-session distill primitive.

## 8.3 File-count discipline

- Retrieval must rely on `catalog.json`; no recursive walk of all shards in normal path.
- New shard creation must update catalog atomically with shard write.

---

## 9) Migration plan (MD -> QMD)

Migration style: **incremental cutover**.

## 9.1 Compatibility policy

- **Dual-read: YES (temporary).**
  - Read order: QMD first; if no result and migration flag active, fallback to legacy md.
- **Dual-write: NO.**
  - Once QMD writer is enabled for a lane, writes go QMD-only.

Rationale:

- Dual-write increases drift and I/O load.
- Dual-read gives safe transition while backfilling historical md data.

## 9.2 Migration stages

### Stage A — Introduce QMD backend behind feature flag

- Add `wiki_storage_backend` flag (`md` | `qmd` | `dual_read_qmd_first`).
- Keep behavior parity with existing ID, promotion routing, and loop guards.

### Stage B — Backfill existing markdown into QMD

- Parse legacy md entries by existing markers.
- Generate canonical `page_key` and shard assignments.
- Write QMD shards + catalog.
- Emit migration report: counts by layer, namespace, page_key, errors.

### Stage C — Enable runtime QMD writes

- Switch runtime write paths to QMD.
- Keep dual-read fallback to md for a bounded window.

### Stage D — Disable md reads and finalize cutover

- Require parity checks pass for recall regression suite.
- Set backend to `qmd` only.
- Legacy md becomes archive/read-only.

---

## 10) Implementation plan / impacted files / rollout order

## 10.1 Primary impacted files

- `src/core/usecases/semantic-memory-usecase.ts`
  - Replace markdown walk/write internals with QMD store + catalog-backed retrieval.
- `src/core/usecases/distill-apply-usecase.ts`
  - Keep deterministic apply semantics; route writes through QMD backend.
- `src/hooks/auto-capture.ts`
  - No distill primitive changes; ensure write path calls remain deterministic and guarded.
- `src/hooks/auto-recall.ts`
  - Use QMD retrieval defaults (`includeDrafts=false`, `includeRaw=false`).
- `src/tools/memory_search.ts`
  - Add explicit `includeDrafts/includeRaw` params; default false.
- `src/tools/memory_store.ts`
  - Route to QMD writer, preserve namespace/noise routing.
- `tests/test-semantic-memory-usecase.ts`
  - Add QMD schema, shard rollover, default draft/raw exclusion tests.
- `tests/test-cognitive-memory.ts`
  - Add regression checks for loop guard invariants under QMD.

Likely new files:

- `src/core/usecases/qmd-store.ts`
- `src/core/usecases/qmd-catalog.ts`
- `src/scripts/migrate-wiki-md-to-qmd.ts`
- `tests/test-qmd-migration.ts`

## 10.2 Rollout order

1. Add QMD store + catalog abstractions (no behavior change yet).
2. Wire semantic-memory write path to QMD backend with feature flag.
3. Wire search/recall to catalog-backed QMD query path; default exclude raw/drafts.
4. Add md->qmd migration script + report artifact.
5. Run dual-read validation window.
6. Cutover to qmd-only read/write.

---

## 11) Open risks / non-goals

## 11.1 Open risks

- Catalog drift risk if shard write succeeds but catalog update fails (must be atomic/retriable).
- Migration parsing risk for malformed legacy markdown entries.
- Ranking drift risk when changing candidate prefilter from full scan to catalog shortlist.

## 11.2 Non-goals (explicit)

- No runtime packaging/install/resync implementation in this phase.
- No changes to SlotDB truth model.
- No changes to canonical project-index truth model.
- No reintroduction of same-session direct distill event primitive.
- No claim that raw is canonical recall truth.

---

## 12) Acceptance mapping to bead r4t.19

This packet explicitly fixes:

- final QMD role and storage decisions
- exact raw/drafts/live/briefings mapping
- canonical retrieval truth + default inclusion/exclusion rules
- deterministic shard strategy
- concrete growth-control rules
- explicit incremental migration architecture with dual-read/no-dual-write
- implementation impact list and ordered rollout for follow-up runtime beads
