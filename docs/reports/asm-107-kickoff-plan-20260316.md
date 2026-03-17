# ASM-107 Kickoff Plan

Date: 2026-03-16
Task: `ASM-107` — Project lifecycle management: register, deindex, unregister, purge

## Goal

Define and begin implementing a safe, explicit lifecycle model for projects in ASM SDK so projects can move through states like active/deindexed/detached/purged without ambiguous behavior or unsafe data loss.

## Why this task matters

After `ASM-103` established shared config foundations, ASM SDK still needs governance for project objects themselves.
Without lifecycle semantics, retrieval/search/install/integration behavior becomes inconsistent and dangerous across runtimes.

## Lifecycle states to model
- `active`
- `disabled`
- `detached`
- `deindexed`
- `purged`

## Actions to define clearly
- `register`
- `deindex`
- `unregister`
- `detach`
- `purge`

## Key distinctions to preserve

### `deindex`
- project remains known to registry
- search/retrieval should stop returning its indexed artifacts
- metadata remains recoverable

### `detach`
- break alias/repo/tracker binding as needed
- do not imply full data deletion

### `unregister`
- remove project from active registry usage
- keep semantics distinct from deindex and purge

### `purge`
- destructive cleanup across SQLite / Qdrant / graph by `project_id`
- requires safety + confirm + audit semantics

## Scope

### In scope
- lifecycle model and state definitions
- command/UX contract proposals for lifecycle actions
- searchable/tombstone semantics
- audit/confirm/rollback principles
- cleanup model by `project_id`

### Out of scope
- packaging/install behavior (`ASM-104`)
- OpenCode read-only retrieval contract details (`ASM-106`)
- broad SDK distribution concerns

## Immediate first slice

1. Inspect current project registry / alias / tracker / index state tables and deletion/tombstone behavior.
2. Define lifecycle contract + state machine.
3. Define one minimal non-destructive path first:
   - `deindex`

## Why start with deindex first
- directly affects searchability semantics
- easiest way to define active vs non-searchable behavior
- foundational for safer later actions (`detach`, `unregister`, `purge`)

## Expected deliverables for first slice
- lifecycle state contract/types
- minimal project lifecycle design note
- first implementation/research slice around `deindex` semantics and searchability/tombstone behavior

## Success criteria for kickoff slice
- lifecycle states documented
- action semantics documented without ambiguity
- first slice scoped tightly enough to implement safely
