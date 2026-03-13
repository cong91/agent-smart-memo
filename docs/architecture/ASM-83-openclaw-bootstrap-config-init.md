# ASM-83 — OpenClaw bootstrap config init for agent-smart-memo

## Scope
Implement a local setup UX command for OpenClaw so operators can initialize `agent-smart-memo` config without manually editing `~/.openclaw/openclaw.json`.

## Delivered
- Added bootstrap wizard script: `scripts/init-openclaw.mjs`
- Added npm command: `npm run init-openclaw`
- Added regression tests for merge/validation behavior: `tests/test-init-openclaw.ts`
- Follow-up integration: register `/project` command behavior in plugin runtime and bootstrap Telegram custom command menu entry for onboarding discoverability.

## Behavior
The bootstrap command:
1. Detects config path from:
   - `OPENCLAW_CONFIG_PATH` / `OPENCLAW_RUNTIME_CONFIG`
   - fallback `${OPENCLAW_STATE_DIR}/openclaw.json`
2. Prompts interactive fields:
   - qdrant host/port/collection
   - llm base url/model/api key
   - embedding backend/model/dimensions
   - slotDbDir
   - map `plugins.slots.memory = agent-smart-memo`
   - telegram onboarding command menu entries (default includes `project`, extensible)
3. Validates basic input format
4. Shows preview diff before writing
5. Creates backup file before overwrite:
   - `openclaw.json.bak.<timestamp>`
6. Merges plugin block safely:
   - `plugins.allow`
   - `plugins.slots.memory`
   - `plugins.entries["agent-smart-memo"]`
7. Also maintains Telegram custom command menu safely:
   - `channels.telegram.customCommands` includes `/project` (normalized as `project`)
   - preserves existing custom commands, dedupes and normalizes command names
8. Registers plugin slash behavior (`/project`) through OpenClaw `registerCommand` and routes to `project.telegram_onboarding` (preview/confirm)
9. Preserves unrelated existing fields and plugin entries

## Verification
- `npm run build:openclaw` ✅
- `npx tsx tests/test-init-openclaw.ts` ✅
- `npx tsx tests/test-project-registry.ts` ✅
- `npx tsx tests/test-telegram-addproject-command.ts` ✅
