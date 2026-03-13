# ASM-84 — [ASM v5.1][Setup UX] Global asm CLI with setup-openclaw flow

## Scope
- Strategy: `code_light`
- Issue scope only: expose global CLI command `asm` and implement `asm setup-openclaw` UX flow.
- Keep backward compatibility with existing `npm run init-openclaw` (ASM-83).
- No runtime core changes outside setup UX and package entry wiring.

## Jira context captured
Issue summary and description requirements (validated from Jira ASM-84):
1. Add package-level global command `asm` via `bin` entry.
2. Support command `asm setup-openclaw` (and extensible structure for later subcommands).
3. `setup-openclaw` flow:
   - check `openclaw` binary exists
   - detect plugin install state
   - install plugin if missing (`openclaw plugins install @mrc2204/agent-smart-memo`)
   - invoke existing bootstrap config logic from ASM-83
   - print next steps guidance
4. Do not break old command path (`npm run init-openclaw`).
5. Add minimal parser/dispatch tests.
6. Update README to document new best UX path.

## Implementation details

### 1) Global CLI entrypoint
- Added file: `bin/asm.mjs`
- Added package `bin` mapping:
  - `"asm": "bin/asm.mjs"`
- Added script shortcut for local invocation:
  - `npm run asm`

### 2) Command parser & dispatch
`bin/asm.mjs` includes:
- `parseAsmCliArgs(argv)`
  - supports `asm setup-openclaw`
  - supports alias form `asm setup openclaw`
  - supports `help` / `-h` / `--help`
- `main(argv)` dispatches to setup flow or help.

### 3) setup-openclaw orchestration flow
`runSetupOpenClawFlow()` behavior:
1. `openclaw --version` to validate CLI availability.
2. Detect plugin installed via:
   - `openclaw plugins list --json` (preferred)
   - fallback `openclaw plugins list` (text)
3. If plugin missing:
   - run `openclaw plugins install @mrc2204/agent-smart-memo`
4. Call ASM-83 bootstrap logic:
   - `runInitOpenClaw({ interactive: true })`
5. Print next-step verify guidance.

### 4) Packaging/publish visibility
Updated `package.json` `files` list so npm package includes:
- `bin/`
- `scripts/init-openclaw.mjs`
(needed because `.npmignore` excludes `scripts/` by default)

### 5) Backward compatibility
Preserved:
- Existing command `npm run init-openclaw`
- Existing bootstrap script behavior (no breaking changes in ASM-83 flow)

## Test coverage
Added test file:
- `tests/test-asm-cli.ts`

Covered checks:
1. CLI parser mapping (`help`, `setup-openclaw`, alias form).
2. Shell runner normalization.
3. Plugin detection path for `plugins list --json`.
4. End-to-end setup flow behavior with mocked runner:
   - missing plugin -> installs plugin -> invokes init flow.
5. Failure path when `openclaw` binary missing (fail early, do not invoke init).

## README update
Added section:
- `## 8) Setup UX (ASM-84) — global asm CLI`
- Documents new best path:
  - `npm install -g @mrc2204/agent-smart-memo`
  - `asm setup-openclaw`
- Explicitly states backward compatibility with `npm run init-openclaw`.

## Validation executed
- `npm run build:openclaw` ✅
- `npm run test:asm-cli` ✅
- `npx tsx tests/test-init-openclaw.ts` ✅

## Files modified
- `bin/asm.mjs` (new)
- `tests/test-asm-cli.ts` (new)
- `package.json`
- `README.md`
- `docs/architecture/ASM-84-global-asm-cli-setup-openclaw.md` (this doc)
