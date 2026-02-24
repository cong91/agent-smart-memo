/**
 * Auto-Capture Module v3 - LLM Based
 *
 * Uses OpenAI Completions API compatible LLM for intelligent fact extraction
 * Default: gemini-3.1-pro-low via local proxy
 * Falls back to pattern matching if LLM unavailable
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";
import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { DeduplicationService } from "../services/dedupe.js";
import { extractWithLLM, checkLLMHealth } from "../services/llm-extractor.js";
import { NoiseFilter, getAutoCaptureNamespace, isTraderAgent, MemoryNamespace } from "../shared/memory-config.js";

// Event type constant for type-safe event handling
const AGENT_END_EVENT = "agent_end" as const;

interface AutoCaptureConfig {
  enabled: boolean;
  minConfidence: number;
  useLLM: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  contextWindowMaxTokens?: number;
}

const DEFAULT_CONFIG: AutoCaptureConfig = {
  enabled: true,
  minConfidence: 0.7,
  useLLM: true,
  llmBaseUrl: "http://localhost:8317/v1",
  llmApiKey: "proxypal-local",
  llmModel: "gemini-3.1-pro-low",
};

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Context Window Management Configuration
 */
interface ContextWindowConfig {
  maxConversationTokens: number;  // default: 12_000
  tokenEstimateDivisor: number;   // default: 4
  absoluteMaxMessages: number;    // default: 200
}

interface SelectionStats {
  totalMessages: number;
  filteredMessages: number;
  selectedMessages: number;
  estimatedTokens: number;
  budgetUsedPercent: number;
}

const DEFAULT_CONTEXT_WINDOW: ContextWindowConfig = {
  maxConversationTokens: 12_000,
  tokenEstimateDivisor: 4,
  absoluteMaxMessages: 200,
};

/**
 * Extract text content from a message.
 * Handles both string content and array of content blocks (text, image, tool_use, etc.)
 * CRITICAL: Must NEVER return [object Object] - uses JSON.stringify as ultimate fallback
 */
function extractMessageText(content: unknown): string {
  // Simple string case
  if (typeof content === "string") {
    return content;
  }
  
  // Array of content blocks (OpenAI/Anthropic format)
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        // Text block
        if (block?.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        // Tool use block
        if (block?.type === "tool_use") {
          return `[Tool: ${block.name || "unknown"}]`;
        }
        // Tool result block
        if (block?.type === "tool_result") {
          return `[Tool Result]`;
        }
        // Image block
        if (block?.type === "image" || block?.type === "image_url") {
          return "[Image]";
        }
        // Fallback for any object with text property
        if (typeof block?.text === "string") {
          return block.text;
        }
        // String content property
        if (typeof block?.content === "string") {
          return block.content;
        }
        // Last resort: stringify if it's an object
        if (typeof block === "object" && block !== null) {
          try {
            return JSON.stringify(block);
          } catch {
            return "[Content]";
          }
        }
        return String(block);
      })
      .join(" ");
  }
  
  // Object with text property
  if (typeof content === "object" && content !== null && "text" in content) {
    const textValue = (content as any).text;
    if (typeof textValue === "string") {
      return textValue;
    }
    // If text is not a string, try to stringify it
    try {
      return JSON.stringify(textValue);
    } catch {
      return "[Complex Content]";
    }
  }
  
  // Object with content property (common in some message formats)
  if (typeof content === "object" && content !== null && "content" in content) {
    const contentValue = (content as any).content;
    if (typeof contentValue === "string") {
      return contentValue;
    }
    if (Array.isArray(contentValue)) {
      return extractMessageText(contentValue);
    }
    try {
      return JSON.stringify(contentValue);
    } catch {
      return "[Complex Content]";
    }
  }
  
  // Handle nested objects - stringify instead of toString()
  if (typeof content === "object" && content !== null) {
    try {
      return JSON.stringify(content);
    } catch {
      return "[Complex Content]";
    }
  }
  
  // Fallback for primitives (number, boolean, null, undefined)
  if (content === null) return "";
  if (content === undefined) return "";
  return String(content);
}

