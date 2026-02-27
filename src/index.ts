/**
 * Agent-Memo: Slot Memory Plugin for OpenClaw v3.0
 * 
 * Refactored to use modular tool structure with single Qdrant collection
 * - Slot tools: memory_slot_get/set/delete/list
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
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  embedBaseUrl?: string;
  embedModel?: string;
  embedDimensions?: number;
  autoCaptureEnabled?: boolean;
  autoCaptureMinConfidence?: number;
  contextWindowMaxTokens?: number;
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
        description: "Qdrant collection name (default: mrc_bot_memory)",
      },
      qdrantVectorSize: {
        type: "number",
        description: "Qdrant vector size (default: 1024)",
      },
      llmBaseUrl: {
        type: "string",
        description: "LLM API base URL (OpenAI compatible)",
      },
      llmApiKey: {
        type: "string",
        description: "LLM API key",
      },
      llmModel: {
        type: "string",
        description: "LLM model for auto-capture",
      },
      embedBaseUrl: {
        type: "string",
        description: "Embedding service base URL (default: http://localhost:11434)",
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
      contextWindowMaxTokens: {
        type: "number",
        description: "Maximum tokens for context window in auto-capture (default: 12000)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    // ----------------------------------------------------------------
    // Get configuration from api.config with defaults
    // Handle both wrapped config ({ enabled, config }) and unwrapped config
    // ----------------------------------------------------------------
    const rawConfig = api.config as any;
    const config: AgentMemoConfig = rawConfig?.config || rawConfig || {};
    
    const slotCategories = config.slotCategories || DEFAULT_CATEGORIES;
    const qdrantHost = config.qdrantHost || "localhost";
    const qdrantPort = config.qdrantPort || 6333;
    const qdrantCollection = config.qdrantCollection || "mrc_bot_memory";
    const qdrantVectorSize = config.qdrantVectorSize || 1024;
    const llmBaseUrl = config.llmBaseUrl || "http://localhost:8317/v1";
    const llmApiKey = config.llmApiKey || "proxypal-local";
    const llmModel = config.llmModel || "gemini-2.5-flash";
    const embedBaseUrl = config.embedBaseUrl || "http://localhost:11434";
    const embedModel = config.embedModel || "mxbai-embed-large";
    const embedDimensions = config.embedDimensions || 1024;
    const autoCaptureEnabled = config.autoCaptureEnabled !== false; // default true
    const autoCaptureMinConfidence = config.autoCaptureMinConfidence || 0.7;
    const contextWindowMaxTokens = config.contextWindowMaxTokens || 12000;

    // State directory from env or default
    const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;

    console.log("[AgentMemo] Configuration:");
    console.log(`  Slot categories: ${slotCategories.join(", ")}`);
    console.log(`  Qdrant: ${qdrantHost}:${qdrantPort}/${qdrantCollection}`);
    console.log(`  LLM: ${llmBaseUrl} (model: ${llmModel})`);
    console.log(`  Embedding: ${embedBaseUrl} (model: ${embedModel}, ${embedDimensions}d)`);
    console.log(`  AutoCapture: ${autoCaptureEnabled ? "enabled" : "disabled"}`);
    console.log(`  ContextWindow: ${contextWindowMaxTokens} tokens`);

    // ----------------------------------------------------------------
    // Initialize services
    // ----------------------------------------------------------------
    const slotDB = new SlotDB(stateDir);

    // Single Qdrant collection for all agents - namespace isolation via payload
    const qdrant = new QdrantClient({
      host: qdrantHost,
      port: qdrantPort,
      collection: qdrantCollection,
      vectorSize: qdrantVectorSize,
    });

    const embedding = new EmbeddingClient({
      embeddingApiUrl: embedBaseUrl,
      model: embedModel,
      dimensions: embedDimensions,
    });

    const dedupe = new DeduplicationService(0.95, console);

    // ----------------------------------------------------------------
    // Register Qdrant tools from modules
    // ----------------------------------------------------------------
    const memorySearchTool = createMemorySearchTool(qdrant, embedding, "agent_decisions");
    const memoryStoreTool = createMemoryStoreTool(qdrant, embedding, dedupe, "agent_decisions");

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
    registerAutoRecall(api, slotDB, qdrant, embedding);
    registerAutoCapture(api, slotDB, qdrant, embedding, dedupe, {
      enabled: autoCaptureEnabled,
      minConfidence: autoCaptureMinConfidence,
      useLLM: true,
      llmBaseUrl,
      llmApiKey,
      llmModel,
      contextWindowMaxTokens,
    });

    console.log("[AgentMemo] Plugin registered successfully");
    console.log("[AgentMemo] Tools: memory_search, memory_store, memory_slot_*, memory_graph_*");
    console.log("[AgentMemo] Hooks: auto-recall, auto-capture");
  },
};

export default agentMemoPlugin;
