# @mrc2204/agent-smart-memo

🧠 **Smart Memory Plugin for OpenClaw** — Structured slot memory with auto-capture, auto-recall, essence distillation, and Qdrant vector search.

## Features

- **Auto-Capture** — Automatically extracts facts from conversations using LLM
- **Auto-Recall** — Injects relevant context into agent sessions
- **Essence Distillation** — Distills raw facts into decision-grade, terse memory (V4)
- **Slot Memory** — Structured key-value state management (profile, preferences, project, etc.)
- **Vector Search** — Semantic memory search via Qdrant
- **Smart Routing** — Auto-routes memory by agent type:
  - 🐂 Trader → `market_signal` mode
  - 🎯 Scrum/Fullstack/Creator → `requirements` mode
  - 📚 Learning content → `principles` mode

## Installation

```bash
openclaw plugins install @mrc2204/agent-smart-memo
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    allow: ["agent-smart-memo"],  // Trust the plugin
    slots: {
      memory: "agent-smart-memo"  // Use as memory provider
    },
    entries: {
      "agent-smart-memo": {
        enabled: true,
        config: {
          // Qdrant vector database
          qdrantHost: "localhost",
          qdrantPort: 6333,
          qdrantCollection: "mrc_bot_memory",
          
          // LLM for auto-capture extraction
          llmBaseUrl: "http://localhost:8317/v1",
          llmApiKey: "your-api-key",
          llmModel: "gemini-2.5-flash",
          
          // Embedding model (Ollama)
          embedBaseUrl: "http://localhost:11434",
          embedModel: "mxbai-embed-large",
          embedDimensions: 1024,
          
          // Auto-capture settings
          autoCaptureEnabled: true,
          autoCaptureMinConfidence: 0.7,
          contextWindowMaxTokens: 12000,
          summarizeEveryActions: 6
        }
      }
    }
  }
}
```

### Minimal Config

```json5
{
  plugins: {
    allow: ["agent-smart-memo"],
    slots: { memory: "agent-smart-memo" },
    entries: {
      "agent-smart-memo": {
        enabled: true,
        config: {
          qdrantHost: "localhost",
          qdrantPort: 6333,
          llmBaseUrl: "http://localhost:8317/v1",
          llmApiKey: "your-api-key"
        }
      }
    }
  }
}
```

## Prerequisites

| Service | Purpose | Default |
|---------|---------|---------|
| [Qdrant](https://qdrant.tech) | Vector database for semantic memory | `localhost:6333` |
| LLM API | Fact extraction (OpenAI-compatible) | `localhost:8317/v1` |
| [Ollama](https://ollama.ai) | Embedding model | `localhost:11434` |

### Quick setup

```bash
# Start Qdrant
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant

# Pull embedding model
ollama pull mxbai-embed-large
```

## Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across stored memories |
| `memory_store` | Store a new memory with vector embedding |
| `memory_auto_capture` | Manually trigger fact extraction |
| `memory_slot_get` | Get slot value(s) |
| `memory_slot_set` | Set a slot value |
| `memory_slot_delete` | Delete a slot |
| `memory_slot_list` | List all slots |
| `memory_graph_*` | Knowledge graph operations |

## Configuration Reference

See [CONFIG.example.json](./CONFIG.example.json) for all available options with descriptions.

## Update

```bash
openclaw plugins update agent-smart-memo
```

## Uninstall

```bash
openclaw plugins uninstall agent-smart-memo
```

## Development

```bash
git clone https://github.com/cong91/agent-smart-memo.git
cd agent-smart-memo
npm install
npm run build

# Install locally for development
openclaw plugins install -l .
```

## License

MIT © mrc2204
