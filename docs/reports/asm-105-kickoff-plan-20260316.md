# ASM-105 Kickoff Plan

Date: 2026-03-16
Epic: `ASM-105` — ASM SDK / CLI-first shared memory platform

## Epic goal

Turn ASM from a plugin-first memory module into a **shared memory platform** with a clear core/adapters boundary, shared config home, project lifecycle safety, and multi-platform install/distribution strategy.

## Why this epic matters

ASM is no longer just an OpenClaw-local plugin concern.
It now needs platform-level clarity for:
- shared memory core
- shared project/task/knowledge source of truth
- OpenClaw / Paperclip / OpenCode client roles
- CLI-first operations
- safe project lifecycle management
- multi-platform install and config behavior

## The 4 workstreams in scope

### 1. ASM-103 — Shared config home and multi-platform config lifecycle
Purpose:
- define one canonical config home and resolution model for ASM SDK
- avoid each client/runtime inventing its own config behavior

Must answer:
- where shared config lives
- precedence rules (env / file / defaults)
- migration path from current config surfaces
- how multiple clients read the same memory platform config safely

### 2. ASM-107 — Project lifecycle management and safety
Purpose:
- define project states and safe destructive/non-destructive operations

Must answer:
- states: active / disabled / detached / deindexed / purged
- actions: register / deindex / unregister / detach / purge
- searchable/tombstone semantics
- audit/confirm/rollback rules
- cleanup scope across SQLite / Qdrant / graph

### 3. ASM-106 — Project-scoped retrieval contract for OpenCode read-only integration
Purpose:
- make OpenCode a safe read-only consumer of ASM

Must answer:
- project-scoped retrieval by default
- active project binding strategy
- alias/repo/session resolution
- behavior for ambiguous alias / unregistered repo
- cross-project search only when explicit
- read-only tool surface for OpenCode

### 4. ASM-104 — Packaging / installer / CLI-first distribution
Purpose:
- package and ship ASM as an SDK/CLI product correctly once boundaries are clear

Must answer:
- package boundaries (core vs adapters)
- npm packaging strategy
- install flow `asm install <platform>`
- what gets installed where
- how clients bootstrap/use shared config

## Critical-path execution order

1. `ASM-103` — shared config home
2. `ASM-107` — lifecycle model and safety
3. `ASM-106` — project-scoped retrieval contract
4. `ASM-104` — packaging and installer strategy

## Why this order

- Config must be settled before install/distribution decisions are safe.
- Lifecycle must be settled before client contracts rely on searchable/deindexed/purged semantics.
- OpenCode retrieval contract should be designed on top of stable config + lifecycle rules.
- Packaging/installer work should package a stable product boundary, not a moving target.

## Deliverables expected from the epic

- one platform-level kickoff narrative for ASM SDK
- one canonical shared-config design
- one canonical project lifecycle model
- one OpenCode retrieval contract
- one package/install strategy
- enough clarity that future agents/devs can implement follow-up work without re-litigating the product direction

## Immediate next move

Start with `ASM-103`.

### Initial slice for ASM-103
- inspect current config surface in repo
- define canonical shared config home
- define config precedence
- define migration compatibility direction
- define what each client (OpenClaw/Paperclip/OpenCode) reads from the shared config

## Bottom line

`ASM-105` is the product/architecture line that makes ASM an SDK/platform, not just a plugin. The right first move is `ASM-103` because every later workstream depends on config/home clarity.
