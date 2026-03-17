# ASM-96 QA Verification

Date: 2026-03-16
Epic: `ASM-96`
Repo: `/Users/mrcagents/Work/projects/agent-smart-memo`

## QA Goal

Rerun final whole-epic verification on real project `agent-smart-memo` with behavior-layer queries that reflect actual developer usage.

## Verification layers

1. Build/test layer
2. Runtime/index layer
3. Behavior/query layer

## Build/test layer

Previously verified:
- `npm run build:openclaw`
- `npx tsx tests/test-project-hybrid-lineage.ts`
- `npx tsx tests/test-code-graph-model.ts`
- `npx tsx tests/test-project-registry.ts`

## Runtime/index layer

Previously verified:
- latest index runs are `indexed`
- target tool symbols exist in `symbol_registry`
- project `agent-smart-memo` has healthy materialized file/symbol/chunk counts

## Behavior/query layer

This final QA pass should focus on:
- exact symbol lookup (`project_hybrid_search`)
- plain text developer query (`project onboarding registration indexing flow`)
- graph query path
- feature pack query
- change overlay query (resolved + unresolved selector)
- developer query intents:
  - locate
  - feature_understanding
  - trace_flow
  - impact
  - change_aware_lookup

## Conclusion template

This report records the final QA pass for whole-epic behavior quality.
