# ASM-103 Kickoff Plan

Date: 2026-03-16
Task: `ASM-103` — Shared config home and multi-platform config lifecycle

## Goal

Define the canonical shared config home and config lifecycle for ASM SDK so all clients (OpenClaw, Paperclip, future OpenCode) can read one consistent platform configuration.

## Problem to solve

Current config behavior evolved from plugin/runtime needs. For ASM SDK, config can no longer feel runtime-local or client-specific.

We need one source of truth for:
- where shared config lives
- how config is loaded
- how env overrides work
- how clients bootstrap safely
- how old config surfaces migrate without breaking current users

## Questions this task must answer

1. What is the canonical shared config home path?
2. What config file(s) belong there?
3. What is the precedence order between defaults / config file / env / runtime overrides?
4. Which config is platform-global vs client-local?
5. How do OpenClaw / Paperclip / OpenCode consume the same shared config safely?
6. What compatibility path exists for current installs/config layouts?

## Proposed shape to define

### Shared config home
A single canonical ASM SDK home, e.g. under the user home directory.

### Config categories
At minimum distinguish:
- platform/global config
- project/workspace config
- client/runtime-specific adapter config

### Precedence
Need deterministic precedence, for example:
1. explicit runtime override
2. environment variable
3. shared config file
4. built-in defaults

## Scope

### In scope
- config home path
- config file structure/lifecycle
- precedence rules
- migration compatibility direction
- read model for multiple clients

### Out of scope
- package/install mechanics in detail (`ASM-104`)
- OpenCode retrieval semantics in detail (`ASM-106`)
- project destructive lifecycle in detail (`ASM-107`)

## Immediate first slice

1. Inspect current config surfaces in repo:
- `openclaw.plugin.json`
- `src/index.ts`
- `scripts/init-openclaw.mjs`
- runtime env usage in relevant code paths

2. Classify current config into:
- platform-global
- project-facing
- adapter/runtime-local

3. Propose canonical shared config home + precedence model.

## Success criteria for kickoff slice
- current config surface inventoried
- shared config home proposal documented
- precedence rules documented
- migration direction documented
- no ambiguity left about where future ASM SDK config should live
