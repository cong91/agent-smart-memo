# @mrc2204/agent-smart-memo

🧠 **Smart Memory Plugin for [OpenClaw](https://openclaw.ai)** — Give your AI agents persistent, intelligent memory.

Your agents forget everything after each conversation. This plugin fixes that.

## What it does

- **Auto-Capture** — Automatically extracts important facts from every conversation (names, preferences, decisions, project status, etc.)
- **Auto-Recall** — Injects relevant memories into agent context before each response — agents "remember" without being told
- **Essence Distillation** — Filters noise, keeps only decision-grade facts. Your agent's memory stays clean and useful
- **Slot Memory** — Structured key-value storage organized by categories (profile, preferences, project, environment)
- **Vector Search** — Find semantically similar memories using Qdrant
- **Multi-Agent Support** — Each agent maintains its own memory scope, no cross-contamination

## Installation

```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

## Quick Start

### 1. Prerequisites

You need two services running:

| Service | What for | Install |
|---------|----------|---------|
| [Qdrant](https://qdrant.tech/documentation/quick-start/) | Stores memory vectors | `docker run -d -p 6333:6333 qdrant/qdrant` |
| [Ollama](https://ollama.ai) | Generates text embeddings | [Download](https://ollama.ai/download) then `ollama pull mxbai-embed-large` |

### 2. Configure

Add to your `~/.openclaw/openclaw.json`:

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
          // Required: Qdrant connection
          qdrantHost: "localhost",
          qdrantPort: 6333,
          qdrantCollection: "openclaw_memory",

          // Required: Any OpenAI-compatible API for fact extraction
          llmBaseUrl: "https://api.openai.com/v1",
          llmApiKey: "sk-...",
          llmModel: "gpt-4o-mini",

          // Required: Ollama for embeddings
          embedBaseUrl: "http://localhost:11434",
          embedModel: "mxbai-embed-large",
          embedDimensions: 1024
        }
      }
    }
  }
}
```

### 3. Done!

Start chatting with your agent. Memories are captured automatically.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `qdrantHost` | string | `"localhost"` | Qdrant server hostname |
| `qdrantPort` | number | `6333` | Qdrant server port |
| `qdrantCollection` | string | `"openclaw_memory"` | Qdrant collection name |
| `llmBaseUrl` | string | — | OpenAI-compatible API base URL |
| `llmApiKey` | string | — | API key for the LLM |
| `llmModel` | string | `"gpt-4o-mini"` | Model for fact extraction |
| `embedBaseUrl` | string | `"http://localhost:11434"` | Ollama base URL |
| `embedModel` | string | `"mxbai-embed-large"` | Embedding model name |
| `embedDimensions` | number | `1024` | Embedding vector dimensions |
| `autoCaptureEnabled` | boolean | `true` | Enable automatic fact extraction |
| `autoCaptureMinConfidence` | number | `0.7` | Minimum confidence to store a fact (0-1) |
| `contextWindowMaxTokens` | number | `12000` | Max tokens sent to LLM for extraction |
| `summarizeEveryActions` | number | `6` | Auto-summarize project state every N turns |
| `slotCategories` | string[] | `["profile","preferences","project","environment","custom"]` | Allowed slot categories |
| `maxSlots` | number | `500` | Max slots per agent+user scope |
| `injectStateTokenBudget` | number | `500` | Max tokens for auto-recall context injection |

See [CONFIG.example.json](./CONFIG.example.json) for a copy-paste template.

## How It Works

```
User sends message → Agent responds
                          ↓
                    [agent_end event]
                          ↓
              Auto-Capture extracts facts
              using LLM + Essence Distillation
                          ↓
              Facts stored in SlotDB + Qdrant
                          ↓
              Next conversation starts
                          ↓
              Auto-Recall searches relevant memories
                          ↓
              Context injected into agent prompt
                          ↓
              Agent "remembers" previous conversations ✨
```

### Essence Distillation Modes

The plugin automatically selects a distillation mode based on content:

| Mode | When | What it keeps |
|------|------|---------------|
| `general` | Default | Decision-grade facts, rules, configurations |
| `principles` | Learning content detected | Invariant principles, atomic rules |
| `requirements` | Technical discussions | Non-negotiable constraints, specs |
| `market_signal` | Trading/market content | Directional signals, risk levels, triggers |

## Available Tools

These tools are automatically registered and available to your agents:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across all stored memories |
| `memory_store` | Manually store a memory with vector embedding |
| `memory_auto_capture` | Manually trigger fact extraction on text |
| `memory_slot_get` | Read slot value(s) by key or category |
| `memory_slot_set` | Write a structured slot value |
| `memory_slot_delete` | Remove a slot |
| `memory_slot_list` | List all slots for current scope |
| `memory_graph_add` | Add a knowledge graph relation |
| `memory_graph_query` | Query the knowledge graph |

## LLM Compatibility

Any OpenAI-compatible chat completions API works:

| Provider | `llmBaseUrl` | `llmModel` |
|----------|-------------|------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic (via proxy) | Your proxy URL | `claude-sonnet-4-20250514` |
| Local (Ollama) | `http://localhost:11434/v1` | `llama3.2` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` |
| Any proxy | Your proxy URL | Your model |

## Commands

```bash
# Install
openclaw plugins install @mrc2204/agent-smart-memo

# Update to latest version
openclaw plugins update agent-smart-memo

# Check status
openclaw plugins info agent-smart-memo

# Uninstall
openclaw plugins uninstall agent-smart-memo
```

## Development

```bash
# Clone
git clone https://github.com/cong91/agent-smart-memo.git
cd agent-smart-memo

# Install & build
npm install
npm run build

# Link for local development (changes apply immediately)
openclaw plugins install -l .

# Run tests
npm test
```

## License

MIT © [mrc2204](https://github.com/cong91)
