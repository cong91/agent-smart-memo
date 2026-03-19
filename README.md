# Agent Smart Memo

> **ASM v5.1** is a super memory platform for coding agents: **conversation memory + project memory + retrieval/control plane**, delivered through a single package and a CLI-first install flow.

`@mrc2204/agent-smart-memo` provides a project-aware memory layer that can be installed into multiple runtimes while keeping one shared memory/config model.

Today ASM provides:
- conversation/runtime continuity
- structured slot memory
- semantic retrieval
- graph memory
- project registry + onboarding
- repo-aware indexing / reindexing
- lineage-aware engineering context retrieval
- CLI-based platform install flows for OpenClaw, Paperclip, and OpenCode

This means ASM is best understood as:

> **a shared memory platform for coding agents, with OpenClaw as the primary runtime and Paperclip/OpenCode as supported adapters**

---

## 1) Core mental model

ASM has 3 practical layers.

### A. Conversation memory
Used for runtime continuity:
- `memory_search`
- `memory_store`
- `memory_slot_*`
- `memory_graph_*`
- auto-capture / auto-recall

### B. Project memory
Used for engineering context:
- project registry
- repo root / repo remote identity
- project aliasing
- Jira linkage
- onboarding + index triggers
- lifecycle-aware retrieval boundaries

### C. Retrieval/control plane
Used to assemble better context for coding agents:
- semantic recall
- lexical/project filtering
- file/symbol/task lineage
- deterministic project-aware retrieval
- platform install / bootstrap flows

If you only remember one sentence, remember this:

> **ASM is a super memory platform for coding agents: conversation memory + project memory + runtime delivery in one package.**

---

## 2) Runtime targets

### OpenClaw
Primary target today.

Includes:
- OpenClaw plugin entry
- tools / hooks / runtime wiring
- CLI bootstrap flow
- shared ASM config integration

Install:
```bash
asm install openclaw
```

### Paperclip
Uses the same shared memory core through a Paperclip adapter.

Install:
```bash
asm install paperclip
```

### OpenCode
Uses the same package and shared config, with MCP/local runtime wiring.

Install:
```bash
asm install opencode
```

---

## 3) Install ASM

There are currently **two supported install flows**.

### Flow A — CLI-first (recommended for ASM CLI usage)
Install the CLI globally first:

```bash
npm install -g @mrc2204/agent-smart-memo
```

Then initialize shared config:

```bash
asm init-setup --yes
```

This creates or updates:
```text
~/.config/asm/config.json
```

Then install a runtime target:

```bash
asm install openclaw
asm install paperclip
asm install opencode
```

### Flow B — Plugin-first (direct OpenClaw plugin install)
If you only want the OpenClaw plugin directly, install it through OpenClaw:

```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

Then continue with OpenClaw-side config/bootstrap as needed.

### Important note
The command below is **not the recommended primary flow right now**:

```bash
npx @mrc2204/agent-smart-memo install
```

Use the two supported flows above until CLI bootstrap is fully separated/standardized.

---

## 4) Shared config source-of-truth

ASM now uses a shared config model.

### Canonical shared config
```text
~/.config/asm/config.json
```

### What lives there
Core fields such as:
- `projectWorkspaceRoot`
- `storage.slotDbDir`
- `qdrantHost`
- `qdrantPort`
- `qdrantCollection`
- `qdrantVectorSize`
- `llmBaseUrl`
- `llmApiKey`
- `llmModel`
- `embedBaseUrl`
- `embedBackend`
- `embedModel`
- `embedDimensions`
- `autoCaptureEnabled`
- `autoCaptureMinConfidence`
- `contextWindowMaxTokens`
- `summarizeEveryActions`

### Platform-local config
Platform config should stay minimal.

For OpenClaw, `~/.openclaw/openclaw.json` should mainly keep:
- `enabled`
- `asmConfigPath`
- adapter-local overrides only when truly needed

Example OpenClaw plugin entry:

```json
{
  "enabled": true,
  "config": {
    "asmConfigPath": "/Users/your-user/.config/asm/config.json",
    "slotDbDir": "/Users/your-user/.openclaw/agent-memo",
    "projectWorkspaceRoot": "/Users/your-user/Work/projects"
  }
}
```

This keeps `openclaw.json` from becoming a second core source-of-truth.

---

## 5) OpenClaw quick start

### Install from npm (CLI-first)
```bash
npm install -g @mrc2204/agent-smart-memo
asm init-setup --yes
asm install openclaw --yes
```

### Install plugin directly into OpenClaw (plugin-first)
```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

### Install locally from source
```bash
npm install
npm run build
node bin/asm.mjs init-setup --yes
node bin/asm.mjs install openclaw --yes
```

### Verification
```bash
npm run test:asm-cli
npx tsx tests/test-init-openclaw.ts
npm run build:openclaw
```

---

## 6) Project-aware onboarding flow

ASM supports operator-friendly project onboarding.

### Telegram/OpenClaw command
```text
/project <repo_url>
```

### Current behavior
- resolves repo path/identity when possible
- supports local path import without forced clone
- can reuse an already-registered remote/project identity
- can attach Jira mapping
- can trigger background index flow

Typical path:
1. operator runs `/project <repo_url>`
2. preview shows resolved repo + onboarding choices
3. operator confirms
4. ASM bridges into register / tracker-link / index flow

Relevant areas in the repo include:
- project registry
- onboarding command flows
- background indexing hooks
- lineage-aware retrieval tests

---

## 7) Capability overview

### Memory capabilities
- `memory_search`
- `memory_store`
- `memory_slot_get`
- `memory_slot_set`
- `memory_slot_delete`
- `memory_slot_list`
- `memory_graph_*`

### Project capabilities
- project register / list / inspect flows
- project tracker linking
- project indexing / reindexing
- lifecycle-aware retrieval gating
- hybrid lineage context retrieval

### Platform/operations capabilities
- shared config bootstrap
- OpenClaw install flow
- Paperclip install flow
- OpenCode install flow
- build/package/publish targets

---

## 8) Build targets

### Default build
```bash
npm run build
```

### Explicit targets
```bash
npm run build:openclaw
npm run build:paperclip
npm run build:core
npm run build:all
```

### Packaging
```bash
npm run package:openclaw
npm run package:paperclip
npm run package:core
```

### Pack tarballs
```bash
npm run pack:openclaw
npm run pack:paperclip
npm run pack:core
```

---

## 9) Verification

### CLI / installer verification
```bash
npm run test:asm-cli
npx tsx tests/test-init-openclaw.ts
```

### OpenClaw verification
```bash
npm run test:openclaw
npm run build:openclaw
```

### Paperclip verification
```bash
npm run test:paperclip
npm run build:paperclip
```

### Project-aware targeted verification
```bash
npx tsx tests/test-project-registry.ts
npx tsx tests/test-project-hybrid-lineage.ts
```

---

## 10) Repository layout

```text
src/
  adapters/
    openclaw/
    paperclip/
  core/
    contracts/
    usecases/
    ingest/
  db/
  hooks/
  services/
  shared/
  tools/

bin/
scripts/
docs/
artifacts/
tests/
```

---

## 11) Current positioning

A good public-facing description for this repo is:

> **Agent Smart Memo is a project-aware super memory platform for coding agents, shipped as one package with CLI-first installation for OpenClaw, Paperclip, and OpenCode.**

It helps agents:
- remember conversation/runtime state
- store and retrieve structured + semantic knowledge
- onboard and map projects
- index and reindex repos
- assemble better engineering context
- reuse one shared config and one shared memory core across runtimes

---

## 12) License

MIT © [mrc2204](https://github.com/cong91)
