# ASM startup boilerplate contamination fix

Date: 2026-04-10
Status: execution spec
Scope: fix AutoCapture/distill contamination where session-start/bootstrap/system primer text is incorrectly extracted and applied as user/project memory (for example `project.current_focus`).

## Problem statement
Observed runtime evidence shows AutoCapture/DistillApply storing startup/session-reset boilerplate such as:
- `A new session was started via /new or /reset...`
- `Run your Session Startup sequence...`
- `read the required files before responding...`
- `greet the user in your configured persona...`

This is not valid long-term memory, not valid project focus, and not valid learned principle content. It contaminates SlotDB state and wiki memory with system/session bootstrap text.

## Goal
Prevent startup/session/system boilerplate from being treated as distillable memory or project state.

## Required fixes
### 1. Input hygiene before distill
Before sending conversation/context into distill, suppress obvious startup/session-reset/system-primer text blocks.

### 2. Extractor/distill guard
If boilerplate-like content still reaches extraction, it must not produce slot updates, memories, draft updates, briefing updates, or promotion hints from that content.

### 3. Apply guard
Even if upstream extraction leaks, Apply must reject slot poisoning for sensitive targets such as:
- `project.current_focus`
- similar project/session state slots
when the value matches startup/system/bootstrap instruction patterns.

## Examples to suppress
At minimum, patterns equivalent to:
- `A new session was started via /new or /reset`
- `Run your Session Startup sequence`
- `read the required files before responding`
- `greet the user in your configured persona`
- obvious session bootstrap / system instruction boilerplate

## Non-goals
- Do not remove legitimate user/project/task content
- Do not regress continuation-owned write-back architecture
- Do not turn this into a generic broad censorship layer

## Acceptance criteria
- startup/system boilerplate no longer lands in `project.current_focus`
- auto-capture does not store boilerplate as long-term memory
- tests cover contamination examples explicitly
- evidence includes changed files and PASS/FAIL verification

## Suggested verification
- targeted tests for contamination suppression
- targeted tests for apply-guard on poisoned slot values
- build/test evidence showing no regression in auto-capture flow