/**
 * Estimate token count from text length
 * Uses chars / divisor approximation (default: /4 for English/Vietnamese mix)
 */
function estimateTokens(text: string, divisor: number = 4): number {
  return Math.ceil(text.length / divisor);
}

/**
 * Select messages within token budget using reverse accumulation strategy
 * Iterates from newest to oldest, accumulating messages until budget is reached
 */
function selectMessagesWithinBudget(
  messages: ConversationMessage[],
  config: ContextWindowConfig = DEFAULT_CONTEXT_WINDOW
): { selected: ConversationMessage[]; stats: SelectionStats } {
  // 1. Filter out system messages - only keep user and assistant
  const filtered = messages.filter(
    m => m.role === "user" || m.role === "assistant"
  );

  // 2. Safety cap: if more than absoluteMaxMessages, keep only the most recent ones
  const capped = filtered.length > config.absoluteMaxMessages
    ? filtered.slice(-config.absoluteMaxMessages)
    : filtered;

  // 3. Reverse accumulation: start from newest message
  const selected: ConversationMessage[] = [];
  let tokenCount = 0;

  for (let i = capped.length - 1; i >= 0; i--) {
    const msg = capped[i];
    const msgTokens = estimateTokens(
      `${msg.role}: ${extractMessageText(msg.content)}`,
      config.tokenEstimateDivisor
    );

    if (tokenCount + msgTokens > config.maxConversationTokens) {
      break; // Budget exhausted
    }

    selected.unshift(msg); // Prepend to maintain chronological order
    tokenCount += msgTokens;
  }

  // 4. Stats for logging
  const stats: SelectionStats = {
    totalMessages: messages.length,
    filteredMessages: filtered.length,
    selectedMessages: selected.length,
    estimatedTokens: tokenCount,
    budgetUsedPercent: Math.round(
      (tokenCount / config.maxConversationTokens) * 100
    ),
  };

  return { selected, stats };
}

/**
 * Extract facts using LLM or fallback to patterns
 */
async function extractFacts(
  messages: ConversationMessage[],
  currentSlots: Record<string, Record<string, any>>,
  cfg: AutoCaptureConfig,
  forceUseLLM?: boolean,
): Promise<{ slot_updates: any[]; memories: any[] }> {
  // Build context window config from optional cfg setting
  const contextWindowConfig: ContextWindowConfig = {
    maxConversationTokens: cfg.contextWindowMaxTokens ?? DEFAULT_CONTEXT_WINDOW.maxConversationTokens,
    tokenEstimateDivisor: DEFAULT_CONTEXT_WINDOW.tokenEstimateDivisor,
    absoluteMaxMessages: DEFAULT_CONTEXT_WINDOW.absoluteMaxMessages,
  };

  // Use token-aware context window selection instead of fixed message count
  const { selected: recentMessages, stats } = selectMessagesWithinBudget(messages, contextWindowConfig);

  const text = recentMessages
    .map((m) => `${m.role}: ${extractMessageText(m.content)}`)
    .join("\n");

  console.log(
    `[AutoCapture] Context window: ${stats.selectedMessages}/${stats.totalMessages} msgs, ` +
    `~${stats.estimatedTokens} tokens (${stats.budgetUsedPercent}% budget)`
  );

  // Determine if we should use LLM (allow override from params)
  const shouldUseLLM = forceUseLLM !== undefined ? forceUseLLM : cfg.useLLM;

  // Try LLM first
  if (shouldUseLLM) {
    const isHealthy = await checkLLMHealth(cfg.llmBaseUrl, cfg.llmApiKey);
    if (isHealthy) {
      console.log("[AutoCapture] Using LLM for extraction, model:", cfg.llmModel);
      // Pass LLM config fields to extractWithLLM
      const llmConfig = {
        baseUrl: cfg.llmBaseUrl,
        apiKey: cfg.llmApiKey,
        model: cfg.llmModel,
      };
      return extractWithLLM(text, currentSlots, llmConfig);
    }
    console.log("[AutoCapture] LLM unavailable, using pattern fallback");
  }

  // Fallback to pattern matching
  return extractWithPatterns(text);
}

