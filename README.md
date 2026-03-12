# Agent Smart Memo

> **Shared Agent Memory Platform** with runtime adapters for **OpenClaw**, **Paperclip**, and future agent systems.

`agent-smart-memo` started as an OpenClaw memory plugin. It is now evolving into a **moduleized memory platform**:

- **core** → contracts, use-cases, namespace policy, error model
- **adapter-openclaw** → plugin entry, tool registration, hook wiring, runtime bridge
- **adapter-paperclip** → runtime wrapper, caller integration, compatibility mapping
- **shared infra** → Qdrant, embeddings, SlotDB, GraphDB, packaging scripts

That means this repository should no longer be understood as *only* an OpenClaw plugin repo.
It is a **shared memory engine with target-specific artifacts**.

---

## 1) What this project does

Agent Smart Memo provides a unified memory stack for AI agents:

- **Semantic memory** via Qdrant (`memory_search`, `memory_store`)
- **Structured slot memory** via SQLite (`memory_slot_*`)
- **Graph memory** for entity/relationship retrieval (`memory_graph_*`)
- **Auto-capture / auto-recall** for OpenClaw runtime
- **Shared runtime contracts** for multi-system memory callers
- **Target-based packaging** so each runtime only consumes the artifact it needs

---

## 2) Runtime targets

### OpenClaw target
Use this when you want Agent Smart Memo as an OpenClaw memory plugin.

Contains:
- core
- required infra
- OpenClaw adapter
- plugin entry / hooks / tool registration

Artifact intent:
- **OpenClaw plugin artifact**

### Paperclip target
Use this when you want a Paperclip runtime caller over the same memory core.

Contains:
- core
- required infra
- Paperclip adapter
- runtime wrapper / compatibility mapper

Artifact intent:
- **Paperclip runtime package**

### Core target
Use this when you only want shared contracts/use-cases for future systems.

Contains:
- core contracts
- use-case abstractions
- shared platform rules

Artifact intent:
- **runtime-agnostic shared memory core**

---

## 3) Architecture principles

### Compatibility-first
Current OpenClaw behavior must not break while module boundaries are extracted.

### Target-based packaging
Do **not** treat the whole repository output as one OpenClaw-only artifact.

- OpenClaw artifact should contain only what OpenClaw needs
- Paperclip artifact should contain only what Paperclip needs
- Core artifact should stay reusable for future systems

### Shared contracts
The following should be shared across runtimes:
- namespace policy
- actor context contract
- error model
- use-case interfaces
- rollout guardrails

---

## 4) Quick start for OpenClaw

If your current goal is still **“install the memory plugin into OpenClaw”**, use this section.

### Install

```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

### Prerequisites

You need these services running:

| Service | Purpose | Example |
|---|---|---|
| Qdrant | Semantic vector memory | `docker run -d -p 6333:6333 qdrant/qdrant` |
| Embedding backend | Embeddings for semantic memory | Ollama / OpenAI-compatible / docker adapter |
| LLM endpoint | Fact extraction / auto-capture | Any OpenAI-compatible API |

### OpenClaw config example

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    allow: ["agent-smart-memo"],
    slots: {
      memory: "agent-smart-memo"
    },
    entries: {
      "agent-smart-memo": {
        enabled: true,
        config: {
          qdrantHost: "localhost",
          qdrantPort: 6333,
          qdrantCollection: "openclaw_memory",

          llmBaseUrl: "https://api.openai.com/v1",
          llmApiKey: "sk-...",
          llmModel: "gpt-4o-mini",

          embedBaseUrl: "http://localhost:11434",
          embedBackend: "ollama",
          embedModel: "qwen3-embedding:0.6b",
          embedDimensions: 1024,

          slotDbDir: "/Users/your-user/.openclaw/agent-memo"
        }
      }
    }
  }
}
```

### OpenClaw target commands

```bash
npm install
npm run build
openclaw plugins install -l .
```

---

## 5) Quick start for Paperclip

If your goal is to let **Paperclip** consume the same memory core:

### Build the Paperclip target

```bash
npm install
npm run build:paperclip
npm run package:paperclip
npm run pack:paperclip
```

