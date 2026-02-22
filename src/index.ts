/**
 * Agent-Memo: Slot Memory Plugin for OpenClaw v3.0
 * 
 * Refactored to use modular tool structure
 * - Slot tools: memory_slot_get/set/list
 * - Graph tools: memory_graph_entity_get/set/rel_add/rel_remove/search
 * - Qdrant tools: memory_search, memory_store (from modules)
 * - Hooks: auto-recall, auto-capture
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { SlotDB } from "./db/slot-db.js";
import { QdrantClient } from "./services/qdrant.js";
import { EmbeddingClient } from "./services/embedding.js";
import { DeduplicationService } from "./services/dedupe.js";

// Tool modules
import { registerSlotTools } from "./tools/slot-tools.js";
import { registerGraphTools } from "./tools/graph-tools.js";
import { createMemorySearchTool } from "./tools/memory_search.js";
import { createMemoryStoreTool } from "./tools/memory_store.js";

// Hook modules
import { registerAutoRecall } from "./hooks/auto-recall.js";
import { registerAutoCapture } from "./hooks/auto-capture.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const DEFAULT_CATEGORIES = ["profile", "preferences", "project", "environment", "custom"];

const agentMemoPlugin = {
  id: "agent-memo",
  name: "Agent Memo (Slot Memory + Graph)",
  description: "Structured slot memory, graph relationships, and semantic search for OpenClaw",
  kind: "memory" as const,
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // ----------------------------------------------------------------
    // Initialize services
    // ----------------------------------------------------------------
    const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
    const slotDB = new SlotDB(stateDir);
    
    // Qdrant services (if available)
    const qdrant = new QdrantClient({
      host: process.env.QDRANT_HOST || "localhost",
      port: parseInt(process.env.QDRANT_PORT || "6333"),
      collection: process.env.QDRANT_COLLECTION || "mrc_bot_memory",
    });
    
    const embedding = new EmbeddingClient({
      model: "text-embedding-3-small",
      dimensions: 1024,
    });
    
    const dedupe = new DeduplicationService({ threshold: 0.95 });
    
    // ----------------------------------------------------------------
    // Register Qdrant tools from modules
    // ----------------------------------------------------------------
    const memorySearchTool = createMemorySearchTool(qdrant, embedding, "default");
    const memoryStoreTool = createMemoryStoreTool(qdrant, embedding, dedupe, "default");
    
    api.registerTool(memorySearchTool);
    api.registerTool(memoryStoreTool);
    
    // ----------------------------------------------------------------
    // Register Slot & Graph tools
    // ----------------------------------------------------------------
    registerSlotTools(api, DEFAULT_CATEGORIES);
    registerGraphTools(api);
    
    // ----------------------------------------------------------------
    // Register lifecycle hooks
    // ----------------------------------------------------------------
    registerAutoRecall(api, slotDB);
    registerAutoCapture(api, slotDB, {
      enabled: true,
      minConfidence: 0.7,
      batchSize: 1,
    });
    
    console.log("[AgentMemo] Plugin registered successfully");
    console.log("[AgentMemo] Tools: memory_search, memory_store, memory_slot_*, memory_graph_*");
    console.log("[AgentMemo] Hooks: auto-recall, auto-capture");
  },
};

export default agentMemoPlugin;
