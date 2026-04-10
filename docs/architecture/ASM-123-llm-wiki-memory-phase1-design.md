# ASM-123 — LLM Wiki Memory Phase 1 Design

> **Historical note (2026-04-09, bead agent-smart-memo-r4t.26):** Paperclip support was removed from active ASM runtime/package/test surfaces. Any Paperclip references below are archived design history, not current supported runtime behavior.

## 1) Goal

Phase 1 replaces **Qdrant-based semantic memory** with **LLM Wiki markdown memory** while keeping these parts unchanged:

- `SlotDB` = runtime/operational state truth
- canonical project index = project/code-aware truth

Target outcomes:

- remove vector DB dependency from primary memory path
- keep multi-agent recall practical (not perfect semantic search parity)
- keep project-aware answers grounded in existing index pipeline
- make long-term memory human-readable/editable (`memory/wiki`)

---

## 2) Why replace Qdrant in ASM (and what not to replace)

### Replace

Current semantic path is:

- `auto-capture` / `memory_store` -> embed -> Qdrant upsert
- `memory_search` / `auto-recall` -> embed query -> Qdrant search

Pain points for this layer:

- operational overhead (Qdrant + embedding availability)
- lower inspectability for humans vs markdown pages
- difficult manual correction loops for evolving project understanding

### Do **not** replace

- `SlotDB` short-term deterministic state
- canonical project index (registry, source_rev, related_files, subsystem facts, provenance)

> Rule: wiki memory is **supporting semantic context**, not canonical project facts.

---

## 3) ASM current architecture mapping

### 3.1 SlotDB (unchanged)

Use for deterministic runtime state:

- `current-state`
- `project_living_state`
- recent updates, dedupe/runtime flags, cursors/pending metadata

### 3.2 Canonical project index (unchanged)

Use for code-aware/project-aware truth:

- registry + source revision provenance
- file/subsystem/related-files/feature-pack enrichment

### 3.3 Semantic memory (replaced in phase 1)

Current main touchpoints:

- `src/hooks/auto-capture.ts`
- `src/hooks/auto-recall.ts`
- `src/tools/memory_search.ts`
- `src/tools/memory_store.ts`
- `src/core/usecases/semantic-memory-usecase.ts`
- `src/services/qdrant.ts`
- `src/services/embedding.ts`

New target: wiki-backed memory layer under `memory/wiki`.

---

## 4) Phase 1 boundary

### Minimalism lock (must hold for phase 1)

- Keep runtime memory loop to exactly: `raw -> live -> briefing`.
- Do not add draft/review/approval workflow layers.
- Do not introduce new storage engines (vector DB replacement only = markdown wiki).
- Do not expand taxonomy beyond `projects | concepts | entities` unless a blocker is proven.

### In scope

- replace Qdrant primary memory read/write path with wiki flow
- keep retrieval precedence: state first -> project facts first (if needed) -> wiki
- keep design minimal: `raw -> live -> briefing`

### Out of scope

- replacing project index with markdown
- making Obsidian a runtime dependency
- heavyweight lifecycle/workflow framework
- exact vector-search parity in phase 1

### Boundary invariants (non-negotiable)

1. `SlotDB` remains the deterministic runtime state source.
2. Canonical project index remains code/project truth source.
3. Wiki memory is supporting semantic context only.
4. Wiki content cannot overwrite or supersede canonical project-index facts.

---

## 5) Folder contract (`memory/wiki`)

```text
memory/wiki/
  raw/
  live/
  briefings/
  index.md
  log.md
  schema.md
```

### `raw/`

- append-oriented captured inputs/tool outputs/session snippets
- forensic/debug friendly
- not default recall source

### `live/`

- canonical wiki memory pages for recall
- examples:
  - `live/projects/<project>.md`
  - `live/concepts/<topic>.md`
  - `live/entities/<entity>.md`

### `briefings/`

- short context packs for injection
- examples:
  - `briefings/project-<name>.md`
  - `briefings/agent-<name>.md`

### `index.md`

- catalog of pages + short purpose

### `log.md`

- timeline of capture/merge/correction/promotion events

### `schema.md`

- minimum naming/section/merge conventions

---

## 6) Page contract (minimal)

### Project page (`live/projects/*.md`)

- project understanding summary
- key decisions
- lessons/pitfalls

### Concept page (`live/concepts/*.md`)

- reusable runbook/lesson/decision knowledge

### Entity page (`live/entities/*.md`)

- stable preferences or named reusable context

### Briefing page (`briefings/*.md`)

- short, actionable context for current agent execution

> Keep taxonomy intentionally small in phase 1.

---

## 7) Capture flow (phase 1)

Old:

```text
capture -> embed -> qdrant upsert
```

New:

