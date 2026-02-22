# Agent-Memo Plugin v3.0

**Advanced Memory System for OpenClaw Agents**

[![Tests](https://img.shields.io/badge/tests-53%2F53%20passed-brightgreen)]()
[![Version](https://img.shields.io/badge/version-3.0.0-blue)]()

## 🎯 Overview

Agent-Memo is a comprehensive memory plugin for OpenClaw that provides:

- **Slot Memory**: Structured key-value storage (SQLite)
- **Graph Memory**: Entity-relationship graph storage
- **Semantic Search**: Vector-based memory retrieval (Qdrant)
- **Auto-Recall**: Automatic context injection
- **Auto-Capture**: Automatic fact extraction

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Agent Runtime                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ Slot Tools  │  │ Graph Tools │  │  Qdrant Tools   │ │
│  │ (SQLite)    │  │  (SQLite)   │  │ (Vector DB)     │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘ │
│         │                │                   │          │
│  ┌──────▼────────────────▼───────────────────▼────────┐ │
│  │                  Agent-Memo Plugin                 │ │
│  │  ┌─────────┐  ┌─────────┐  ┌───────────────────┐  │ │
│  │  │ SlotDB  │  │ GraphDB │  │  Auto-Recall      │  │ │
│  │  │(SQLite) │  │(SQLite) │  │  Auto-Capture     │  │ │
│  │  └─────────┘  └─────────┘  └───────────────────┘  │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 📦 Installation

```bash
# Copy to OpenClaw extensions
cp -r agent-memo ~/.openclaw/extensions/

# Enable in ~/.openclaw/openclaw.json
{
  "plugins": {
    "slots": {
      "memory": "agent-memo"
    },
    "entries": {
      "agent-memo": { "enabled": true }
    }
  }
}
```

## 🛠️ Tools Reference

### Slot Memory Tools

#### `memory_slot_get`
Retrieve a slot by key or list all slots in a category.

```typescript
// Get specific slot
memory_slot_get({ key: "profile.name" })
// Returns: { key, value, category, version, scope }

// List by category
memory_slot_get({ category: "project" })
// Returns: Array of slots

// Cross-scope query
memory_slot_get({ key: "profile.name", scope: "all" })
// Returns: slot with scope info (private/team/public)
```

#### `memory_slot_set`
Store or update a slot with versioning and scoping.

```typescript
// Basic usage
memory_slot_set({
  key: "profile.name",
  value: "MrC",
  category: "profile",
  scope: "private"  // private | team | public
})

// With metadata
memory_slot_set({
  key: "project.tech_stack",
  value: ["TypeScript", "SQLite"],
  category: "project",
  source: "manual",
  scope: "team"
})
```

#### `memory_slot_list`
List all slots with filtering and scope display.

```typescript
// List all
memory_slot_list({})

// Filter by category
memory_slot_list({ category: "preferences" })

// Filter by prefix
memory_slot_list({ prefix: "project." })

// Show all scopes
memory_slot_list({ scope: "all" })
```

### Graph Memory Tools

#### `memory_graph_entity_get`
Retrieve entities by ID or search with filters.

```typescript
// Get by ID
memory_graph_entity_get({ id: "uuid-here" })

// List by type
memory_graph_entity_get({ type: "person" })

// Search by name
memory_graph_entity_get({ name: "MrC" })
```

#### `memory_graph_entity_set`
Create or update an entity.

```typescript
// Create new
memory_graph_entity_set({
  name: "OpenClaw Project",
  type: "project",
  properties: {
    status: "active",
    priority: "high"
  }
})

// Update existing
memory_graph_entity_set({
  id: "existing-uuid",
  name: "Updated Name",
  type: "project"
})
```

#### `memory_graph_rel_add`
Create a relationship between entities.

```typescript
memory_graph_rel_add({
  source_id: "mrc-uuid",
  target_id: "project-uuid",
  relation_type: "manages",
  weight: 1.0,
  properties: { since: "2024-01" }
})
```

#### `memory_graph_rel_remove`
Delete a relationship.

```typescript
// By ID
memory_graph_rel_remove({ id: "rel-uuid" })

// By source/target/type
memory_graph_rel_remove({
  source_id: "mrc-uuid",
  target_id: "project-uuid",
  relation_type: "manages"
})
```

#### `memory_graph_search`
Traverse the graph from a starting entity.

```typescript
memory_graph_search({
  entity_id: "mrc-uuid",
  depth: 2,                    // 1-3 hops
  relation_type: "manages"     // optional filter
})
```

### Qdrant Semantic Search Tools

#### `memory_search`
Search memories by semantic similarity.

```typescript
memory_search({
  query: "What was the deadline?",
  namespace: "fullstack",
  limit: 5,
  minScore: 0.7
})
```

#### `memory_store`
Store a memory in Qdrant with automatic deduplication.

```typescript
memory_store({
  text: "User prefers dark theme for all interfaces",
  namespace: "assistant",
  metadata: { type: "preference" }
})
```

## 🔄 Auto Features

### Auto-Recall
Automatically injects context into system prompt before agent runs.

**Injected Format:**
```xml
<current-state>
  <profile>
    <name>MrC</name>
    <timezone>Asia/Saigon</timezone>
  </profile>
  <project>
    <current>Agent Memo</current>
  </project>
</current-state>

<knowledge-graph>
  <entities>
    <entity name="MrC" type="person"/>
    <entity name="Agent Memo" type="project"/>
  </entities>
  <relationships>
    <rel>MrC --[manages]--> Agent Memo</rel>
  </relationships>
</knowledge-graph>
```

### Auto-Capture
Automatically extracts facts from conversations.

**Extracted Patterns:**
- Names: "tên tôi là X", "my name is X"
- Locations: "tôi ở Y", "I live in Y"
- Preferences: "dark theme", "light theme"
- Projects: "đang làm Z", "working on Z"
- Tech Stack: "tech stack: A, B, C"

**Confidence Threshold:** 0.7 (configurable)

## 📊 Storage Details

### SQLite Schema

**Slots Table:**
```sql
CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  scope_user_id TEXT,
  scope_agent_id TEXT,
  category TEXT,
  key TEXT,
  value TEXT,  -- JSON
  source TEXT,
  confidence REAL,
  version INTEGER,
  created_at TEXT,
  updated_at TEXT,
  expires_at TEXT
);
```

**Entities Table:**
```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  properties TEXT,  -- JSON
  scope_user_id TEXT,
  scope_agent_id TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

**Relationships Table:**
```sql
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT,
  target_entity_id TEXT,
  relation_type TEXT,
  weight REAL,
  properties TEXT,  -- JSON
  scope_user_id TEXT,
  scope_agent_id TEXT,
  created_at TEXT,
  UNIQUE(source_entity_id, target_entity_id, relation_type)
);
```

## 🔧 Configuration

```typescript
// In index.ts or config
const config = {
  // Slot categories
  slotCategories: ["profile", "preferences", "project", "environment", "custom"],
  
  // Auto-capture settings
  autoCapture: {
    enabled: true,
    minConfidence: 0.7,
    batchSize: 1
  },
  
  // Qdrant settings
  qdrant: {
    host: "localhost",
    port: 6333,
    collection: "mrc_bot_memory"
  }
};
```

## 🧪 Testing

```bash
# Run all tests
cd ~/.openclaw/extensions/agent-memo
npm test

# Individual test suites
npx tsx tests/test.ts           # SlotDB tests (28)
npx tsx tests/test-graph.ts     # GraphDB tests (20)
npx tsx tests/test-autocapture.ts  # Auto-capture tests (5)
```

## 📁 Project Structure

```
agent-memo/
├── src/
│   ├── index.ts              # Main entry
│   ├── db/
│   │   ├── slot-db.ts        # Slot storage
│   │   └── graph-db.ts       # Graph storage
│   ├── tools/
│   │   ├── slot-tools.ts     # Slot tools
│   │   ├── graph-tools.ts    # Graph tools
│   │   ├── memory_search.ts  # Qdrant search
│   │   └── memory_store.ts   # Qdrant store
│   ├── hooks/
│   │   ├── auto-recall.ts    # Context injection
│   │   └── auto-capture.ts   # Fact extraction
│   └── services/
│       ├── qdrant.ts         # Qdrant client
│       ├── embedding.ts      # Embedding service
│       └── dedupe.ts         # Deduplication
├── tests/
│   ├── test.ts
│   ├── test-graph.ts
│   └── test-autocapture.ts
├── dist/                     # Compiled output
├── package.json
├── tsconfig.json
└── README.md                 # This file
```

## 📈 Migration

Migrate existing markdown files to database:

```bash
npx tsx scripts/migrate-md-to-db.ts
```

**Migrates:**
- IDENTITY.md → Slots + Graph entities
- USER.md → User slots + relationships
- AGENTS.md → Qdrant references
- memory/*.md → Qdrant daily logs

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Submit a pull request

## 📄 License

MIT License - OpenClaw Team

## 🙏 Acknowledgments

- OpenClaw core team
- Qdrant vector database
- SQLite team

---

**Version:** 3.0.0  
**Last Updated:** 2026-02-22  
**Maintainer:** Thợ Đụng (Fullstack)
