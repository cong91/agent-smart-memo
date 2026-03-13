# Paperclip local smoke/debug checklist (ASM plugin)

Use after installing local artifact into Paperclip host.

## Install artifact
- [ ] Installed from local folder path or `.tgz`
- [ ] Plugin appears in Paperclip plugin list

## Worker + config
- [ ] Worker starts without crash
- [ ] `initialize()` succeeds (`ok=true`)
- [ ] `health()` returns `initialized=true`
- [ ] Config validation has no schema errors

## Tool surfaces
- [ ] `memory_capture` returns `ok=true`
- [ ] `memory_recall` returns `ok=true` (with seeded memory)
- [ ] `memory_feedback` accepts valid payload

## Event/job hooks
- [ ] Event `activity.logged` is accepted
- [ ] Event `agent.run.finished` is accepted
- [ ] Job `asm_capture_compact` executes with `ok=true`
- [ ] Job `asm_fallback_sync` executes with `ok=true`

## Fallback behavior
- [ ] Markdown fallback file is generated when deferred/fallback capture occurs
- [ ] Fallback entry stays queue/audit path
- [ ] Fallback-only entry does **not** appear as source-of-truth recall result

## Practical evidence to collect
- [ ] Command output log for install step
- [ ] Command output log for smoke script
- [ ] Path of installed artifact used in host
- [ ] Any runtime error snippets (if fail)
