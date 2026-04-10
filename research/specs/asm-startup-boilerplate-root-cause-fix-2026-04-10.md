# ASM startup boilerplate root-cause fix

Date: 2026-04-10
Status: execution spec
Scope: root-cause fix for repeated startup/session-reset boilerplate being persisted as `project.current_focus` and related state.

## Root-cause findings
### 1. Host-side synthesis bug in `extractFacts()`
File: `src/hooks/auto-capture.ts`

`extractFacts()` currently builds a host-side `continuationStructuredContract` and pre-populates:
- `slot_updates[].key = project.current_focus`
- `slot_updates[].value = truncateText(extractFirstUserLine(text), 240)`

This means the host is not merely orchestrating. It is manufacturing a semantic slot update from raw recent-message text before continuation execution.

### 2. Wrong source selection in `extractFirstUserLine()`
File: `src/hooks/auto-capture.ts`

`extractFirstUserLine()` picks the first `user:` line from the recent-message window without distinguishing:
- real user/project/task content
- startup/session-reset boilerplate
- system/session bootstrap meta

Therefore startup boilerplate can become `project.current_focus`.

### 3. Continuation is not the primary source of the poisoned slot
File: `src/services/llm-extractor.ts`

`runContinuationNativeDistill()` mainly normalizes and returns the provided `runtimeOptions.structuredContract` when present. In the observed failure, continuation is not generating the poisoned slot from scratch; it is normalizing/returning the host-supplied contract.

## Goal
Fix the actual boundary violation and semantic source-selection bug, not just suppress one string pattern.

## Required fixes
1. Remove or drastically narrow host-side semantic slot synthesis in `extractFacts()`.
2. Prevent `extractFirstUserLine()`-style naive source selection from driving `project.current_focus`.
3. Keep continuation-owned write-back semantics honest: host should not claim orchestration-only while manufacturing semantic slot updates.
4. Add validation/backstop so obviously invalid startup/session bootstrap text cannot persist into sensitive project-state slots.

## Acceptance criteria
- `project.current_focus` is no longer manufactured from naive first-user-line extraction of raw recent messages.
- startup/session bootstrap text no longer persists through the host-side structured contract path.
- continuation/host responsibility boundary is explicit and accurate in implementation/logging.
- tests cover the root-cause path explicitly.
- evidence includes changed files and PASS/FAIL verification.
