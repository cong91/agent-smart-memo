/**
 * Configuration loader for Agent-Memo Plugin
 * Reads from environment variables or .env file
 */

import { config } from "dotenv";
import { join } from "path";

// Load .env file from plugin directory
config({ path: join(import.meta.dirname || "", "../.env") });

/**
 * Plugin configuration object
 * All values read from environment variables with sensible defaults
 */
export const PluginConfig = {
  // Qdrant settings
  qdrant: {
    host: process.env.QDRANT_HOST || "localhost",
    port: parseInt(process.env.QDRANT_PORT || "6333"),
    collection: process.env.QDRANT_COLLECTION || "mrc_bot_memory",
    timeout: parseInt(process.env.QDRANT_TIMEOUT || "30000"),
  },

  // Ollama LLM settings
  ollama: {
    host: process.env.OLLAMA_HOST || "http://localhost",
    port: parseInt(process.env.OLLAMA_PORT || "11434"),
    model: process.env.OLLAMA_MODEL || "deepseek-r1:8b",
    timeout: parseInt(process.env.OLLAMA_TIMEOUT || "60000"),
    get baseUrl() {
      return `${this.host}:${this.port}`;
    },
  },

  // Embedding service settings
  embedding: {
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1024"),
    apiUrl: process.env.EMBEDDING_API_URL || "http://localhost:8000",
  },

  // Auto-capture settings
  autoCapture: {
    enabled: process.env.AUTO_CAPTURE_ENABLED !== "false", // default true
    minConfidence: parseFloat(process.env.AUTO_CAPTURE_MIN_CONFIDENCE || "0.7"),
    useLLM: process.env.AUTO_CAPTURE_USE_LLM !== "false", // default true
    // RAG Memory Isolation - Noise Filter settings
    agentBlocklist: (process.env.AUTO_CAPTURE_AGENT_BLOCKLIST || "trading-bot,scrum-agent").split(",").filter(Boolean),
    noisePatterns: (process.env.AUTO_CAPTURE_NOISE_PATTERNS || "").split(",").filter(Boolean).map((p) => new RegExp(p, "i")),
    maxMessagesPerCapture: parseInt(process.env.AUTO_CAPTURE_MAX_MESSAGES || "50"),
    minContentLength: parseInt(process.env.AUTO_CAPTURE_MIN_CONTENT_LENGTH || "20"),
    noiseThreshold: parseFloat(process.env.AUTO_CAPTURE_NOISE_THRESHOLD || "0.5"),
  },

  // Context window management settings
  contextWindow: {
    maxConversationTokens: parseInt(
      process.env.CONTEXT_WINDOW_MAX_TOKENS || "12000"
    ),
    tokenEstimateDivisor: parseInt(
      process.env.CONTEXT_WINDOW_TOKEN_DIVISOR || "4"
    ),
    absoluteMaxMessages: parseInt(
      process.env.CONTEXT_WINDOW_MAX_MESSAGES || "200"
    ),
  },

  // State storage
  stateDir: process.env.STATE_DIR || `${process.env.HOME}/.openclaw`,

  // Plugin defaults
  defaults: {
    namespace: process.env.DEFAULT_NAMESPACE || "default",
    slotCategories: (process.env.DEFAULT_SLOT_CATEGORIES || "profile,preferences,project,environment,custom").split(","),
  },
};

/**
 * Validate configuration
 * Checks if required services are accessible
 */
export async function validateConfig(): Promise<{ qdrant: boolean; ollama: boolean }> {
  const results = { qdrant: false, ollama: false };

  // Check Qdrant
  try {
    const response = await fetch(
      `http://${PluginConfig.qdrant.host}:${PluginConfig.qdrant.port}/collections`,
      { signal: AbortSignal.timeout(5000) }
    );
    results.qdrant = response.ok;
  } catch {
    results.qdrant = false;
  }

  // Check Ollama
  try {
    const response = await fetch(`${PluginConfig.ollama.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    results.ollama = response.ok;
  } catch {
    results.ollama = false;
  }

  return results;
}

/**
 * Print configuration (for debugging)
 */
export function printConfig(): void {
  console.log("[AgentMemo] Configuration:");
  console.log(`  Qdrant: ${PluginConfig.qdrant.host}:${PluginConfig.qdrant.port}/${PluginConfig.qdrant.collection}`);
  console.log(`  Ollama: ${PluginConfig.ollama.baseUrl} (model: ${PluginConfig.ollama.model})`);
  console.log(`  Embedding: ${PluginConfig.embedding.model} (${PluginConfig.embedding.dimensions}d)`);
  console.log(`  AutoCapture: ${PluginConfig.autoCapture.enabled ? "enabled" : "disabled"}`);
  console.log(`  StateDir: ${PluginConfig.stateDir}`);
}
