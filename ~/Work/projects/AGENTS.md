<!-- ASM-WIKI-FIRST-BOOTSTRAP:START version=2026-04-10 -->
## ASM wiki-first bootstrap (managed by ASM)

Read order:
1. Start from `memory/wiki/index.md`, `schema.md`, and `log.md`.
2. Treat wiki markdown as the working surface for repo-specific context.
3. Resolve runtime paths from ASM shared config / plugin runtime, not from this file.

Storage boundary:
- SlotDB/runtime state = control/runtime truth.
- `memory/wiki/` markdown = agent-facing working surface.
- QMD/backend state remains canonical persistence.

Rules:
- Keep this file reinforcement-only, not full project memory.
- Do not treat AGENTS.md snippets as source-of-truth over wiki/runtime state.
- Prefer wiki-first investigation over snippet-first cognition.
<!-- ASM-WIKI-FIRST-BOOTSTRAP:END -->
