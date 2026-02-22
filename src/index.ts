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
// Plugin Configuration Interface
// ============================================================================

interface AgentMemoConfig {
  slotCategories?: string[];
  maxSlots?: number;
  injectStateTokenBudget?: number;
  qdrantHost?: string;
  qdrantPort?: number;
  qdrantCollection?: string;
  qdrantVectorSize?: number;
  ollamaHost?: string;
  ollamaPort?: number;
  ollamaModel?: string;
  embedModel?: string;
  embedDimensions?: number;
  autoCaptureEnabled?: boolean;
  autoCaptureMinConfidence?: number;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const DEFAULT_CATEGORIES = ["profile", "preferences", "project", "environment", "custom"];

const agentMemoPlugin = {
  id: "agent-memo",
  name: "Agent Memo (Slot Memory + Graph)",
  description: "Structured slot memory, graph relationships, and semantic search for OpenClaw",
  kind: "memory" as const,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      slotCategories: {
        type: "array",
        items: { type: "string" },
        description: "Allowed slot categories",
      },
      maxSlots: {
        type: "number",
        description: "Maximum number of slots per scope",
      },
      injectStateTokenBudget: {
        type: "number",
        description: "Max tokens for Current State injection",
      },
      qdrantHost: {
        type: "string",
        description: "Qdrant server host",
      },
      qdrantPort: {
        type: "number",
        description: "Qdrant server port",
      },
      qdrantCollection: {
        type: "string",
        description: "Qdrant collection name",
      },
      qdrantVectorSize: {
        type: "number",
        description: "Qdrant vector size (default: 1024)",
      },
      ollamaHost: {
        type: "string",
        description: "Ollama server host",
      },
      ollamaPort: {
        type: "number",
        description: "Ollama server port",
      },
      ollamaModel: {
        type: "string",
        description: "Ollama model for auto-capture",
      },
      embedModel: {
        type: "string",
        description: "Embedding model for vectorization (default: mxbai-embed-large)",
      },
      embedDimensions: {
        type: "number",
        description: "Embedding dimensions (default: 1024)",
      },
      autoCaptureEnabled: {
        type: "boolean",
        description: "Enable auto-capture feature",
      },
      autoCaptureMinConfidence: {
        type: "number",
        description: "Minimum confidence for auto-capture",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    // ----------------------------------------------------------------
    // Get configuration from api.config with defaults
    // ----------------------------------------------------------------
    const config = (api.config as AgentMemoConfig) || {};
    
    const slotCategories = config.slotCategories || DEFAULT_CATEGORIES;
    const qdrantHost = config.qdrantHost || "localhost";
    const qdrantPort = config.qdrantPort || 6333;
    const qdrantCollection = config.qdrantCollection || "mrc_bot_memory";
    const qdrantVectorSize = config.qdrantVectorSize || 1024;
    const ollamaHost = config.ollamaHost || "http://localhost";
    const ollamaPort = config.ollamaPort || 11434;
    const ollamaModel = config.ollamaModel || "deepseek-r1:8b";
    const embedModel = config.embedModel || "mxbai-embed-large";
    const embedDimensions = config.embedDimensions || 1024;
    const autoCaptureEnabled = config.autoCaptureEnabled !== false; // default true
    const autoCaptureMinConfidence = config.autoCaptureMinConfidence || 0.7;
    
    // State directory from env or default
    const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;

    console.log("[AgentMemo] Configuration:");
    console.log(`  Slot categories: ${slotCategories.join(", ")}`);
    console.log(`  Qdrant: ${qdrantHost}:${qdrantPort}/${qdrantCollection}`);
    console.log(`  Ollama: ${ollamaHost}:${ollamaPort} (model: ${ollamaModel})`);
    console.log(`  Embedding: ${embedModel} (${embedDimensions}d)`);
    console.log(`  AutoCapture: ${autoCaptureEnabled ? "enabled" : "disabled"}`);

    // ----------------------------------------------------------------
    // Initialize services
    // ----------------------------------------------------------------
    const slotDB = new SlotDB(stateDir);

    // Qdrant services (if available)
    const qdrant = new QdrantClient({
      host: qdrantHost,
      port: qdrantPort,
      collection: qdrantCollection,
      vectorSize: qdrantVectorSize,
    });

    const embedding = new EmbeddingClient({
      model: embedModel,
      dimensions: embedDimensions,
    });

    const dedupe = new DeduplicationService(0.95, console);

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
    registerSlotTools(api, slotCategories);
    registerGraphTools(api);

    // ----------------------------------------------------------------
    // Register lifecycle hooks
    // ----------------------------------------------------------------
    registerAutoRecall(api, slotDB);
    registerAutoCapture(api, slotDB, {
      enabled: autoCaptureEnabled,
      minConfidence: autoCaptureMinConfidence,
      useLLM: true,
      ollamaHost,
      ollamaPort,
      ollamaModel,
    });

    console.log("[AgentMemo] Plugin registered successfully");
    console.log("[AgentMemo] Tools: memory_search, memory_store, memory_slot_*, memory_graph_*");
    console.log("[AgentMemo] Hooks: auto-recall, auto-capture");
  },
};

export default agentMemoPlugin;
