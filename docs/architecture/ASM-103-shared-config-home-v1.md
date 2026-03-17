# ASM-103 — Shared Config Home & Multi-Platform Config Lifecycle (v1)

Date: 2026-03-16
Task: `ASM-103`
Repo: `/Users/mrcagents/Work/projects/agent-smart-memo`

## 1. Goal

Define the canonical shared config home and config lifecycle for ASM SDK so OpenClaw, Paperclip, and future OpenCode can consume one shared ASM configuration without treating any single runtime as the owner of ASM core config.

## 2. Canonical decisions

### 2.1 Shared config home
Canonical ASM config home:
- `~/.config/asm/`

Primary config file:
- `~/.config/asm/config.json`

### 2.2 Config precedence
Deterministic precedence order:
1. runtime override
2. environment variables
3. shared config file
4. built-in defaults

### 2.3 Source-of-truth rule
- `~/.config/asm/config.json` is the source of truth for ASM SDK core config.
- Runtime-specific configs must not become competing owners of ASM core behavior.
- Runtime/client configs are adapters/bootstrap layers only.

## 3. Config model

## 3.1 Core / global config
Core/global config belongs under top-level `core`.

### Minimum categories
- `projectWorkspaceRoot`
- `storage`
  - `slotDbDir`
  - graph / vector store connection info
  - collection names / roots as needed
- `embedding`
  - backend
  - model
  - dimensions
  - token/size limits if needed
- `retrieval`
  - default limits
  - hybrid defaults
  - feature-pack defaults
  - change-overlay defaults
- `memoryBehavior`
  - auto-capture
  - auto-recall
  - summarization / indexing defaults
- `projectDefaults`
  - alias/indexing/tracker defaults where appropriate

## 3.2 Adapter / runtime-local config
Adapter/runtime-local config belongs under top-level `adapters`.

### OpenClaw
Only OpenClaw-specific wiring:
- plugin enabled/disabled
- adapter-local runtime pointers
- OpenClaw-specific bootstrap options

### Paperclip
Only Paperclip-specific wiring:
- adapter bridge settings
- runtime-local bootstrap/install state

### OpenCode
Only OpenCode-specific wiring:
- MCP/read-only adapter settings
- local integration bootstrap config

### Rule
Adapter config must not own ASM core behavior. It only describes how that runtime talks to ASM.

## 4. Proposed config shape (v1)

```json
{
  "schemaVersion": 1,
  "core": {
    "projectWorkspaceRoot": "/Users/you/Work/projects",
    "storage": {
      "slotDbDir": "~/.local/share/asm/slotdb",
      "qdrant": {
        "host": "localhost",
        "port": 6333,
        "collection": "asm"
      }
    },
    "embedding": {
      "backend": "ollama",
      "model": "qwen3-embedding:0.6b",
      "dimensions": 1024
    },
    "retrieval": {
      "defaultLimit": 10,
      "hybridDefaults": {},
      "featurePackDefaults": {},
      "changeOverlayDefaults": {}
    },
    "memoryBehavior": {
      "autoCaptureEnabled": true,
      "autoRecallEnabled": true
    },
    "projectDefaults": {}
  },
  "adapters": {
    "openclaw": {
      "enabled": true
    },
    "paperclip": {
      "enabled": true
    },
    "opencode": {
      "enabled": true,
      "mode": "read-only"
    }
  }
}
```

## 5. Runtime consumption model

### 5.1 Bootstrap
Each runtime should know how to find the ASM config path via:
- explicit override
- `ASM_CONFIG`
- default path `~/.config/asm/config.json`

### 5.2 Load
At process start:
- read config file
- apply precedence merge
- validate schema

### 5.3 Cache
After startup:
- keep resolved config in runtime memory
- do not reread config on every tool call
- allow explicit reload only

### 5.4 Operational commands
CLI should eventually support:
- `asm config init`
- `asm config get`
- `asm config set`
- `asm config doctor`
- `asm config path`

## 6. Security / secret handling

### Rule
Secrets should not live as plain source-of-truth values in `config.json` unless unavoidable.

Prefer:
- environment variables
- secret-store references

`config.json` should primarily store non-secret config or secret refs.

## 7. Migration direction

Current ASM behavior still contains OpenClaw-centric config surfaces.
Migration direction should be:
1. define shared config home/schema first
2. let existing runtimes read shared config while remaining backward compatible
3. gradually demote runtime-local duplicated config into adapter bootstrap only
4. eventually treat `~/.config/asm/config.json` as canonical core config

## 8. Non-goals of ASM-103

This task does not finalize:
- package/install strategy in detail (`ASM-104`)
- OpenCode retrieval contract in detail (`ASM-106`)
- lifecycle destructive actions in detail (`ASM-107`)

It only defines the config foundation those tasks depend on.

## 9. Acceptance criteria

- canonical shared config home defined
- canonical config file defined
- precedence order defined
- core vs adapter-local boundary defined
- runtime consumption model defined
- migration direction from OpenClaw-centric config defined

## 10. Bottom line

ASM SDK should have one config home and one source of truth for core behavior:
- `~/.config/asm/config.json`

Everything else is adapter/bootstrap around it.
