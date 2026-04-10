# ASM-122 — Memory v2 Epic Execution Plan

## Objective
Triển khai toàn epic ASM-122 theo hướng trơn tru, migration-first và anti-drift, dùng ASM-113 làm design reference, ASM-114 làm execution checklist source-of-truth, và ASM-115..ASM-121 làm execution breakdown thật.

## Portfolio positioning (must keep true)
- ASM-122 absorb/supersede memory-governance layer của ASM-69.
- ASM-122 build on top of ASM-96 retrieval/code-aware backbone.
- ASM-122 provide foundation contracts cho ASM-105 và ASM-108.
- ASM-122 inherit problem framing từ ASM-86 và improve memory quality cho ASM-97 operating layer.
- Không drift sang packaging/platformization của ASM-105.
- Không drift sang parser/search UX deterministic của ASM-108.
- Không re-implement code-aware navigation backbone đã done ở ASM-96.

## Epic structure
- ASM-122 = Epic foundation / final scope owner
- ASM-113 = architecture truth / design task
- ASM-114 = execution checklist truth
- ASM-115..ASM-121 = implementation subtasks

## Subtask roles
- ASM-115: Migration-first / schema-payload v2 / backfill-verify-rollback plan for SlotDB, Qdrant, Graph/index
- ASM-116: Promotion pipeline `raw -> distilled -> promoted`
- ASM-117: Precedence rules giữa SlotDB / semantic / graph/context
- ASM-118: Session scope semantics fix (remove default hard-filter; strict mode or soft boost)
- ASM-119: Namespace/scope contract unification across memory_store / memory_search / semantic usecase
- ASM-120: Unify auto-recall and tool search on shared retrieval policy
- ASM-121: Test suite / retrieval parity / migration verification gate

## Recommended execution order
1. ASM-119 — unify namespace/scope contract
2. ASM-118 — fix session scope semantics
3. ASM-120 — unify auto-recall + tool search retrieval policy
4. ASM-121 — establish test/verification gate in parallel with above
5. ASM-115 — finalize migration-first payload/schema v2 + backfill/rollback plan
6. ASM-117 — precedence rules SlotDB vs semantic vs graph
7. ASM-116 — promotion pipeline raw/distilled/promoted
8. Epic closeout / parity audit / rollout notes

## Critical path
ASM-113 -> ASM-114 -> ASM-119 -> ASM-118/ASM-120 -> ASM-121 -> ASM-115 -> ASM-117 -> ASM-116

## Why this order
- 119 must happen early because namespace/scope contract is the shared base for store/search/semantic.
- 118 and 120 depend on contract stabilization and directly fix the most user-visible retrieval semantics.
- 121 must run early and continuously so fixes do not drift between tool path and hook/usecase path.
- 115 should lock migration/payload/schema before deep rollout, but script execution can remain behind contract stabilization.
- 117 should define current-truth precedence only after retrieval policy is stable.
- 116 should come later because promotion pipeline depends on stable scope/schema/retrieval/precedence.

## Blockers and dependencies
### Hard blockers
- ASM-113 blocks final policy choices and wording consistency.
- ASM-114 blocks execution sequencing and anti-drift boundaries.

### Functional blockers
- ASM-119 blocks ASM-118, ASM-120, and part of ASM-115.
- ASM-118 and ASM-120 should be developed together to avoid behavior mismatch.
- ASM-121 should start early but full parity completion depends on ASM-119/118/120 and later extend to 117/115.
- ASM-117 depends on stable namespace/scope/retrieval semantics.
- ASM-116 depends on at least contract v2 (119), migration framing (115), and precedence policy (117).

## Workstream lanes
### Lane A — Contract foundation
- Files: `src/tools/memory_store.ts`, `src/tools/memory_search.ts`, `src/core/usecases/semantic-memory-usecase.ts`, `src/shared/memory-config.ts`
- Scope: ASM-119
- Goal: one canonical namespace/scope contract + metadata v2 alignment

### Lane B — Retrieval semantics
- Files: `src/hooks/tool-context-injector.ts`, `src/hooks/auto-recall.ts`, `src/tools/memory_search.ts`, `src/core/usecases/semantic-memory-usecase.ts`
- Scope: ASM-118 + ASM-120
- Goal: remove default session hard-filter, unify recall/search policy

### Lane C — Verification gate
- Files: tests for tool path, hook path, migration parity
- Scope: ASM-121
- Goal: round-trip + parity + strict/non-strict session behavior + precedence verification

### Lane D — Migration safety
- Files: payload/schema/backfill scripts or plan artifacts touching SlotDB/Qdrant/Graph related code paths
- Scope: ASM-115
- Goal: backup/dry-run/cutover/rollback and payload completeness audit

### Lane E — Storage-plane policy
- Files: SlotDB / semantic retrieval / graph-aware ranking/context assembler
- Scope: ASM-117
- Goal: SlotDB current truth, semantic supporting evidence, graph routing/ranking support only

### Lane F — Promotion pipeline
- Files: `src/hooks/auto-capture.ts`, semantic usecase, SlotDB integration for durable memory promotion
- Scope: ASM-116
- Goal: raw -> distilled -> promoted lifecycle with promotion_state + memory_type

## Acceptance criteria for epic-level completion
- Scope/layer contract unified and reflected consistently in runtime.
- Session scope default behavior no longer collapses agent/project memory into session memory.
- Tool search and auto-recall share retrieval policy and produce parity on defined scenarios.
- Migration strategy exists for SlotDB, Qdrant payload/vector plane, and Graph/index plane with rollback safety.
- Precedence policy is explicit: SlotDB current truth, semantic supporting evidence, graph routing/ranking support.
- Promotion pipeline contract exists and is safe to build on top of stabilized retrieval semantics.
- Test suite covers round-trip, alias parity, strict/non-strict session mode, shared/project recall, slot precedence, and migration verification.
- No subtask drifts into ASM-105 packaging, ASM-108 deterministic parser/search UX, or ASM-96 backbone re-implementation.

## Validation commands
- `npm run build:openclaw`
- `npx tsx tests/test-project-registry.ts`
- add targeted test commands per subtask as implementation lands

## OpenCode handoff packet
### Task title
ASM-122 Memory v2 epic execution

### Objective for OpenCode
Thực thi toàn epic ASM-122 theo sequencing đã chốt: contract -> retrieval semantics -> tests/migration safety -> precedence -> promotion; tránh drift boundary với ASM-69/96/105/108.

### What OpenCode should read first
1. `docs/reports/asm-epic-overlap-matrix-memory-v2-20260320.md`
2. Jira ASM-122 description/comments
3. Jira ASM-113 / ASM-114 / ASM-115..ASM-121
4. Relevant runtime files from Lane A/B/C before patching anything

### Constraints for OpenCode
- Không thay đổi scope sang packaging/platformization.
- Không làm parser/search UX deterministic product surface.
- Không tái xây code-aware backbone đã xong.
- Ưu tiên migration-safe và test-first cho các bug contract.

### Expected output from OpenCode
- execution breakdown by file/hook/usecase
- dependency-aware patch order
- proposed first implementation slice (recommend ASM-119 + ASM-118 + ASM-120 + ASM-121 bootstrap)
- explicit risk notes and rollback considerations
