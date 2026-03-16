# Deterministic Developer Search Hardening Roadmap (Post ASM-96)

Date: 2026-03-16
Source epic completed baseline: `ASM-96`
Repo: `/Users/mrcagents/Work/projects/agent-smart-memo`

## Why this roadmap exists

`ASM-96` delivered a usable code-aware project RAG backbone for development navigation:
- code-aware indexing
- graph linking baseline
- feature-pack memory
- change-aware overlay
- developer query path

What remains is not backbone creation, but **hardening the developer search experience** so it becomes sharper, more deterministic, and more action-oriented without depending on LLM retrieval.

## Target state

Move from:
- usable backbone

to:
- deterministic developer search engine with stronger query interpretation, intent-specific retrieval, broader coverage, and developer-grade answer assembly.

## Workstreams

### H1 — Typed Query Parser
Goal:
- Parse developer queries into deterministic intents and selectors.

Deliverables:
- typed query intent model
- selector extraction for symbol/file/route/feature/task/issue
- parser benchmark for representative developer queries

Initial intents:
- `locate_symbol`
- `locate_file`
- `trace_flow`
- `impact_analysis`
- `feature_lookup`
- `change_lookup`

Success criteria:
- parser deterministically classifies and extracts selectors for benchmark query set
- improves routing quality for non-exact text queries

---

### H2 — Per-intent Retrieval Plans
Goal:
- Replace one-size-fits-all retrieval with specialized execution plans per intent.

Deliverables:
- source-priority rules per intent
- intent-specific ranking features
- deterministic execution planners

Examples:
- `locate_symbol` → symbol > chunk(symbol-anchored) > file > doc
- `trace_flow` → graph path > related files/symbols > feature packs > docs
- `impact_analysis` → change overlay > graph adjacency > feature packs > files/symbols

Success criteria:
- improved quality on benchmark query families without adding non-deterministic retrieval logic

---

### H3 — Coverage Expansion
Goal:
- Improve extraction/graph/change coverage so quality comes from richer facts, not heuristic score hacks.

Deliverables:
- better route extraction
- better cron/job extraction
- event producer/consumer coverage
- stronger imported symbol resolution
- feature alias registry
- stronger commit/PR/task linking coverage

Success criteria:
- more query types resolve to concrete code objects and relation paths
- reduced doc-first fallback on code/flow questions

---

### H4 — Deterministic Answer Assembly
Goal:
- Make outputs developer-actionable without LLM synthesis.

Deliverables:
- response templates per intent
- explainability fields (`why_this_result`, `assembly_sources`, `confidence.reason`, `gaps[]`)
- stable ordering / dedup / top-N rules

Success criteria:
- answers are easier to act on: what to open, what depends on it, what may break, what to test next

## Recommended sequence

### Wave 1
- H1 Typed Query Parser
- strengthen `locate` + `feature` paths first

### Wave 2
- H2 Per-intent Retrieval Plans
- begin H3 coverage upgrades for graph-heavy paths

### Wave 3
- deeper H3 coverage expansion
- H4 Deterministic Answer Assembly

## Proposed next-epic structure

### Epic title
- `[ASM] Deterministic Developer Search Hardening after ASM-96`

### Suggested child tasks
1. Typed query parser for developer search
2. Per-intent retrieval plans
3. Coverage expansion for route/job/event/import/change mapping
4. Deterministic answer assembly and benchmark hardening

## Relationship to ASM-96

This roadmap is a **hardening/expansion line after ASM-96**, not a statement that ASM-96 failed.

`ASM-96` remains the backbone foundation.
This roadmap builds on that foundation to reach a stronger developer search experience.
