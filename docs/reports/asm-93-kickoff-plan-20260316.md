# ASM-93 Kickoff Plan

Date: 2026-03-16
Task: `ASM-93` — Feature-pack memory for development flows

## Scope correction

`ASM-93` must not be narrowed into packs that mainly serve one agent (for example only Trader).
It needs to produce **agent-agnostic feature packs** that multiple agents can consume for development understanding, debugging, review, planning, and execution.

That means packs should be organized by **feature/capability/flow**, not by one agent persona.

## Goal

Turn indexed code, graph relations, and task/change context into reusable **feature-centric packs** so any relevant agent can understand a capability quickly without stitching many raw chunks manually.

## What a feature pack should represent

A pack should answer:
- what capability/flow is this?
- which files/symbols are primary?
- what is the main flow?
- what are the main risks?
- how should this be tested?
- which tasks/commits/PRs are related?

## Output shape (minimum)
- `pack_id`
- `title`
- `feature_type`
- `summary`
- `primary_files[]`
- `primary_symbols[]`
- `flow_steps[]`
- `risk_points[]`
- `test_points[]`
- `related_tasks[]`
- `related_commits[]`
- `related_prs[]`
- `evidence[]`

## Scope rule

### In scope
- feature/capability packs that help multiple agents understand development flows
- packs built from code-aware indexing + graph + task/change context
- reusable packs for planning/debugging/review/navigation

### Out of scope
- agent-persona-specific packs as the primary organizing model
- trader-only packaging as the default framing of the task
- UX/query surface work beyond what is needed to validate pack usability

## Revised priority packs (agent-agnostic)

1. **Project onboarding / registration / indexing flow**
   - includes `/project` onboarding, registration, trigger index, reindex lifecycle

2. **Code-aware retrieval flow**
   - includes hybrid search, symbol lookup, chunk retrieval, lineage-aware retrieval

3. **Heartbeat / health / runtime integrity flow**
   - includes health checks, heartbeat semantics, failure/observability touchpoints

4. **Post-entry / review / decision-support flow**
   - includes review/analysis style capability packs where developer navigation matters

5. **Change-aware impact flow**
   - includes commit/PR/task-linked understanding of which code/feature changed

## Why this corrected priority is better

These packs are:
- reusable by `assistant`, `creator`, `scrum`, `fullstack`, and later other agents
- tied to capabilities/features rather than one agent role
- aligned with the purpose of developer-grade project RAG

## Implementation order

### Slice 1 — Pack contract + minimal builder
- define feature-pack contract/types
- define one minimal builder path from indexed/graph/task sources
- generate first pack for a general development capability

### Slice 2 — Multi-pack generation
- support at least the first 3 high-value general packs
- refine evidence selection and ordering

### Slice 3 — Query/use integration
- expose pack retrieval in a way that multiple agents can consume directly
- keep UX minimal; do not overreach into full `ASM-95` yet

## Immediate next move

Start with the most generally reusable pack first:
- **Project onboarding / registration / indexing flow**

Reason:
- cross-agent value is high
- directly connected to the code-aware retrieval backbone from `ASM-91`
- easier to verify with concrete files/symbols/tasks than a persona-specific flow

## Rule to remember

`ASM-93` is about **feature-pack memory for development capabilities**, not persona-specific memory bundles.
