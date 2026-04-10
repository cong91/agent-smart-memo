# ASM Wiki-First System Redesign Spec

Date: 2026-04-09
Project: agent-smart-memo
Status: research/spec foundation

## 1. Problem statement

ASM hiện có write-path tương đối rõ:
- auto-capture -> distill -> apply -> write wiki / SlotDB / graph

Nhưng read-path hiện đang sai vai trò:
- auto-recall chủ yếu query-based retrieval + inject snippets
- wiki đang bị dùng như backing store / semantic source phụ trợ
- agent chưa thực sự làm việc trực tiếp trên wiki như một persistent working knowledge base

Điều này lệch với pattern trong `llm-wiki.md`:
- wiki phải là lớp tri thức trung tâm mà LLM làm việc trực tiếp trên đó
- không chỉ là nơi để lấy snippet context trước khi trả lời

## 2. User intent distilled

User yêu cầu thiết kế lại ASM sao cho:
1. Sau khi cài ASM, hệ thống phải được bao quát theo wiki-first mode
2. Không được chỉ vá cục bộ bằng `AGENTS.md`
3. Nếu cần reinforce qua `AGENTS.md` thì installer/setup phải tự tìm và patch đồng bộ các surface liên quan
4. Không được giải quá tay bằng tool abstraction mới nếu chưa cần
5. Phải giữ cả 3 hệ thống:
   - wiki
   - SlotDB
   - graph
6. Continuation vẫn là lane đúng để distill / write-back vào wiki

## 3. Core diagnosis

### 3.1 What is wrong today

Current ASM read-path is snippet-first.
This causes:
- agent may answer from session-local memory instead of wiki-grounded context
- recall may miss because query-based retrieval is conditional
- wiki is not treated as the primary cognitive working surface
- system behavior is not generalized at install/runtime level

### 3.2 What `llm-wiki.md` implies

The correct pattern is:
- raw sources are immutable truth
- wiki is persistent compiled knowledge
- LLM operates on the wiki directly
- query should read wiki pages / index / relevant canonical pages
- answers/analysis can be filed back into the wiki

This means ASM must move from:
- snippet recall over wiki-backed memory

to:
- wiki-first working-set construction

## 4. Design target

ASM should become a system-wide cognitive operating layer with:

1. Persistent knowledge layer
   - Wiki = primary synthesized knowledge surface
   - SlotDB = structured state / precedence / fast context layer
   - Graph = relation / expansion / rerank layer

2. Wiki-first read path
   - relevant agent runs receive a wiki working set before reasoning/action

3. Stable write path
   - continuation distill/apply writes back into wiki / SlotDB / graph

4. Install/setup orchestration
   - after install, relevant environments are bootstrapped into wiki-first mode
   - reinforcement surfaces are patched if needed
   - rerunnable, idempotent

## 5. Architectural shift required

### 5.1 Old model
- capture/write path exists
- recall injects snippets
- agent reasons mostly outside wiki

### 5.2 New model
- ASM builds a working set on top of wiki + SlotDB + graph
- agent reasons on that working set
- continuation writes back the distilled result

This is the key shift:
- from `snippet recall`
- to `working-set construction`

## 6. System layers

### Layer A. Persistent knowledge layer

#### Wiki
Role:
- canonical synthesized knowledge
- pages, summaries, runbooks, rules, project/task pages, index

#### SlotDB
Role:
- current state
- project_living_state
- precedence across private/team/public
- recent updates / structured state / operating flags

#### Graph
Role:
- entities/relationships
- adjacency / expansion hints
- relation-aware rerank and page prioritization

### Layer B. Read path / working set builder

Role:
- build the effective context surface for an agent run

Expected output:
- run mode
- state pack
- wiki working set
- graph hints
- supporting recall pack

### Layer C. Runtime integration

Role:
- classify run type
- inject working-set primer
- ensure relevant runs operate in wiki-first mode