/**
 * Pattern-based extraction (fallback)
 */
function extractWithPatterns(text: string): { slot_updates: any[]; memories: any[] } {
  const result: { slot_updates: any[]; memories: any[] } = {
    slot_updates: [],
    memories: [],
  };

  // Name extraction
  const nameMatch = text.match(/tên tôi là\s+([^.,;!?\n]+)/i);
  if ((nameMatch?.[1]?.trim().length ?? 0) >= 2) {
    result.slot_updates.push({
      key: "profile.name",
      value: nameMatch![1].trim(),
      confidence: 0.85,
      category: "profile",
    });
  }

  // Location
  const locMatch = text.match(/(?:tôi ở|tôi sống ở|mình ở|I live in)\s+([^.,;!?\n]+)/i);
  if ((locMatch?.[1]?.trim().length ?? 0) >= 2) {
    result.slot_updates.push({
      key: "profile.location",
      value: locMatch![1].trim(),
      confidence: 0.8,
      category: "profile",
    });
  }

  // Theme
  const themeMatch = text.match(/(dark|light)\s+theme/i);
  if (themeMatch) {
    result.slot_updates.push({
      key: "preferences.theme",
      value: themeMatch[1].toLowerCase(),
      confidence: 0.9,
      category: "preferences",
    });
  }

  // Project
  const projMatch = text.match(/(?:đang làm|working on|project)\s+([^.,;!?\n]+)/i);
  if ((projMatch?.[1]?.trim().length ?? 0) >= 2) {
    result.slot_updates.push({
      key: "project.current",
      value: projMatch![1].trim(),
      confidence: 0.75,
      category: "project",
    });
  }

  return result;
}

/**
 * Register auto-capture
 */
