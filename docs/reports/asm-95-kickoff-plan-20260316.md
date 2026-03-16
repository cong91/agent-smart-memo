# ASM-95 Kickoff Plan

Date: 2026-03-16
Task: `ASM-95` — Query UX for developer-grade project RAG

## Goal

Turn the capabilities built in `ASM-91` to `ASM-94` into a usable developer query surface with a clear query contract and a response contract optimized for code navigation and development workflows.

## What ASM-95 should solve

Given a developer-style query, the system should return a response shaped for action, not vague semantic text.

Expected response priority:
- file path
- symbol
- snippet
- relation path
- feature pack
- change-aware context

## Inputs now available from earlier tasks
- code-aware indexing (`ASM-91`)
- universal graph model baseline (`ASM-92`)
- feature-pack memory (`ASM-93`)
- change-aware overlay (`ASM-94`)

## Scope

### In scope
- define developer query patterns / query contract
- define response contract for developer-grade answers
- add one minimal query/use integration path that assembles existing capabilities coherently
- benchmark with a small set of developer queries

### Out of scope
- broad UI redesign
- persona-specific prompting UX
- full natural-language planner beyond what is needed to route a query to existing retrieval layers

## First developer query patterns to support

1. **Locate**
   - where is symbol/function/class X?

2. **Trace flow**
   - how does route/handler/flow Y move through the system?

3. **Impact**
   - what changes if file/module/symbol Z is modified?

4. **Change-aware lookup**
   - which task/commit/PR changed this feature/flow?

5. **Feature understanding**
   - show me the pack for capability/flow Q

## Response contract (minimum)

Every strong response path should be able to emit some structured combination of:
- `intent`
- `primary_results[]`
- `files[]`
- `symbols[]`
- `snippets[]`
- `graph_paths[]`
- `feature_packs[]`
- `change_context[]`
- `confidence`
- `why_this_result`

## Implementation order

### Slice 1 — Query/response contract + minimal router
- define query intent model
- define response contract/types
- add one minimal query router over existing retrieval capabilities

### Slice 2 — Result assembly quality
- improve ordering/merging of file/symbol/graph/feature/change outputs
- keep response concise and useful for developer tasks

### Slice 3 — Benchmark and hardening
- run at least 5 representative developer queries
- validate that output reduces dependence on plain grep

## Immediate first slice

Start with the narrowest high-value path:
- **Locate + Feature understanding**

Meaning:
- route exact symbol/file lookup through code-aware retrieval
- route feature-oriented queries through feature-pack query
- define one response contract that can represent both without overcomplicating the system

## Success criteria for Slice 1
- query contract exists
- response contract exists
- minimal router exists
- at least 2 query families work end-to-end:
  - locate
  - feature understanding
- build/test pass for impacted scope
