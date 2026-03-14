# Agent Smart Memo

> **ASM v5.1 super memory platform for OpenClaw agents** — unified memory for **conversation memory**, **project memory**, semantic retrieval, structured slots, graph knowledge, onboarding, and engineering context assembly.

`agent-smart-memo` started as an OpenClaw memory plugin for conversation/runtime memory.
After the **ASM-69 big update**, it should be understood as a broader **agent memory platform**:

- **conversation memory** for agent runtime continuity
- **project memory** for repo-aware engineering context
- **semantic memory** via vector retrieval
- **structured slot memory** via SQLite
- **graph memory** for entities/relationships
- **operator onboarding** for project registration + Jira mapping + indexing
- **CLI/setup flows** for OpenClaw installation and bootstrap

This repo is still packaged for **OpenClaw first**, but its practical role is now:

- a **super memory layer** for agents
- a **project-aware engineering memory system**
- an **operator-friendly onboarding/runtime package**

It is no longer accurate to describe ASM as only a small conversation-memory plugin.

---

## 1) What ASM v5.1 is

ASM v5.1 combines two big memory domains.

### A. Conversation memory
Used for ongoing agent continuity and runtime recall:
- semantic memory (`memory_search`, `memory_store`)
- structured slot memory (`memory_slot_*`)
- graph memory (`memory_graph_*`)
- auto-capture / auto-recall support
- namespace-aware memory behavior

### B. Project memory
Used for engineering/project-aware workflows:
- project registry and aliasing
- repo root / repo remote identity
- Jira mapping and tracker linkage
- onboarding flows for new repos
- project indexing / reindexing
- hybrid retrieval with file / symbol / task lineage

That is why ASM now acts as:

> **conversation memory + project memory + retrieval/control plane in one agent-facing platform**

---

## 2) What ASM v5.1 adds after ASM-69 big update

ASM-69 and follow-up waves expanded the system from memory-only into project-aware memory orchestration.

### Project-aware memory model
Agents can now reason about:
- `project_id`
- project alias
- `repo_root`
- `repo_remote`
- Jira space / epic mapping
- registration / validation state

### Ingest + semantic block extraction
Codebases can be transformed into retrievable structures using:
- file planning
- semantic block extraction
- deterministic file/chunk/symbol IDs
- diff-aware indexing primitives

### Incremental reindex
Instead of rebuilding everything blindly, ASM now supports:
- changed / unchanged / deleted diffing
- watch-state snapshotting
- checksum-driven reindex control
- background-friendly trigger flow

### Hybrid retrieval + task lineage
ASM is not just vector search anymore.
It can combine:
- semantic recall
- lexical/project filters
- file/symbol/task context
- parent/related/touched lineage context

### Operator onboarding
Operators can onboard a project with repo + alias + Jira mapping + optional index trigger using project-aware command flows.

### Setup CLI
OpenClaw setup is now easier through the global CLI:
- `asm setup-openclaw`
- `asm setup openclaw`
- legacy-compatible `npm run init-openclaw`

---

## 3) Scope of this repository

This repository now spans multiple practical layers.

### OpenClaw runtime/plugin layer
Includes:
- plugin entry
- tool registration
- runtime hooks
- OpenClaw packaging/build flow
- setup/bootstrap CLI flow

### Shared memory platform layer
Includes:
- SlotDB
- semantic memory use-cases
- graph/registry logic
- shared contracts and runtime abstractions

### Project-aware engineering memory layer
Includes:
- project registry
- onboarding use-cases
- tracker mapping
- indexing/reindexing primitives
- lineage-aware retrieval

So the best mental model is:

> **an OpenClaw-delivered super memory platform with both conversation memory and project memory**

---

## 4) Runtime targets

### OpenClaw target
Use this when you want ASM as the main OpenClaw memory/runtime plugin.

Contains:
- core memory platform
- OpenClaw adapter
- plugin entry / hooks / tool registration
- operator onboarding command surfaces

Artifact intent:
- **OpenClaw plugin artifact**

### Paperclip target
Use this when you want Paperclip to consume the same shared memory core/runtime behavior.

Contains:
- core memory platform
- Paperclip adapter/runtime wrapper
- compatibility mapping

Artifact intent:
- **Paperclip runtime package**

### Core target
Use this when you want the shared contracts/use-cases without OpenClaw/Paperclip-specific delivery.

Contains:
- shared contracts
- shared use-cases
- shared memory/platform rules

Artifact intent:
- **runtime-agnostic shared memory core**

---

## 5) Main capability areas

