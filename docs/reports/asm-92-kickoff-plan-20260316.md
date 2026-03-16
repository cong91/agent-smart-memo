# ASM-92 Kickoff Plan

Date: 2026-03-16
Task: `ASM-92` — Graph linking for code navigation

## Scope (corrected)

`ASM-92` is a **language-agnostic graph linking model** for code navigation.
It is not scoped to any single framework. Stack-specific adapters are rollout order only.

## Goal

Define and implement the first universal relation graph layer so ASM can answer navigation/impact/flow questions using structured relations instead of disconnected chunks.

## Target outcomes for first slice

1. Universal node model exists
2. Universal edge taxonomy exists
3. Provenance + confidence are part of relation data
4. First persistence path exists in code
5. At least one minimal query/use path can consume graph relations

## Universal node types (v1)
- `file`
- `module`
- `symbol`
- `route`
- `job`
- `event`
- `entity`

## Universal relation types (v1)
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

## Required metadata per relation
- `relation_type`
- `source_entity_id`
- `target_entity_id`
- `source_kind` / `adapter_kind`
- `confidence`
- `evidence_path`
- optional `evidence_span`

## Implementation order

### Slice 1 — Schema + contracts
- define node/edge contract in core types
- define relation taxonomy constants
- define provenance/confidence fields
- align with existing `graph-db` / `slot-db` paths if reusable

### Slice 2 — Minimal write path
- create a minimal way to persist graph entities/relations from code-aware extraction outputs
- no framework lock-in
- allow later adapters to feed the same schema

### Slice 3 — First consumption path
- expose one query/use path that can read graph relations for technical navigation
- keep it minimal and debuggable

## DoD for kickoff slice
- graph model is framework-agnostic
- relation taxonomy is explicit and documented
- provenance/confidence are first-class fields
- code path exists for persist + read of minimal graph relations
- no architecture decision in this slice prevents multi-language adapters later

## Non-goals right now
- not implementing every language adapter now
- not solving query UX (`ASM-95`) now
- not bundling feature packs (`ASM-93`) now
- not mixing change overlay (`ASM-94`) into the graph core slice

## Immediate next move

Start with a narrow implementation slice in the repo source-of-truth on current branch:
1. inspect current graph-related code (`src/db/graph-db.ts`, related contracts)
2. define/adjust universal relation model
3. wire the minimum persistence path
