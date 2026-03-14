# ASM-86 Jira Phase Executor

## Epic
- ASM-86 — [ASM] Deep Project Understanding Upgrade

## Stories / phases in execution order
1. ASM-87 — Wire symbol extraction into runtime project indexing
2. ASM-88 — Add semantic block retrieval to project hybrid search
3. ASM-89 — Verify deep project understanding on real repository

## Execution policy
- Work strictly in story order: ASM-87 -> ASM-88 -> ASM-89
- Do not open a new phase before the current one has:
  - code patch
  - build/test verification
  - real-project verification where applicable
  - Jira-ready evidence summary
- Use `agent-knowledge-distiller` as the primary real-repo verification target.
- Treat scheduler-based reindex as non-primary; prioritize event/diff-aware project indexing design.

## Current live status
### ASM-87
- State: IN PROGRESS
- Objective:
  - runtime indexing must populate `symbol_registry` and `chunk_registry`
  - move beyond file-only indexing
- Root cause confirmed:
  - `reindexProjectByDiff(...)` currently stops at `file_index_state`
  - semantic extraction primitives exist but were not wired into runtime persistence
- Important blocker discovered during execution:
  - partial diff semantics currently tombstone unrelated files if `paths` is treated as full snapshot
- Required completion checks:
  - `symbolCount > 0`
  - `chunkCount > 0`
  - no incorrect tombstoning on partial/event diff path
  - verify on `agent-knowledge-distiller`

### ASM-88
- State: TODO
- Objective:
  - make `project.hybrid_search` use symbol/chunk data for code-level retrieval
- Entry condition:
  - ASM-87 completed and verified

### ASM-89
- State: TODO
- Objective:
  - end-to-end proof on a real repository
- Entry condition:
  - ASM-87 + ASM-88 completed

## Checkpoint format
For every manual checkpoint report, include:
- current story key
- files changed
- current blocker / open risk
- latest verify command + result
- whether next step stays in same story or advances to next story

## Current next step
- Finish ASM-87 by fixing partial diff semantics and completing runtime symbol/chunk persistence verification.