### Conversation memory capabilities
- `memory_search`
- `memory_store`
- `memory_slot_get`
- `memory_slot_set`
- `memory_slot_delete`
- `memory_slot_list`
- `memory_graph_*`
- auto-capture / auto-recall

### Project memory capabilities
- `project.register`
- `project.get`
- `project.list`
- `project.link_tracker`
- `project.trigger_index`
- `project.reindex_diff`
- `project.index_watch_get`
- `project.legacy_backfill`
- Telegram/operator onboarding surfaces

### Retrieval/engineering context capabilities
- semantic retrieval
- lexical/project filtering
- project-aware context assembly
- file / symbol / task lineage
- repo-aware indexing and reindexing

---

## 6) CLI / setup UX

After ASM-84, the preferred setup path is the global CLI.

### Install globally
```bash
npm install -g @mrc2204/agent-smart-memo
```

### Preferred setup flow
```bash
asm setup-openclaw
```

Also supported:
```bash
asm setup openclaw
```

Legacy-compatible flow:
```bash
npm run init-openclaw
```

### What `asm setup-openclaw` does
1. checks that `openclaw` CLI exists
2. installs `@mrc2204/agent-smart-memo` if missing
3. runs OpenClaw bootstrap/init flow
4. patches config with preview + backup behavior
5. prints next-step verification guidance

This is the fastest path for operators who want ASM enabled in OpenClaw without manual config editing first.

---

## 7) Quick start for OpenClaw

If your current goal is still “install and run ASM in OpenClaw”, use this section.

### Install plugin directly
```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

### Or install locally from source
```bash
npm install
npm run build
openclaw plugins install -l .
```

### Prerequisites
You typically need:

| Service | Purpose | Example |
|---|---|---|
| Qdrant | Semantic/vector memory | `docker run -d -p 6333:6333 qdrant/qdrant` |
| Embedding backend | Embeddings for semantic recall | Ollama / OpenAI-compatible / docker adapter |
| LLM endpoint | Fact extraction / auto-capture | OpenAI-compatible API |

### Example OpenClaw config
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

---

## 8) Project onboarding flow (ASM-84/85)

For project-aware onboarding in OpenClaw/Telegram flows, the current slash command is:

```text
/project <repo_url>
```

### Current behavior summary
- onboarding preview exposes resolved `repo_root` when derivable
- preview/commit can report `repo_resolution` and `clone_policy`
- if `repo_url` matches an already-registered remote, registration reuses the existing project identity / `repo_root`
- if `repo_url` is a local path, it is treated as import without `git clone`
- `project.trigger_index` is background-friendly and reports:
  - `accepted`
  - `enqueued`
  - `detached`
  - `job_id`

### Typical onboarding path
1. operator starts with `/project <repo_url>`
2. bot prepares preview
3. preview shows alias/Jira/index choices and repo resolution hints
4. operator confirms
5. flow bridges into:
   - `project_register_command`
   - `project_link_tracker`
   - `project_trigger_index`

See also:
- `docs/architecture/ASM-74-master-project-registration-ux-command-contract-jira-mapping-v5.1.md`
- `tests/test-project-registry.ts`

---

## 9) Quick start for Paperclip

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

## 10) Build targets

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

## 11) CI/CD model

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
- CI checks
- PR review
- dry-run readiness

It is **not** the same as:
- production deploy
- final release approval
- final npm publish approval

Recommended flow:

```text
work/... push -> CI checks -> PR review -> approve -> merge default branch -> publish/release/deploy
```

---

## 12) Configuration notes

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

## 13) Verification levels

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

### Project-aware targeted verification
```bash
npx tsx tests/test-project-registry.ts
npx tsx tests/test-project-reindex-diff.ts
npx tsx tests/test-project-hybrid-lineage.ts
npx tsx tests/test-project-legacy-backfill.ts
```

### Production-like runtime verification
Examples already added in this repo include:
- Paperclip runtime E2E
- OpenClaw anti-regression integration
- production-like smoke parity harness

---

## 14) Repository layout (high level)

```text
src/
  core/
    contracts/
    usecases/
    ingest/
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

## 15) Current mental model

If you only remember one thing, remember this:

> **ASM v5.1 is a super memory platform for agents: conversation memory + project memory + retrieval/control-plane capabilities.**

It helps agents:
- remember ongoing runtime/conversation context
- store/retrieve structured and semantic knowledge
- register and map projects
- index and reindex repos
- retrieve engineering context with lineage
- onboard projects with operator-friendly flows
- bootstrap OpenClaw faster through the CLI

---

## 16) License

MIT © [mrc2204](https://github.com/cong91)
