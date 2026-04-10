# ASM QMD vs MD Boundary Clarification

Date: 2026-04-10
Project: agent-smart-memo
Status: architecture clarification / source-of-truth update

## 1. Why this clarification is needed

Two architectural lines now coexist:

1. **r4t / Phase-3 QMD direction**
   - QMD was previously chosen as the storage direction for scaling, sharding, cataloging, and migration away from markdown explosion.
   - Decisions around raw/drafts/live/briefings and retrieval truth were made in the QMD architecture lane.

2. **r5t / wiki-first redesign**
   - The read path was redesigned so the agent reasons over a wiki-first working surface.
   - This naturally materializes as markdown/wiki pages because that is what the LLM can read directly and operate on effectively.

Without a clear boundary, the system risks becoming inconsistent:
- saying QMD is canonical while actually operating primarily on markdown,
- or abandoning the QMD direction implicitly without an explicit decision.

## 2. Clarified architectural principle

The system must distinguish **canonical storage** from **agent-facing working surface**.

### 2.1 Canonical storage layer
**QMD remains the canonical storage/backend layer** for the persistent wiki memory system.

QMD is responsible for:
- sharding and bucket rollover
- catalog/indexed storage
- growth control and compaction
- retrieval metadata and long-term storage semantics
- canonical persistence of raw/drafts/live/briefings memory layers

### 2.2 Agent-facing working surface
**Markdown (`memory/wiki/*.md`) is the agent-facing working surface**.

Markdown is responsible for:
- index-first navigation (`index.md`)
- page-level reading by the LLM
- canonical pages / rule pages / runbooks / task pages exposed in human/LLM-readable form
- interlinked wiki browsing and reasoning flow

### 2.3 Boundary rule
The system should be understood as:
- **QMD = storage/backend/canonical persistence layer**
- **MD = rendered/working-surface layer for agent reasoning**

This resolves the apparent contradiction:
- QMD can remain canonical storage
- Markdown can still be the primary reasoning surface the LLM reads

## 3. What is NOT allowed

1. Do not silently let markdown become the only effective canonical layer while still claiming QMD architecture.
2. Do not force the LLM to reason directly on low-level QMD shards/buckets when markdown working pages are the intended reasoning surface.
3. Do not collapse the distinction between storage truth and working-surface truth.

## 4. Correct end-to-end mental model

### Raw/write path
- auto-capture / continuation / apply write into canonical memory persistence path
- canonical persisted form is QMD-backed
- catalog + shards remain the authoritative backend

### Projection/materialization path
- from canonical QMD-backed storage, render/maintain markdown working pages under `memory/wiki/`
- markdown remains navigable, interlinked, and readable to both human and LLM

### Read/reasoning path
- agent reads markdown working surface (`index.md`, canonical pages, rules, runbooks, task pages)
- SlotDB adds structured current-state/living-state/context precedence
- Graph adds expansion/prioritization hints
- supporting recall remains supplementary only

## 5. Role of SlotDB and Graph after this clarification

### SlotDB
Still the structured control/state layer:
- current state
- project_living_state
- active task/focus/phase
- private/team/public precedence

### Graph
Still the support/routing layer:
- page/entity adjacency
- bounded expansion hints
- prioritization hints for working set construction

Neither SlotDB nor graph replaces the need for markdown working pages.
Neither should override the canonical storage role of QMD.

## 6. Immediate consequence for current implementation

The current state after `r5t` is acceptable only if we interpret it as:
- markdown is the **working surface**
- not the final storage truth

Therefore the next implementation direction must ensure:
1. QMD remains or becomes the canonical persisted layer.
2. Markdown pages are generated or maintained as the working surface on top of QMD-backed state.
3. Runtime/read-path documentation and implementation explicitly distinguish these layers.

## 7. What needs to be corrected next

The system now needs a follow-up implementation lane to make the boundary concrete:

### A. Storage truth confirmation
- confirm which QMD structures are canonical for raw/drafts/live/briefings
- confirm markdown is projected/derived working surface

### B. Projection/materialization contract
- define when/how markdown working pages are refreshed from canonical state
- define whether markdown is fully derived, partially derived, or co-maintained with guardrails

### C. Read-path contract update
- runtime contract should explicitly describe markdown as working surface and not imply it is the only storage truth

### D. Verification
- prove that the system is not merely "using markdown again"
- prove QMD still matters operationally as canonical persistence/backend layer

## 8. Final clarified conclusion

The correct architecture is:
- **QMD is the canonical persistent storage/backend**
- **Markdown under `memory/wiki/` is the agent-facing working surface**
- **SlotDB is the state/control layer**
- **Graph is the support/routing layer**

This preserves both:
- the scaling/storage goals of the earlier QMD architecture
- the wiki-first reasoning pattern required by `llm-wiki.md`

Any future implementation and verification should treat this file as the boundary clarification source-of-truth unless superseded explicitly.
