# ASM-92 Universal Graph Model v1 (Slice 1)

Date: 2026-03-16
Scope: baseline usable slice for universal, language-agnostic graph linking.

## 1) Universal taxonomy (v1)

### Node types
- `file`
- `module`
- `symbol`
- `route`
- `job`
- `event`
- `entity`

### Relation types
- `defines`
- `calls`
- `imports`
- `extends`
- `implements`
- `routes_to`
- `reads_from`
- `writes_to`
- `emits`
- `consumes`
- `scheduled_as`
- `depends_on`

## 2) Provenance + confidence contract

Every universal relation supports:
- `adapter_kind` (required)
- `confidence` (required, normalized into [0,1])
- `evidence_path` (optional)
- `evidence_start_line` (optional)
- `evidence_end_line` (optional)

Stored in relationship properties so current generic graph storage remains reusable.

Slice 1 contracts are centralized in `src/core/graph/contracts.ts` with:
- model version constant: `UNIVERSAL_GRAPH_MODEL_VERSION = "universal-v1"`
- taxonomy guards for node/relation types
- lightweight provenance shape validator (`isValidUniversalGraphProvenance`) for boundary checks.

## 3) Minimal persistence/read path (slice 1)

### Persistence
- New usecase: `graph.code.upsert`
- Upsert node path (stable id):
  - if entity exists: update
  - if not exists: create with provided id
- Upsert relation path:
  - use existing relationship upsert behavior by `(source,target,type)`
  - carry provenance/confidence into properties and relation weight

### Read
- New usecase: `graph.code.chain`
- Traverse from `node_id` with bounded depth and optional relation filter.

## 4) Tool surface

- New tool: `memory_graph_code_link`
  - accepts universal nodes/relations
  - executes `graph.code.upsert`
  - returns minimal read chain via `graph.code.chain`

## 5) Non-goals kept

- No framework-specific lock-in
- No full adapter rollout
- No advanced query UX (ASM-95)
- No overlay/feature-pack work (ASM-93/ASM-94)
