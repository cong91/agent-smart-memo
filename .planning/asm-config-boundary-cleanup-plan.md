# ASM config boundary cleanup plan

## Goal
Finish phase 3 config-boundary cleanup in `agent-smart-memo`.

## Required changes
1. Deprecate or neutralize `src/config.ts` so it no longer behaves like a competing runtime config source.
2. Patch `bin/opencode-mcp-server.mjs` to resolve runtime config from shared ASM config (`asmConfigPath` / `~/.config/asm/config.json`) instead of legacy fallback defaults.
3. Revisit `src/cli/platform-installers.ts` so bootstrap defaults are clearly bootstrap-only and do not silently masquerade as runtime source-of-truth after shared config exists.

## Constraints
- Use OpenCode CLI to perform code edits.
- Do not introduce new hidden hardcoded runtime defaults that override shared ASM config.
- Preserve bootstrap usability for first-time setup, but runtime paths must prefer shared config and fail clearly when required fields are missing.
- After code changes, run focused validation/build and summarize what changed.

## Deliverables
- Updated code in repo
- Short summary of exact files changed and why
- Validation results (build/tests if run)
