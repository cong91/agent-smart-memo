# ASM setup-openclaw command spec

Date: 2026-04-10
Status: proposed execution spec
Scope: add a practical command that bootstraps the repo/OpenClaw environment into ASM wiki-first mode without turning `AGENTS.md` into source-of-truth.

## Goal
Provide one idempotent setup command for real-world usage, tentatively named `asm setup-openclaw`, that:
- scans the current repo/workspace
- ensures ASM config/runtime defaults exist
- bootstraps `memory/wiki` entrypoint files if missing
- patches a managed reinforcement block into `AGENTS.md` if missing or stale
- skips cleanly when the environment is already correct

## Non-goals
- Do not dump full project knowledge into `AGENTS.md`
- Do not make `AGENTS.md` the primary knowledge source
- Do not bypass wiki-first runtime contract
- Do not reintroduce fake local distill/extractor behavior

## Architectural position
- SlotDB = runtime state/control
- Markdown under `memory/wiki/` = agent-facing working surface
- QMD/backend = canonical persistence/backend truth
- Graph = support/routing
- `AGENTS.md` = reinforcement/navigation primer only

## Command contract
Tentative interface:

```bash
asm setup-openclaw
```

Optional flags may be added later, but phase-1 target is a single safe default command.

## Required behavior
### 1. Scan / detect
- detect repo root
- detect or resolve ASM config path
- detect `memory/wiki` root
- detect `AGENTS.md` presence
- detect whether managed ASM reinforcement block is present/up-to-date

### 2. Bootstrap wiki surface
Ensure these exist if missing:
- `memory/wiki/index.md`
- `memory/wiki/schema.md`
- `memory/wiki/log.md`
- base folders such as `memory/wiki/live/`, `memory/wiki/briefings/`, `memory/wiki/drafts/`, `memory/wiki/raw/`

### 3. Patch `AGENTS.md`
Insert or update a managed block only, e.g.:
- wiki-first read order
- wiki root / entrypoint guidance
- storage boundary summary
- explicit rule that `AGENTS.md` is not full knowledge

The command must:
- create `AGENTS.md` if absent
- update only the managed block if present but stale
- skip if already correct
- avoid duplicate insertion

### 4. Ensure config/runtime defaults
Ensure minimum ASM config/runtime defaults required for wiki-first usage are present, including the equivalent of:
- `projectWorkspaceRoot`
- `slotDbDir`
- `wikiDir`

### 5. Idempotency
Repeated runs must be safe:
- no duplicate `AGENTS.md` blocks
- no duplicate wiki bootstrap files beyond deterministic updates
- no destructive rewrite of user-authored content outside the managed block

## Managed AGENTS block requirements
The managed block must be clearly delimited, e.g.:
- `ASM:BEGIN MANAGED BLOCK`
- `ASM:END MANAGED BLOCK`

Content must remain short and reinforcement-oriented:
- read order
- wiki-first contract
- storage boundary
- rules against snippet-first cognition and AGENTS-as-truth

## Output contract
Command should report:
- changed files
- created files
- skipped files
- status: pass / skip / fail
- concise note on whether environment is now wiki-first ready

## Acceptance criteria
- command exists in runnable form
- patching `AGENTS.md` is managed and idempotent
- wiki bootstrap files/folders are created when missing
- runtime/config defaults are ensured sufficiently for wiki-first usage
- rerun is safe and produces skip/update behavior instead of duplication
- evidence includes changed files and PASS/FAIL verification

## Relationship to current ASM redesign
This command is a reinforcement/setup layer derived from the completed r5t wiki-first redesign.
It extends the practical usability of ASM after install, but does not replace:
- wiki-first runtime contract
- SlotDB truth precedence
- continuation-owned write-back semantics
- QMD canonical backend vs markdown working-surface boundary