### Layer D. Install/setup/bootstrap

Role:
- configure runtime contract
- patch reinforcement surfaces when necessary
- ensure idempotent reruns

## 7. Read-path redesign

### 7.1 Run modes
At minimum ASM should classify runs into:

- `light`
  - trivial/non-project-dependent interactions
- `wiki-first`
  - implementation, debugging, planning, continuation, investigation, project-specific work
- `write-back`
  - distill/apply/continuation commit-back behavior

### 7.2 State pack
Source: SlotDB

Responsibilities:
- merge private/team/public state with freshness precedence
- load `project_living_state`
- load recent updates
- expose current project/task/phase/focus

### 7.3 Wiki working set
Source: wiki pages/index/catalog

Responsibilities:
- identify wiki root and canonical entrypoint(s)
- choose canonical pages for current task/project
- choose supporting pages, rules, runbooks
- assemble an inspectable working surface for the agent

Important:
- page-level surface, not only snippets
- wiki is primary

### 7.4 Graph-assisted expansion
Source: graph

Responsibilities:
- entity/relationship signals
- candidate page expansion
- prioritization/rerank hints

### 7.5 Supporting recall pack
Source: semantic memory / retrieval policy

Responsibilities:
- remain supplementary only
- provide supporting snippets, not primary cognition layer

## 8. Prompt/runtime contract

Prompt contract should move from snippet-heavy injection to working-surface injection.

Expected conceptual contract:
- current run mode
- wiki root / entrypoint
- canonical pages to inspect
- current state / living state
- rule/runbook pages
- optional supporting recall

Important:
- prompt should not attempt to replace wiki reading with oversized summaries
- prompt should point the agent to the correct working surface

## 9. Install/setup orchestration

Install/setup orchestration is not the full solution, but it is required for system-wide adoption.

It should:
1. set runtime contract defaults
2. discover relevant agent environments / workspaces / instruction surfaces
3. patch reinforcement blocks if missing
4. skip if already present
5. support safe reruns
6. record managed state

This includes possible AGENTS.md/bootstrap reinforcement, but that is only one subcomponent.

## 10. AGENTS.md role

`AGENTS.md` is not the primary solution.

It should only serve as:
- reinforcement layer
- human-readable operating policy
- backup behavior stabilizer

The main solution must still work at install/runtime contract level even if AGENTS.md is absent or partially inconsistent.

## 11. Non-goals / things to avoid

1. Do not regress to local fake distill / fake extractor paths
2. Do not reintroduce env-based distill ownership
3. Do not treat snippet recall as a sufficient replacement for wiki working-set construction
4. Do not over-index on adding new tools before the read-path/runtime contract is corrected
5. Do not reduce the architecture to only AGENTS.md patching

## 12. Design implications for implementation planning

Implementation planning should be centered on these epics:

### Epic A. Read-path refactor
- turn auto-recall into a working-set orchestrator
- introduce run-mode resolver
- introduce wiki working-set builder
- reposition retrieval-policy as supplementary

### Epic B. Runtime contract
- formalize wiki root / entrypoint / run-mode injection
- ensure relevant agent runs receive wiki-first guidance and surface

### Epic C. Install/setup orchestration
- bootstrap config
- scan and patch reinforcement surfaces if needed
- make idempotent / rerunnable

### Epic D. Verification
- verify relevant runs actually operate on wiki-first working sets
- verify write-back still works
- verify SlotDB + graph remain integrated in the loop

## 13. Final architectural conclusion

The correct redesign is:
- keep the existing write path directionally intact
- refactor the read path from `snippet recall` to `wiki-first working-set construction`
- treat wiki as the primary knowledge surface
- treat SlotDB as the state/control layer
- treat graph as the relation/routing layer
- add install/setup orchestration so the whole OpenClaw environment can be bootstrapped into this mode after ASM installation

This spec is the foundation document. Detailed implementation planning should derive from it next, not precede it.
