# ASM-92 Implementation Slice 1 Plan

Date: 2026-03-16
Task: `ASM-92` — Graph linking for code navigation

## Slice 1 objective

Use the existing generic graph storage to establish a **universal code-navigation graph baseline** with:
- explicit node types
- explicit relation taxonomy
- provenance/confidence carried in relation properties
- one minimal persistence/read path for code-aware graph relations

## Current graph baseline in repo

Existing storage already present:
- `src/db/graph-db.ts`
- generic entities/relationships tables
- generic graph CRUD/traversal in usecase + tools

This is good enough as storage substrate, but not enough as a code-navigation model.

## What Slice 1 should add

### 1. Universal graph model constants/contracts
Need a canonical model for code-aware use, minimally:

#### Node types (v1)
- `file`
- `module`
- `symbol`
- `route`
- `job`
- `event`
- `entity`

#### Relation types (v1)
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

### 2. Provenance + confidence contract
Every graph relation for ASM-92 should be able to carry at least:
- `adapter_kind`
- `confidence`
- `evidence_path`
- `evidence_start_line`
- `evidence_end_line`

### 3. Minimal persistence helper path
Add a narrow code-aware helper path that can:
- upsert graph entities with stable IDs for code artifacts
- upsert graph relations using the universal relation taxonomy
- avoid changing the generic graph storage model more than necessary

### 4. One minimal read path
Allow one minimal query/traversal path to consume code graph relations.
This slice does not need full UX; only enough baseline to prove graph model is usable.

## Files likely affected

### Core graph storage / contracts
- `src/db/graph-db.ts`
- `src/core/contracts/adapter-contracts.ts`
- `src/core/usecases/default-memory-usecase-port.ts`

### Tool surface
- `src/tools/graph-tools.ts`

### New graph model constants/helpers
Suggested new files:
- `src/core/graph/contracts.ts`
- `src/core/graph/code-graph-model.ts`

### Tests / docs
Suggested new files:
- `tests/test-code-graph-model.ts`
- `docs/architecture/ASM-92-universal-graph-model-v1.md`

## Implementation order

### Step A — model first
- define node/edge taxonomy constants
- define required relation property fields for provenance/confidence

### Step B — persistence helper
- add minimal helpers for code-aware graph upsert without overhauling generic graph storage

### Step C — read/traversal proof
- prove graph traversal can return meaningful relation chain for at least one code-navigation style path

## DoD for Slice 1
- graph model constants exist and are documented
- provenance/confidence contract exists
- minimal code-aware persistence helper exists
- at least one focused test proves persist + traverse path works
- no framework lock-in in the model itself

## Non-goals in Slice 1
- no full adapter rollout
- no framework-specific heuristics beyond examples/tests
- no query UX work (`ASM-95`)
- no feature-pack/change-overlay work (`ASM-93`/`ASM-94`)
