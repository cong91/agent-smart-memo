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
  summarizeEveryActions?: number;
}

const CONFIG_KEY_CANDIDATES: (keyof AgentMemoConfig)[] = [
  "slotCategories",
  "qdrantHost",
  "qdrantPort",
  "qdrantCollection",
  "llmBaseUrl",
  "llmApiKey",
  "llmModel",
  "embedBaseUrl",
  "embedModel",
  "embedDimensions",
  "autoCaptureEnabled",
  "autoCaptureMinConfidence",
  "contextWindowMaxTokens",
  "summarizeEveryActions",
];

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function hasAnyConfigKey(obj: Record<string, any> | null): boolean {
  if (!obj) return false;
  return CONFIG_KEY_CANDIDATES.some((key) => key in obj);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function findNestedStringKey(
  input: unknown,
  key: string,
  maxDepth = 5
): string | undefined {
  const visited = new Set<unknown>();

  function walk(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== "object" || depth > maxDepth || visited.has(node)) {
      return undefined;
    }

    visited.add(node);
    const obj = node as Record<string, unknown>;

    if (typeof obj[key] === "string" && (obj[key] as string).trim().length > 0) {
      return (obj[key] as string).trim();
    }

    for (const value of Object.values(obj)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }

    return undefined;
  }

  return walk(input, 0);
}

function resolvePluginConfig(rawConfig: unknown): {
  config: AgentMemoConfig;
  shape: string;
} {
  const root = asObject(rawConfig);

  const candidates: Array<{ shape: string; value: Record<string, any> | null }> = [
    { shape: "api.config", value: root },
    { shape: "api.config.config", value: asObject(root?.config) },
    { shape: "api.config.entry.config", value: asObject(root?.entry?.config) },
    { shape: "api.config.plugin.config", value: asObject(root?.plugin?.config) },
    { shape: "api.config.value.config", value: asObject(root?.value?.config) },
    { shape: "api.config.settings.config", value: asObject(root?.settings?.config) },
  ];

  for (const candidate of candidates) {
    if (hasAnyConfigKey(candidate.value)) {
      return { config: candidate.value as AgentMemoConfig, shape: candidate.shape };
    }
  }

  // Backward compatibility for wrapper style { enabled, config }
  if (asObject(root?.config)) {
    return {
      config: asObject(root?.config) as AgentMemoConfig,
      shape: "api.config.config (wrapper-fallback)",
    };
  }

  return { config: (root || {}) as AgentMemoConfig, shape: "api.config (empty/fallback)" };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const DEFAULT_CATEGORIES = ["profile", "preferences", "project", "environment", "custom"];

const agentMemoPlugin = {
  id: "agent-smart-memo",
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
        description: "Embedding model for vectorization (default: qwen3-embedding:0.6b)",
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
      summarizeEveryActions: {
        type: "number",
        description: "Auto-summarize project_living_state every N actions (default: 6)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    // ----------------------------------------------------------------
    // Get configuration from api.config with defaults
    // Handle wrapped/unwrapped/nested config objects robustly
    // ----------------------------------------------------------------
    const rawConfig = api.config as any;
    const { config, shape } = resolvePluginConfig(rawConfig);

    const slotCategories = config.slotCategories || DEFAULT_CATEGORIES;
    const qdrantHost = config.qdrantHost || "localhost";
    const qdrantPort = config.qdrantPort || 6333;
    const qdrantCollection = config.qdrantCollection || "mrc_bot_memory";
    const qdrantVectorSize = config.qdrantVectorSize || 1024;
    const llmBaseUrl = config.llmBaseUrl || "http://localhost:8317/v1";
    const llmApiKey = config.llmApiKey || "proxypal-local";
    const resolvedLlmModel = firstNonEmptyString(
      config.llmModel,
      findNestedStringKey(rawConfig, "llmModel")
    );
    const llmModel = resolvedLlmModel || "gemini-2.5-flash";
    const llmModelFallbackUsed = !resolvedLlmModel;
    const embedBaseUrl = config.embedBaseUrl || "http://localhost:11434";
    const embedModel = config.embedModel || "qwen3-embedding:0.6b";
    const embedDimensions = config.embedDimensions || 1024;
    const autoCaptureEnabled = config.autoCaptureEnabled !== false; // default true
    const autoCaptureMinConfidence = config.autoCaptureMinConfidence || 0.7;
    const contextWindowMaxTokens = config.contextWindowMaxTokens || 12000;
    const summarizeEveryActions = config.summarizeEveryActions || 6;

    // State directory from env or default
    const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;

    console.log(
      `[AgentMemo] Configuration resolved (shape: ${shape}, llmModel: ${llmModel}, fallbackUsed: ${llmModelFallbackUsed})`
    );
    console.log("[AgentMemo] Configuration:");
    console.log(`  Slot categories: ${slotCategories.join(", ")}`);
    console.log(`  Qdrant: ${qdrantHost}:${qdrantPort}/${qdrantCollection}`);
    console.log(`  LLM: ${llmBaseUrl} (model: ${llmModel})`);
    console.log(`  Embedding: ${embedBaseUrl} (model: ${embedModel}, ${embedDimensions}d)`);
    console.log(`  AutoCapture: ${autoCaptureEnabled ? "enabled" : "disabled"}`);
    console.log(`  ContextWindow: ${contextWindowMaxTokens} tokens`);
    console.log(`  SummarizeEveryActions: ${summarizeEveryActions}`);

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
      summarizeEveryActions,
    });

    console.log("[AgentMemo] Plugin registered successfully");
    console.log("[AgentMemo] Tools: memory_search, memory_store, memory_slot_*, memory_graph_*");
    console.log("[AgentMemo] Hooks: auto-recall, auto-capture");
  },
};

export default agentMemoPlugin;
