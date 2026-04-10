# ASM Wiki-First System Implementation Plan

Date: 2026-04-09
Project: agent-smart-memo
Derived from:
- `research/specs/asm-wiki-first-system-redesign-2026-04-09.md`
Status: implementation planning draft

## 0. Implementation goal

Refactor ASM from:
- snippet-first recall over wiki-backed memory

to:
- wiki-first working-set construction on top of Wiki + SlotDB + Graph

while preserving:
- continuation-based write-back
- deterministic apply
- no reintroduction of fake local distill/extractor ownership

and adding:
- install/setup orchestration for system-wide adoption

## 1. Success criteria

The redesign is considered successful when all of the following hold:

1. Relevant agent runs operate in `wiki-first` mode by default after ASM setup/install.
2. Prompt injection contains a working surface (wiki entrypoints + canonical pages + state), not merely snippets.
3. Wiki remains the primary knowledge surface; SlotDB and graph remain supporting/control layers.
4. Continuation-based write-back still works and remains the only distill/apply owner.
5. Install/setup orchestration is idempotent and can patch reinforcement surfaces (e.g. AGENTS.md) when missing.
6. The system does not regress into local fake distill/extractor behavior.

## 2. Workstreams / Epics

## Epic A — Read-path refactor (highest priority)

### Objective
Turn auto-recall into a working-set orchestrator instead of a snippet injector.

### Deliverables
1. Run mode resolver
2. State pack builder
3. Wiki working-set builder
4. Graph-assisted expansion layer
5. Supporting recall pack demoted to supplementary role
6. Updated prompt contract

### Planned modules

#### A1. `src/core/usecases/run-mode-resolver.ts`
Responsibilities:
- classify runs into `light`, `wiki-first`, `write-back`
- use current task/project/focus + message characteristics + continuation status

Inputs:
- sessionKey
- messages
- SlotDB state summary
- possible continuation metadata

Outputs:
- `{ runMode, reasons }`

#### A2. `src/core/usecases/state-pack-builder.ts`
Responsibilities:
- merge SlotDB state across private/team/public with precedence and freshness
- load `project_living_state`
- load recent updates
- produce normalized structured state pack

Inputs:
- SlotDB
- sessionKey
- userId
- agentId

Outputs:
- `{ currentState, projectLivingState, recentUpdates, activeTaskHints }`

#### A3. `src/core/usecases/wiki-working-set.ts`
Responsibilities:
- resolve wiki root + entrypoint
- identify canonical pages for current task/project
- identify supporting pages, rule pages, runbook pages
- produce inspectable page-level working surface

Inputs:
- wiki root / config
- state pack
- query/task text
- current agent id

Outputs:
- `{ wikiRoot, entrypoint, canonicalPages, taskPages, rulePages, runbookPages, supportingPages }`

Important:
- page-level, not snippet-only
- do not answer on behalf of agent
- do not over-summarize away the working surface

#### A4. `src/core/usecases/graph-assisted-expansion.ts`
Responsibilities:
- use graph entities/relationships to refine page prioritization
- expand one-hop page candidates when justified
- add graph hints to working set metadata

Inputs:
- graph entities/relationships
- working set draft

Outputs:
- `{ graphHints, expandedPages }`

#### A5. Re-scope `src/core/retrieval-policy.ts`
Responsibilities after redesign:
- remain supplementary only
- rerank/support snippets after working set is already constructed
- never become the primary cognition layer again

### Files expected to change
- `src/hooks/auto-recall.ts`
- `src/core/retrieval-policy.ts`
- `src/core/usecases/semantic-memory-usecase.ts`
- new files listed above

## Epic B — Runtime contract redesign

### Objective
Make ASM inject a wiki-first working surface into relevant runs.

### Deliverables
1. New prompt/runtime contract shape
2. Updated auto-recall hook behavior
3. Clear separation between primer and write-back

### Planned changes

#### B1. Refactor `src/hooks/auto-recall.ts`
Current role:
- gather state + graph + semantic memories
- inject snippet-oriented prompt block

New role:
- orchestrate:
  1. run mode resolution
  2. state pack build
  3. wiki working-set build
  4. graph-assisted expansion
  5. supporting recall supplement
  6. prompt injection of working surface

#### B2. New prompt block shape
Expected conceptual sections:
- `asm-runtime`
- `current-state`
- `project-living-state`
- `wiki-working-set`
- `supporting-recall`

Need to keep prompt concise enough for context limits while still pointing to actual pages to inspect.

#### B3. Primer-only rule
The hook must not pretend to do full wiki research on behalf of the agent.
It should:
- provide the working surface
- not replace the agent's own page reading and reasoning

