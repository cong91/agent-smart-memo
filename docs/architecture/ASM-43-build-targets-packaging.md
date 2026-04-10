# ASM-43 — Build Targets, Packaging Rules, and Publish Flow

> **Current scope (2026-04-09):** Active build/package runtime scope is OpenClaw (plugin) plus optional core artifact.

## Goal

Introduce module/runtime-specific artifacts without breaking existing OpenClaw plugin behavior.

## Build targets

- `build:plugin` → compiles OpenClaw plugin entry (`src/index.ts`) into `dist/`
- `build:plugin` → legacy alias to `build:plugin`
- `build:core` → compiles runtime-agnostic entry (`src/entries/core.ts`) into `dist-core/`

Compatibility rule:

- `npm run build` remains plugin-default for existing consumers.
- `npm run build` now runs `build:plugin` directly into canonical `dist/` (no sync step).

## Packaging rules

Artifacts are prepared in `artifacts/npm/<target>/` using `scripts/prepare-package-target.mjs`.

### OpenClaw package (`@mrc2204/agent-smart-memo`)

- Includes: OpenClaw build output (`dist/`), `openclaw.plugin.json`, README/LICENSE/config.
- Contains `openclaw.extensions` metadata.
- Remains backward-compatible plugin package.

### Core package (`@mrc2204/agent-smart-memo-core`)

- Includes: `dist-core` only + README/LICENSE/config.
- Exposes core contracts/use-cases for external runtime adapters.

## Publish flow

Local commands:

- `npm run package:<target>` to prepare artifact directory
- `npm run pack:<target>` to create `.tgz`
- `npm run publish:<target>` to publish prepared package

Publish helper:

- `scripts/publish-target.mjs <target> [--dry-run]`

## CI/CD updates

Workflow `.github/workflows/publish.yml` now:

1. Matrix-builds active targets (`openclaw`, `core`).
2. Packages and packs each target.
3. Uploads packed artifacts.
4. Runs OpenClaw-focused tests for active runtime target coverage.
5. Supports manual dispatch publish with selected target + dry-run option.

## Non-goals / current limitations

- This pass prepares build/package/publish pipeline structure only.
- No claim of actual npm publish success unless run with valid npm token/auth at publish time.
- Some shared runtime code still retains legacy env naming (`OPENCLAW_*`) for compatibility.
