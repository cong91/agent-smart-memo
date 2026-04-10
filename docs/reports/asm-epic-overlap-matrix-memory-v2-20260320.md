# ASM Epic Overlap Matrix for Memory v2 (2026-03-20)

## Scope reviewed
- ASM-122 — Memory v2
- ASM-69 — Project-Aware Memory Upgrade
- ASM-96 — Code-Aware Project RAG
- ASM-105 — ASM SDK / CLI-first shared memory platform
- ASM-108 — Deterministic Developer Search Hardening
- ASM-86 — Deep Project Understanding Upgrade
- ASM-97 — Skills Operating Layer

Excluded in this round:
- ASM-5
- ASM-90

---

## Executive summary

ASM currently has multiple completed or partially-completed epics that each evolved a different layer of the memory/retrieval stack:
- ASM-86 established the need for deeper project understanding beyond file-level indexing.
- ASM-69 became the main project-aware memory backbone (project_id-centric schema, ingest, registry, hybrid retrieval, migration, task lineage).
- ASM-96 extended that backbone into code-aware project RAG for development navigation.
- ASM-108 continues search hardening toward deterministic developer search UX.
- ASM-105 productizes the platform as CLI-first shared memory / multi-runtime SDK.
- ASM-97 is an operating layer epic; it depends on memory quality but is not itself the source of truth for memory architecture.
- ASM-122 should become the source of truth for unified memory foundation v2: scope/layer policy, retrieval ranking policy, promotion pipeline, precedence rules, and migration contract across SlotDB / semantic memory / graph/context.

Core portfolio conclusion:
- ASM-122 should **absorb/supersede the memory-governance part of ASM-69**.
- ASM-122 should **build on top of ASM-96** rather than replace it.
- ASM-122 should **provide foundation contracts consumed by ASM-108 and ASM-105**.
- ASM-86 is a conceptual predecessor; ASM-97 is an operational consumer.

---

## Matrix: overlap / dependency / source-of-truth

| Epic | Primary layer | Status reality | Overlap with ASM-122 | Dependency relation | Source-of-truth after alignment |
|---|---|---:|---|---|---|
| ASM-86 | Deep project understanding intent | Done | Medium (conceptual) | Predecessor intent only | ASM-86 remains historical intent / problem framing |
| ASM-69 | Project-aware memory backbone | In Progress, many child items done | Very high | ASM-122 should absorb memory-governance aspects from ASM-69 | ASM-122 for memory foundation policy; ASM-69 remains ingest/project/index backbone |
| ASM-96 | Code-aware project RAG backbone | Done | Medium | ASM-122 builds on top of ASM-96 | ASM-96 remains source of truth for code-aware retrieval backbone |
| ASM-105 | CLI-first shared memory platform / SDK | To Do, but has done child tasks | Medium | ASM-105 should consume memory contracts from ASM-122 | ASM-105 remains source of truth for packaging / CLI / multi-runtime platformization |
| ASM-108 | Deterministic developer search hardening | To Do | Medium-high (retrieval ranking / search behavior) | ASM-108 should depend on ASM-122 retrieval policy | ASM-108 remains source of truth for developer search parser / deterministic UX |
| ASM-97 | Skills operating layer | Done | Low | Consumer of improved memory/recall quality | ASM-97 remains source of truth for skills/operating layer |
| ASM-122 | Unified Memory Foundation v2 | New | N/A | Central alignment epic | ASM-122 should be source of truth for unified memory foundation |

---

## Epic-by-epic notes

### ASM-86 — Deep Project Understanding Upgrade
**What it solved**
- Moved ASM from shallow file/watch memory toward deeper project understanding.
- Verified runtime indexing + symbol extraction + semantic block retrieval on a real repository.

**How ASM-122 relates**
- ASM-122 does not replace ASM-86.
- ASM-86 is the conceptual predecessor that proved deeper understanding matters.
- ASM-122 inherits this intent and standardizes the memory/retrieval policies around it.

**Decision**
- Keep ASM-86 as historical/problem-framing source.
- Do not absorb implementation scope.

---

### ASM-69 — Project-Aware Memory Upgrade
**What it solved**
- Established project_id-centric memory architecture.
- Defined schema for Qdrant / SQLite / graph index.
- Defined ingest, incremental reindex, hybrid retrieval, project registry, task lineage, and migration compatibility.

**Where it overlaps with ASM-122**
Very strongly on:
- memory schema governance
- hybrid retrieval foundations
- migration-first discipline
- task/project-aware memory semantics
- relationship between Qdrant / SQLite / graph planes

**How ASM-122 should refine this**
ASM-122 should absorb and supersede the following parts from ASM-69:
- unified memory layer/scope policy
- precedence rules between SlotDB / semantic / graph
- promotion pipeline semantics
- migration contract for memory planes
- retrieval ranking policy across scopes

