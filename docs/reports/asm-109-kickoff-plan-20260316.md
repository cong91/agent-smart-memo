# ASM-109 Kickoff Plan

Date: 2026-03-16
Epic: `ASM-108` — Deterministic Developer Search Hardening after ASM-96
Task: `ASM-109` — Typed query parser for deterministic developer search

## Goal

Introduce a deterministic query parser that converts developer-style text queries into typed intents and selectors, so retrieval can route correctly without relying on one-size-fits-all query handling.

## Why this task exists

After `ASM-96`, the backbone is usable, but query quality still varies by intent. The most important next improvement is to make developer queries parse into explicit routing decisions instead of depending on ad hoc keyword behavior.

## Scope

### In scope
- define typed developer query intents
- define selector extraction for common developer query forms
- implement deterministic parser logic
- provide benchmark coverage for representative developer queries

### Out of scope
- changing retrieval engine in depth (`ASM-110`)
- broad extraction/graph coverage expansion (`ASM-111`)
- answer rendering hardening (`ASM-112`)

## Initial typed intents
- `locate_symbol`
- `locate_file`
- `trace_flow`
- `impact_analysis`
- `feature_lookup`
- `change_lookup`

## Initial selectors to extract
- symbol name
- file/path-like string
- route path
- feature key / feature name
- tracker issue key
- task title hint

## Success criteria
- parser contract exists
- parser implementation exists
- benchmark query set exists
- parser correctly classifies/extracts for representative developer queries

## Immediate first slice

Start with the two most valuable parsing paths:
1. symbol / file locate queries
2. feature lookup queries

Reason:
- they map directly to existing usable paths from `ASM-96`
- they improve routing quality quickly without needing broad retrieval refactor first
