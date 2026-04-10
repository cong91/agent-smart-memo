# ASM init-setup vs install-openclaw UX correction

## Goal

Fix CLI UX/product semantics:

- `asm init-setup` = shared ASM config bootstrap/wizard
- `asm install openclaw` = bind OpenClaw to existing shared ASM config only

## Required changes

1. `asm init-setup`
   - ask whether to run setup wizard now
   - if yes: prompt full config fields with defaults
   - if no:
     - if config exists, keep existing config
     - if config missing, create minimal config and explain it can be edited later
2. `asm install openclaw`
   - must auto-detect `~/.config/asm/config.json`
   - if missing, instruct user to run `asm init-setup` first
   - if present, patch OpenClaw config by binding `plugins.entries.agent-smart-memo.config.asmConfigPath`
   - do not ask for qdrant/llm/embed/slotDbDir/projectWorkspaceRoot again
3. Keep target install semantics separate for openclaw/opencode.

## Constraints

- Use OpenCode to make code changes.
- Keep CLI-first and plugin-first flows distinct.
- Avoid reintroducing runtime fallback confusion.
- Run focused validation after edits.