### Files expected to change
- `src/hooks/auto-recall.ts`
- possibly `src/core/precedence/recall-precedence.ts` or equivalent formatting helpers

## Epic C — Install/setup orchestration

### Objective
After ASM install/setup, the OpenClaw environment is bootstrapped into wiki-first mode system-wide.

### Deliverables
1. ASM setup/init orchestration entrypoint
2. Reinforcement surface discovery
3. Idempotent patch application
4. Managed-state recording

### Planned modules

#### C1. `src/core/usecases/install-orchestration.ts`
Responsibilities:
- apply runtime config defaults
- discover environments/workspaces
- trigger reinforcement patching if needed
- record applied state

#### C2. `src/core/usecases/agent-surface-scan.ts`
Responsibilities:
- discover agent workspaces
- discover reinforcement surfaces (e.g. AGENTS.md and similar bootstrap files)
- return normalized patch targets

#### C3. `src/core/usecases/reinforcement-patch.ts`
Responsibilities:
- patch reinforcement blocks if missing
- skip if already present
- support marker-based replace/upgrade
- idempotent reruns

#### C4. CLI/entrypoint integration
Potential integration points:
- existing init/setup command path
- ASM-specific init-openclaw flow
- explicit user-invoked ASM setup command

### Managed state needs
Need a durable way to remember:
- which surfaces were patched
- block version
- last applied timestamp
- whether rerun should replace or skip

### Files expected to change
- `scripts/init-openclaw.mjs`
- possibly `src/cli/platform-installers.ts`
- new orchestration modules above

## Epic D — Verification and migration safety

### Objective
Verify that the redesign works without regressing capture/write-back and without duplicating setup patches.

### Deliverables
1. Unit/integration tests for run-mode resolution and working-set building
2. Integration tests for prompt injection contract
3. Install/setup idempotence tests
4. Regression tests for continuation write-back

### Planned test coverage

#### D1. Run mode tests
- trivial user message -> `light`
- implementation/debug/planning/continuation -> `wiki-first`
- write-back lifecycle -> `write-back`

#### D2. State pack tests
- private/team/public precedence
- freshness wins
- `project_living_state` selection

#### D3. Wiki working-set tests
- current task present -> canonical task/project pages selected
- rule/runbook pages included when relevant
- supporting pages limited/bounded

#### D4. Prompt contract tests
- prompt contains wiki root and entrypoint
- prompt contains canonical page references
- prompt no longer depends only on semantic snippets

#### D5. Install/setup orchestration tests
- no patch target -> no-op
- missing reinforcement block -> add
- existing block -> skip
- rerun remains idempotent

#### D6. Continuation regression tests
- write-back path still works
- no local fake distill/extractor returns
- no env-based distill ownership returns

## 3. Execution order

### Phase 1 — Foundation for read path
1. Add `run-mode-resolver.ts`
2. Add `state-pack-builder.ts`
3. Add `wiki-working-set.ts`
4. Add `graph-assisted-expansion.ts`
5. Refactor `auto-recall.ts` to use new orchestration flow

### Phase 2 — Runtime contract stabilization
1. Redesign prompt block shape
2. Update/centralize formatting helpers
3. Verify `wiki-first` runs receive working surface instead of snippet-only context

### Phase 3 — Install/setup orchestration
1. Add surface scan + reinforcement patch modules
2. Integrate with ASM init/setup flow
3. Add managed-state persistence for patching
4. Verify idempotent reruns

### Phase 4 — Regression / verification
1. Run focused tests for read path
2. Run full plugin tests
3. Verify write-back/continuation remains intact
4. Verify no fake/local distill regressions return

## 4. Out of scope for the first implementation pass

1. Introducing a large new tool surface for wiki interaction
2. Replacing filesystem/wiki reading with mandatory custom wiki tools
3. Rewriting write-back architecture from scratch
4. Expanding into unrelated plugin install security-scan changes in OpenClaw core

## 5. Key constraints to preserve

1. No local fake distill/extractor path reintroduction
2. No env-based distill ownership reintroduction
3. No reduction of wiki to snippet-only memory role
4. SlotDB and graph must remain integrated, not sidelined
5. Setup/init must be rerunnable and safe

## 6. First implementation checkpoint

The first meaningful checkpoint should prove all of the following:
- `auto-recall` no longer behaves as a snippet-first injector
- relevant runs receive a page-level wiki working set
- SlotDB state still appears correctly
- graph signals still influence page selection
- continuation write-back still functions

## 7. Final note

This plan is intentionally structured to derive directly from the redesign spec.
Implementation should proceed by epic and checkpoint, not by ad hoc isolated patches.