```text
capture -> raw page -> LLM distill/merge -> live page -> refresh briefing
```

Concrete sequence:

1. Input arrives (hook/tool/manual store).
2. Append/materialize into `raw/`.
3. Distill against `schema.md` + existing related `live/` page.
4. Create/update canonical `live/` page.
5. Update `index.md` and append `log.md`.
6. Rebuild affected `briefings/` (only when needed).

Rules:

- prefer merge into existing canonical page over page explosion
- no mandatory draft layer in phase 1
- no asynchronous workflow requirement in phase 1 (single synchronous path is acceptable)

---

## 8) Retrieval flow (phase 1)

Old primary:

```text
query -> embed -> qdrant search
```

New primary:

```text
query -> SlotDB/state -> project index (if code-aware) -> briefing/index/live -> synthesis
```

Retrieval order:

1. **SlotDB first** for current runtime context.
2. **Canonical project index first** for project/code-aware queries.
3. **Wiki briefings/index/live** for summary/lesson/decision memory.

Guardrails:

- wiki cannot override canonical project facts
- `raw/` is not default recall
- `briefings/` is short-form, `live/` is long-form
- if SlotDB or project index already answers the query, skip wiki lookup

Search strategy (phase 1):

- start with relevant briefing(s)
- use `index.md` to select candidate pages
- read selected `live/` pages
- synthesize concise answer

---

## 9) Migration rule from Qdrant

Apply migration to **memory layer only**.

Do not migrate to wiki as canonical truth for:

- project registry
- project index artifacts
- source_rev / file-tree / subsystem facts

Hard rule:

- **Never** map 1 vector point = 1 markdown file.
- Group by canonical destination page:
  - session summaries -> grouped session/day pages
  - lessons/runbooks -> concept pages
  - stable preferences/context -> entity/project pages

Rollout:

1. parallel write
2. wiki-first read
3. final cutover (keep Qdrant backup)

Phase-1 cutover note:

- primary semantic read/write runtime path becomes wiki-only at cutover
- Qdrant may remain temporarily only as backup/export compatibility during the rollback window, not as the primary semantic runtime path

---

## 10) Obsidian role

Obsidian is:

- viewer/editor/search/graph for human workflow

Obsidian is not:

- runtime engine
- replacement for `SlotDB`
- replacement for canonical project index

---

## 11) Implementation touchpoints (phase 1)

Primary code areas to patch in later beads (minimal deltas):

- `src/hooks/auto-capture.ts`
  - reroute semantic capture from `embed -> qdrant upsert` to `raw -> distill -> live -> briefing refresh`.
  - remove legacy `injectMemoryContext` long-term semantic fallback (`embed + qdrant search`) so auto-capture context injection remains SlotDB short-term + mid-term only.
- `src/hooks/auto-recall.ts`
  - reroute semantic recall from qdrant search to `briefings/index/live` selection.
- `src/tools/memory_search.ts`
  - replace vector query path with wiki retrieval path (briefings first, then index+live pages).
- `src/tools/memory_store.ts`
  - replace vector upsert path with wiki materialization path (`raw` append + `live` merge).
- `src/core/usecases/semantic-memory-usecase.ts`
  - replace embedding/qdrant internals with wiki-backed read/write orchestration.
- `src/db/slot-db.ts`
  - no semantic-memory rewrite; boundary checks only.
- `src/adapters/openclaw/plugin-register.ts`
  - wire updated tools/hooks without changing SlotDB/project-index boundaries.
- `src/adapters/paperclip/runtime.ts`
  - ensure runtime wiring uses new wiki memory path.
- `src/services/qdrant.ts`, `src/services/embedding.ts`
  - migration/fallback-only window, then removable from primary path.

Implementation guardrails for patch authors:

- Do not change SlotDB schema/role to carry wiki long-term pages.
- Do not route project-index canonical facts into wiki as authoritative replacements.
- Keep the first shipping path simple and deterministic; optimize relevance in later phases.

---

## 12) Definition of Done (design bead)

This design bead is done when:

- phase-1 boundary is explicit (replace memory only)
- folder/page contracts are explicit and actionable
- capture/retrieve flows are explicit and minimal
- migration grouping rule is explicit (no 1-point=1-file)
- Obsidian is explicitly viewer/editor-only

---

## 13) Recommended execution order

1. `agent-smart-memo-r4t.1` finalize this design
2. `agent-smart-memo-r4t.2` + `.5` migration/export groundwork
3. `agent-smart-memo-r4t.3` retrieve path rewrite
4. rewire store/capture from Qdrant -> wiki
5. `agent-smart-memo-r4t.4` Obsidian docs/setup

---

This document is intentionally phase-1 minimal and should be preferred over broader designs unless implementation pressure proves otherwise.