### What Paperclip consumes
Paperclip should consume:
- shared core contracts/use-cases
- Paperclip adapter runtime
- no OpenClaw plugin metadata/runtime dependency unless explicitly needed

### Current maturity
Paperclip path has:
- adapter contracts
- compatibility mapper
- runtime wrapper
- production-like smoke verification

But README intentionally does **not** overclaim this as full production-grade multi-runtime completion.

---

## 6) Build targets

### Default build

```bash
npm run build
```

Default build remains **OpenClaw-compatible** for backward compatibility.

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

### Publish targets

```bash
npm run publish:openclaw
npm run publish:paperclip
npm run publish:core
```

> Publish requires valid npm authentication. If `NPM_TOKEN` is missing, publish should be treated as not ready / dry-run only.

---

## 7) CI/CD model

GitHub Actions workflow: `.github/workflows/publish.yml`

Current flow:
- matrix build for `openclaw`, `paperclip`, `core`
- build → package → pack `.tgz` → upload artifact
- target-aware tests
- `workflow_dispatch` for manual publish
- `dry_run` supported
- real publish gated by `NPM_TOKEN`

### Important distinction
A `work/...` branch is for:
- **CI checks**
- **PR review**
- **dry-run readiness**

It is **not** the same as:
- production deploy
- final release approval
- final npm publish approval

Recommended flow:

```text
work/... push -> CI checks -> PR review -> approve -> merge default branch -> publish/release/deploy
```

---

## 8) Memory capabilities

### Semantic memory
- `memory_search`
- `memory_store`
- namespace-aware retrieval
- registry-aware alias normalization
- explicit unknown namespace validation

### Slot memory
- `memory_slot_get`
- `memory_slot_set`
- `memory_slot_delete`
- `memory_slot_list`

### Graph memory
- entity create/get/search
- relationship add/remove
- scoped traversal

### Runtime automation
- auto-capture
- auto-recall
- runtime identity injection where supported

---

## 9) Configuration notes

### Embedding backend mapping
When `embedBackend` is set:
- `ollama` → `/api/embeddings`
- `docker` → `/engines/llama.cpp/v1/embeddings`
- `openai` → `/v1/embeddings`

If omitted, legacy auto behavior is preserved.

### SlotDB path resolution
Resolution order:
1. `OPENCLAW_SLOTDB_DIR`
2. plugin config `slotDbDir`
3. `${OPENCLAW_STATE_DIR}/agent-memo`

---

## 10) Verification levels

### Build level
Confirms code compiles:

```bash
npm run build
npm run build:all
```

### Contract / integration level

```bash
npm test
npm run test:openclaw
npm run test:paperclip
```

### Production-like runtime verification
Examples already added in this repo include:
- Paperclip runtime E2E
- OpenClaw anti-regression integration
- production-like smoke parity harness

This is stronger than mock-only testing, but still distinct from a full production deployment.

---

## 11) Repository layout (high level)

```text
src/
  core/
    contracts/
    usecases/
  adapters/
    openclaw/
    paperclip/
  tools/
  hooks/
  entries/
  services/
  db/
  shared/

scripts/
artifacts/
docs/architecture/
```

---

## 12) Current project status

Current repo status after ASM-43 work:
- architecture pack completed
- implementation pack substantially advanced
- runtime wiring exists for OpenClaw and Paperclip paths
- production-like smoke parity evidence exists
- target-based packaging/build pipeline exists

Still be precise about claims:
- strong progress beyond scaffold ✅
- compatibility-first runtime wiring ✅
- full production-grade multi-runtime completion should only be claimed with full runtime-host evidence and approved release flow

---

## 13) Useful commands

```bash
# install dependencies
npm install

# default build (OpenClaw target)
npm run build

# build all targets
npm run build:all

# test
npm test
npm run test:openclaw
npm run test:paperclip

# package / pack
npm run package:openclaw
npm run package:paperclip
npm run package:core
npm run pack:openclaw
npm run pack:paperclip
npm run pack:core
```

---

## 14) License

MIT © [mrc2204](https://github.com/cong91)