ASM-69 should continue to own:
- project registry / alias / tracker mapping
- ingest/index/reindex mechanics
- project onboarding / import / background indexing
- physical project-aware retrieval substrate

**Decision**
- ASM-122 absorbs the **memory governance layer** from ASM-69.
- ASM-69 remains the **project/index infrastructure backbone**.

---

### ASM-96 — Code-Aware Project RAG for Development Navigation
**What it solved**
- Added code-aware indexing, graph linking, feature-pack memory, change-aware overlay, and query UX.
- Produced a usable backbone for code-aware project RAG.

**Where it overlaps with ASM-122**
- retrieval behavior
- context assembly
- graph-assisted ranking
- feature/context packaging

**How ASM-122 should refine this**
ASM-122 should not replace ASM-96. Instead:
- ASM-96 remains the backbone for code-aware retrieval/navigation.
- ASM-122 defines the memory-plane contract used beneath and alongside ASM-96.
- ASM-122 should explicitly say it **builds on top of ASM-96** for code-aware retrieval substrate.

**Decision**
- ASM-96 remains source of truth for code-aware project RAG backbone.
- ASM-122 builds on top of ASM-96 and standardizes the memory foundation under it.

---

### ASM-105 — CLI-first shared memory platform / SDK
**What it solved / is solving**
- Product/platform direction for ASM as a shared memory platform.
- CLI-first setup, shared config, packaging, installer strategy, multi-runtime adapter direction.

**Where it overlaps with ASM-122**
- shared memory concept
- cross-runtime use of the same memory platform
- config/schema centralization

**How ASM-122 should refine this**
- ASM-122 defines the memory model / scope / ranking / promotion / migration contract.
- ASM-105 packages and distributes the platform that implements those contracts.

**Decision**
- ASM-105 should consume outputs from ASM-122.
- ASM-122 should not absorb packaging/installer/platformization scope.

---

### ASM-108 — Deterministic Developer Search Hardening
**What it solves**
- Search intent parser
- per-intent retrieval plans
- coverage expansion
- deterministic answer assembly

**Where it overlaps with ASM-122**
- retrieval policy
- ranking behavior
- search consistency expectations

**How ASM-122 should refine this**
- ASM-122 defines the retrieval contract and memory ranking foundation.
- ASM-108 applies that contract to deterministic developer search UX.

**Decision**
- ASM-108 depends on ASM-122 for memory retrieval contract.
- ASM-108 remains source of truth for parser/search-plan/developer UX hardening.

---

### ASM-97 — Skills Operating Layer
**What it solved**
- Team operating layer, skills adoption, runtime wiring, workflow discipline.

**How ASM-122 relates**
- ASM-97 is not a memory architecture epic.
- It benefits from better memory quality, but does not define memory source-of-truth.

**Decision**
- Treat ASM-97 as a consumer of Memory v2, not an overlap owner.

---

## Final alignment decision for ASM-122

### ASM-122 should explicitly state:
1. It **absorbs/supersedes** memory-governance aspects of **ASM-69**.
2. It **builds on top of** **ASM-96** code-aware retrieval backbone.
3. It provides foundational contracts to be **consumed by ASM-108** (deterministic search hardening).
4. It provides foundational contracts to be **consumed by ASM-105** (shared memory platform / CLI-first SDK).
5. It inherits problem framing from **ASM-86**.
6. It improves memory quality for **ASM-97** operating layer, but does not replace it.

### ASM-122 should NOT claim:
- ownership of all project ingest/index mechanics from ASM-69
- ownership of packaging/platformization from ASM-105
- ownership of deterministic search UX/parser from ASM-108
- ownership of all code-aware RAG/navigation behavior from ASM-96

---

## Impact on ASM-113 / ASM-114 / subtasks under ASM-114

### ASM-113
Should remain the architecture/design task for Memory v2, but be refined to reflect alignment with:
- ASM-69 (absorbed governance layer)
- ASM-96 (build-on-top-of substrate)
- ASM-105 (platform consumer)
- ASM-108 (search consumer)
- ASM-86 / ASM-97 as predecessor/consumer context

### ASM-114
Should remain the implementation checklist task, but be updated so checklist items explicitly support the portfolio alignment above.

### ASM-115..ASM-121
Subtasks remain structurally valid, but should be re-validated against the refined scope of ASM-122:
- keep memory-governance items in-scope
- avoid accidentally pulling in packaging/platformization work from ASM-105
- avoid accidentally pulling in parser/deterministic answer assembly from ASM-108
- avoid accidentally re-implementing code-aware navigation backbone already delivered by ASM-96

---

## Recommended next actions

1. Refine ASM-122 description to encode the alignment above.
2. Refine ASM-113 and ASM-114 to match that boundary.
3. Re-check ASM-115..ASM-121 and adjust wording if any subtask drifts outside Memory v2 foundation scope.
4. Add Jira comments linking this matrix as portfolio alignment reference.
