# ASM-94 Kickoff Plan

Date: 2026-03-16
Task: `ASM-94` — Change-aware overlay (commit/PR/Jira to code/features mapping)

## Goal

Add a change-aware overlay on top of project-aware memory so agents can answer historical and impact questions such as:
- task X changed which files/features?
- which commits touched heartbeat flow?
- which PR affected technical snapshot?

## Why this task matters

Indexing (`ASM-91`), graph linking (`ASM-92`), and feature packs (`ASM-93`) improve present-time code understanding.
`ASM-94` adds **time/change dimension** so agents can connect development changes back to code/features and reason about impact/history more reliably.

## Scope

### In scope
- ingest commit / PR / Jira metadata into a project-aware overlay
- map change records to files, symbols, and feature packs when evidence exists
- support a minimal query path for change-aware lookup

### Out of scope
- full external system sync engine for every tracker/provider
- broad UI/query UX work (`ASM-95`)
- replacing existing source-of-truth systems (Git/Jira)

## Minimum overlay entities

### Change records
- `commit`
- `pull_request`
- `tracker_issue`

### Mappable targets
- `file`
- `symbol`
- `feature_pack`
- `task_registry` / lineage context

## Minimum overlay links
- `commit -> file`
- `commit -> symbol` (when derivable)
- `pull_request -> file`
- `pull_request -> feature_pack` (when evidence exists)
- `tracker_issue -> file`
- `tracker_issue -> feature_pack`
- `tracker_issue -> commit` (when linked evidence exists)

## First query targets to support

1. Files changed by task / issue X
2. Commits touching feature/flow Y
3. PRs affecting feature pack Z
4. Related changes for heartbeat / health flow
5. Related changes for technical snapshot flow

## Data sources already present in repo

Likely reusable foundations already exist:
- `task_registry`
- `tracker_issue_key`
- `commit_refs`
- `project_task_lineage_context`
- `project_hybrid_search`
- project registration / tracker mapping contracts
- feature-pack layer from `ASM-93`

## Implementation order

### Slice 1 — Overlay contract + minimal builder
- define change-aware overlay contract/types
- define one minimal builder path from existing `task_registry` + commit refs + tracker metadata
- support first query shape: files changed by task/issue

### Slice 2 — Feature/pack mapping
- connect change records to feature packs when evidence exists
- improve ordering and confidence

### Slice 3 — Broader query/use integration
- expose minimal query/use path for change-aware lookup
- keep UX narrow; do not overreach into ASM-95

## First slice to execute

Start with the narrowest valuable path:
- **tracker_issue / task -> changed files -> related symbols**

Reason:
- task/tracker metadata already exists in repo
- easiest route to prove change-aware overlay without requiring a full PR provider integration upfront
- directly useful for developer navigation and incident review

## Likely files to touch first
- `src/core/contracts/...` for change-aware overlay contracts
- `src/core/usecases/default-memory-usecase-port.ts`
- `src/db/slot-db.ts`
- `src/tools/project-tools.ts`
- tests around task/project registry and retrieval

## Success criteria for first slice
- a change-aware contract exists
- at least one builder path exists from task/tracker evidence to changed files/symbols
- at least one query path returns usable change-aware context from real seeded data
- build/test pass for the impacted scope