export function registerAutoCapture(
  api: OpenClawPluginApi,
  db: SlotDB,
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  dedupe: DeduplicationService,
  config?: Partial<AutoCaptureConfig>,
): void {
  const cfg: AutoCaptureConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    console.log("[AutoCapture] Disabled");
    return;
  }

  console.log(`[AutoCapture] Enabled (LLM: ${cfg.useLLM})`);

  // Lock to prevent re-entrant/infinite loops
  let isCapturing = false;

  // Manual capture tool
  api.registerTool({
    name: "memory_auto_capture",
    label: "Memory Auto Capture",
    description: "Analyze text and extract facts using LLM or pattern matching",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to analyze" },
        use_llm: { type: "boolean", description: "Use LLM for extraction (default: true)" },
      },
      required: ["text"],
    },
    async execute(_id: string, params: { text: string; use_llm?: boolean }, ctx: any) {
      try {
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const agentId = sessionKey.split(":")[1] || "main";
        const userId = sessionKey.split(":").slice(2).join(":") || "default";

        const messages = [{ role: "user" as const, content: params.text }];
        const currentState = db.getCurrentState(userId, agentId);

        // Pass use_llm param to override config
        const extracted = await extractFacts(messages, currentState, cfg, params.use_llm);

        // Store slots
        let slotsStored = 0;
        for (const fact of extracted.slot_updates) {
          if (fact.confidence < cfg.minConfidence!) continue;
          
          try {
            db.set(userId, agentId, {
              key: fact.key,
              value: fact.value,
              category: fact.category,
              source: "auto_capture",
              confidence: fact.confidence,
            });
            slotsStored++;
          } catch (e) {
            console.error("[AutoCapture] Failed to store:", e);
          }
        }

        return {
          content: [{
            type: "text",
            text: `✅ Extraction complete!\nMethod: ${params.use_llm !== false ? "LLM" : "Pattern"}\nSlots stored: ${slotsStored}\n\nExtracted:\n${JSON.stringify(extracted, null, 2)}`,
          }],
          details: { extracted, slotsStored },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `❌ Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  });

  console.log("[AutoCapture] Registered memory_auto_capture tool");

  // Auto-capture hook after each conversation turn using type-safe event name
  api.on(AGENT_END_EVENT, async (event: unknown, ctx: unknown) => {
    // Prevent re-entrant/infinite loops
    if (isCapturing) {
      console.log("[AutoCapture] Skipping: capture already in progress");
      return;
    }
    
    try {
      isCapturing = true;
      
      // Type-safe casting for runtime values
      const typedEvent = event as { messages?: unknown[]; response?: string; metadata?: Record<string, unknown> };
      const typedCtx = ctx as { sessionKey?: string };
      
      const sessionKey = typedCtx?.sessionKey ?? "agent:main:default";
      const agentId = sessionKey.split(":")[1] || "main";
      const userId = sessionKey.split(":").slice(2).join(":") || "default";
      
      // Initialize noise filter for this agent
      const noiseFilter = new NoiseFilter(agentId);
      
      // Check if agent is blocked
      if (noiseFilter.isBlocked()) {
        console.log(`[AutoCapture] Skipping: agent "${agentId}" is in blocklist`);
        return;
      }
      
      // Get conversation messages from event with type-safe access
      const messages = (typedEvent?.messages ?? []) as ConversationMessage[];
      if (messages.length === 0) return;
      
      // Skip if only system messages
      const hasUserOrAssistant = messages.some((m: any) =>
        m.role === "user" || m.role === "assistant"
      );
      if (!hasUserOrAssistant) return;
      
      // Skip messages that look like internal AutoCapture messages (prevent self-triggering)
      const hasAutoCaptureSource = messages.some((m: any) => {
        const text = extractMessageText(m.content);
        return text.includes("[AutoCapture]") || text.includes("Memory stored") || text.includes("Memory updated");
      });
      if (hasAutoCaptureSource) {
        console.log("[AutoCapture] Skipping: conversation contains AutoCapture internal messages");
        return;
      }
      
      // Get target namespace for this agent
      const targetNamespace: MemoryNamespace = getAutoCaptureNamespace(agentId);
      
      // Combine all message text for noise detection
      const fullText = messages
        .map((m: any) => extractMessageText(m.content))
        .join(" ");
      
      // Check if content should be skipped (noise filter)
      if (noiseFilter.shouldSkip(fullText)) {
        if (isTraderAgent(agentId)) {
          console.log(`[AutoCapture] Skipping trading content for trader agent - use memory_store tool to save trading data`);
        } else {
          console.log(`[AutoCapture] Skipping: content matches noise patterns`);
        }
        return;
      }
      
      console.log(`[AutoCapture] Processing ${messages.length} messages for ${agentId} (namespace: ${targetNamespace})`);
      
      const currentState = db.getCurrentState(userId, agentId);
      const extracted = await extractFacts(messages, currentState, cfg);
      
      // Store slots
      let slotsStored = 0;
      for (const fact of extracted.slot_updates) {
        if (fact.confidence < cfg.minConfidence!) continue;
        try {
          db.set(userId, agentId, {
            key: fact.key,
            value: fact.value,
            category: fact.category,
            source: "auto_capture",
            confidence: fact.confidence,
          });
          slotsStored++;
          console.log(`[AutoCapture] Stored: ${fact.key} = ${JSON.stringify(fact.value)}`);
        } catch (e) {
          console.error("[AutoCapture] Failed to store slot:", e);
        }
      }
      
      // Store memories to Qdrant
      let memoriesStored = 0;
      console.log(`[AutoCapture] Extracted ${extracted.memories.length} memories, ${extracted.slot_updates.length} slot updates`);
      
      if (extracted.memories.length > 0) {
        console.log(`[AutoCapture] Starting Qdrant storage for ${extracted.memories.length} memories...`);
        
        for (let i = 0; i < extracted.memories.length; i++) {
          const memory = extracted.memories[i];
          console.log(`[AutoCapture] Processing memory ${i + 1}/${extracted.memories.length}...`);
          
          try {
            const text = typeof memory === "string" ? memory : memory.text || JSON.stringify(memory);
            if (!text || text.trim().length === 0) {
              console.warn(`[AutoCapture] Memory ${i + 1} has empty text, skipping`);
              continue;
            }
            
            console.log(`[AutoCapture] Generating embedding for: "${text.substring(0, 60)}..."`);
            let vector: number[];
            try {
              vector = await embedding.embed(text);
              console.log(`[AutoCapture] Embedding generated, vector length: ${vector.length}`);
            } catch (embedError: any) {
              console.error(`[AutoCapture] Embedding failed for memory ${i + 1}:`, embedError.message);
              continue;
            }
            
            // Check for duplicates (scoped to target namespace)
            console.log(`[AutoCapture] Searching for duplicates in namespace: ${targetNamespace}...`);
            let candidates: any[] = [];
            try {
              candidates = await qdrant.search(vector, 5, {
                must: [{ key: "namespace", match: { value: targetNamespace } }],
              });
              console.log(`[AutoCapture] Found ${candidates.length} candidate matches`);
            } catch (searchError: any) {
              console.error(`[AutoCapture] Duplicate search failed:`, searchError.message);
              candidates = [];
            }
            
            const duplicateId = dedupe.findDuplicate(text, candidates);
            console.log(`[AutoCapture] Duplicate check result: ${duplicateId ? `found duplicate ${duplicateId}` : "no duplicate"}`);
            
            if (duplicateId) {
              // Update existing memory
              console.log(`[AutoCapture] Updating existing memory ${duplicateId}...`);
              try {
                await qdrant.upsert([{
                  id: duplicateId,
                  vector,
                  payload: {
                    text,
                    namespace: targetNamespace,
                    source_agent: agentId,
                    source_type: "auto_capture",
                    userId: userId,
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                  },
                }]);
                console.log(`[AutoCapture] ✓ Memory updated (duplicate): ${text.substring(0, 50)}...`);
                memoriesStored++;
              } catch (upsertError: any) {
                console.error(`[AutoCapture] Failed to update duplicate memory:`, upsertError.message);
              }
            } else {
              // Create new memory
              const id = crypto.randomUUID();
              console.log(`[AutoCapture] Creating new memory with ID: ${id}...`);
              try {
                await qdrant.upsert([{
                  id,
                  vector,
                  payload: {
                    text,
                    namespace: targetNamespace,
                    source_agent: agentId,
                    source_type: "auto_capture",
                    userId: userId,
                    timestamp: Date.now(),
                  },
                }]);
                console.log(`[AutoCapture] ✓ Memory stored: ${text.substring(0, 50)}...`);
                memoriesStored++;
              } catch (upsertError: any) {
                console.error(`[AutoCapture] Failed to store new memory:`, upsertError.message);
              }
            }
          } catch (e: any) {
            console.error(`[AutoCapture] Unexpected error processing memory ${i + 1}:`, e.message);
            console.error(`[AutoCapture] Stack:`, e.stack);
          }
        }
        console.log(`[AutoCapture] Memory storage complete: ${memoriesStored}/${extracted.memories.length} stored`);
      } else {
        console.log(`[AutoCapture] No memories to store (empty extraction result)`);
      }
      
      if (slotsStored > 0 || memoriesStored > 0) {
        console.log(`[AutoCapture] Complete: ${slotsStored} slots stored, ${memoriesStored} memories stored`);
      }
    } catch (error) {
      console.error("[AutoCapture] Hook error:", error);
    } finally {
      // Always release the lock to prevent deadlocks
      isCapturing = false;
    }
  });
}
