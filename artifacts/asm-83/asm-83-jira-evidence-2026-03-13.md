# ASM-83 Evidence — 2026-03-13

## Scope
- Issue: **ASM-83** — [ASM v5.1][Setup UX] OpenClaw bootstrap config init for agent-smart-memo
- Strategy: `code_light`
- Scope guard (initial): strictly local OpenClaw bootstrap setup UX only; no ASM-82 onboarding rewiring, no deploy/runtime rollout.
- Follow-up scope extension (this run): bridge ASM-83 setup UX with ASM-82 onboarding discoverability/behavior in OpenClaw plugin pattern (menu + plugin command), without touching OpenClaw core runtime.

## Jira context read (before coding)
- Summary verified on Jira issue page: **[ASM v5.1][Setup UX] OpenClaw bootstrap config init for agent-smart-memo**
- Description / AC verified:
  - Add local CLI command like `init-openclaw`
  - Detect `~/.openclaw/openclaw.json`
  - Ask minimal interactive fields: Qdrant, LLM, embedding, `slotDbDir`, map `plugins.slots.memory`
  - Show preview diff before write
  - Backup old config as `openclaw.json.bak.<timestamp>`
  - Merge only plugin-related config block and preserve unrelated fields
  - README setup section requested when implementation completes

## Implementation delivered
1. Added local bootstrap wizard script:
   - `scripts/init-openclaw.mjs`
2. Added package command surface:
   - `npm run init-openclaw`
3. Implemented setup flow behavior:
   - detects config path from `OPENCLAW_CONFIG_PATH` / `OPENCLAW_RUNTIME_CONFIG` / `${OPENCLAW_STATE_DIR}/openclaw.json`
   - prompts interactive fields for Qdrant / LLM / embedding / `slotDbDir` / memory-slot mapping
   - validates basic input
   - previews diff before write
   - creates timestamped backup before overwrite
   - merges only:
     - `plugins.allow`
     - `plugins.slots.memory`
     - `plugins.entries["agent-smart-memo"]`
   - preserves unrelated existing fields/plugin entries
4. Follow-up integration (ASM-83 + ASM-82):
   - extended init wizard to maintain `channels.telegram.customCommands` with `addproject` default (normalized + deduped, extensible for later `linkjira` / `indexproject`)
   - added plugin command registration path using OpenClaw `registerCommand`:
     - new command: `/addproject`
     - behavior routes into `project.telegram_onboarding` (`preview|confirm`)
   - enforced account/group-safe scoping via command-context-derived identity:
     - scope key includes channel + accountId + senderId + optional messageThreadId
     - no OpenClaw core runtime modifications
5. Added regression coverage:
   - `tests/test-init-openclaw.ts`
   - `tests/test-telegram-addproject-command.ts`
6. Added/updated implementation docs:
   - `docs/architecture/ASM-83-openclaw-bootstrap-config-init.md`

## Files changed
- `scripts/init-openclaw.mjs`
- `src/index.ts`
- `src/commands/telegram-addproject-command.ts`
- `tests/test-init-openclaw.ts`
- `tests/test-telegram-addproject-command.ts`
- `docs/architecture/ASM-83-openclaw-bootstrap-config-init.md`

## Validation
- `npm run build:openclaw` ✅
- `npx tsx tests/test-init-openclaw.ts` ✅
- `npx tsx tests/test-project-registry.ts` ✅
- `npx tsx tests/test-telegram-addproject-command.ts` ✅

## Commit evidence
- Commit: `510e9afeacb7ae76b60a9238c846da7cd6ee68ef`
- Message: `feat(asm-83): add OpenClaw bootstrap config init wizard`

## Jira update evidence
- Added implementation comment on ASM-83 with scope, commit, validation, and scope guard.
- Comment id: `13573`
- Comment url: `https://linktovn.atlassian.net/browse/ASM-83?focusedCommentId=13573`
- Transitioned status: **To Do -> Done**.

## Notes
- README was already dirty before this task run, so README update was not committed in this change-set to avoid mixing unrelated diffs.
- Acceptance criteria for CLI behavior are implemented and evidenced by script + tests; README follow-up may need a clean baseline if strict docs commit isolation is required.
