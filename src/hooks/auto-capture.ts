/**
 * Auto-Capture Module v2 - Ollama LLM Based
 * 
 * Uses local deepseek-r1:8b for intelligent fact extraction
 * Falls back to pattern matching if Ollama unavailable
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";
import { extractWithOllama, checkOllamaHealth } from "../services/ollama-extractor.js";

interface AutoCaptureConfig {
  enabled: boolean;
  minConfidence: number;
  useLLM: boolean;
  ollamaHost: string;
  ollamaPort: number;
  ollamaModel: string;
}

const DEFAULT_CONFIG: Partial<AutoCaptureConfig> = {
  enabled: true,
  minConfidence: 0.7,
  useLLM: true,
  ollamaHost: "http://localhost",
  ollamaPort: 11434,
  ollamaModel: "deepseek-r1:8b",
};

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Extract facts using Ollama LLM or fallback to patterns
 */
async function extractFacts(
  messages: ConversationMessage[],
  currentSlots: Record<string, Record<string, any>>,
  cfg: AutoCaptureConfig,
): Promise<{ slot_updates: any[]; memories: any[] }> {
  const text = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => m.content)
    .join("\n");

  // Try Ollama first
  if (cfg.useLLM) {
    const isHealthy = await checkOllamaHealth(cfg.ollamaHost, cfg.ollamaPort);
    if (isHealthy) {
      console.log("[AutoCapture] Using Ollama LLM for extraction");
      return extractWithOllama(text, currentSlots, cfg);
    }
    console.log("[AutoCapture] Ollama unavailable, using pattern fallback");
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
  if (nameMatch?.[1]?.trim().length >= 2) {
    result.slot_updates.push({
      key: "profile.name",
      value: nameMatch[1].trim(),
      confidence: 0.85,
      category: "profile",
    });
  }

  // Location
  const locMatch = text.match(/(?:tôi ở|tôi sống ở|mình ở|I live in)\s+([^.,;!?\n]+)/i);
  if (locMatch?.[1]?.trim().length >= 2) {
    result.slot_updates.push({
      key: "profile.location",
      value: locMatch[1].trim(),
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
  if (projMatch?.[1]?.trim().length >= 2) {
    result.slot_updates.push({
      key: "project.current",
      value: projMatch[1].trim(),
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
  config?: Partial<AutoCaptureConfig>,
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    console.log("[AutoCapture] Disabled");
    return;
  }

  console.log(`[AutoCapture] Enabled (LLM: ${cfg.useLLM})`);

  // Manual capture tool
  api.registerTool({
    name: "memory_auto_capture",
    description: "Analyze text and extract facts using LLM (Ollama) or pattern matching",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to analyze" },
        use_llm: { type: "boolean", description: "Use Ollama LLM (default: true)" },
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

        const extracted = await extractFacts(messages, currentState, cfg);

        // Store slots
        let slotsStored = 0;
        for (const fact of extracted.slot_updates) {
          if (fact.confidence < cfg.minConfidence) continue;
          
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
            text: `✅ Extraction complete!\nMethod: ${params.use_llm !== false ? "Ollama LLM" : "Pattern"}\nSlots stored: ${slotsStored}\n\nExtracted:\n${JSON.stringify(extracted, null, 2)}`,
          }],
          details: { extracted, slotsStored },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `❌ Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  });

  console.log("[AutoCapture] Registered memory_auto_capture tool");

  // Auto-capture hook after each conversation turn
  if (api.hooks?.onAfterAgentEnd) {
    api.hooks.onAfterAgentEnd(async (ctx: any) => {
      try {
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const agentId = sessionKey.split(":")[1] || "main";
        const userId = sessionKey.split(":").slice(2).join(":") || "default";
        
        // Get conversation messages
        const messages = ctx?.messages || [];
        if (messages.length === 0) return;
        
        // Skip if only system messages
        const hasUserOrAssistant = messages.some((m: any) => 
          m.role === "user" || m.role === "assistant"
        );
        if (!hasUserOrAssistant) return;
        
        console.log(`[AutoCapture] Processing ${messages.length} messages for ${agentId}`);
        
        const currentState = db.getCurrentState(userId, agentId);
        const extracted = await extractFacts(messages, currentState, cfg);
        
        // Store slots
        let slotsStored = 0;
        for (const fact of extracted.slot_updates) {
          if (fact.confidence < cfg.minConfidence) continue;
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
        
        // Store memories to Qdrant if available
        if (extracted.memories.length > 0) {
          console.log(`[AutoCapture] ${extracted.memories.length} memories extracted (not stored - Qdrant tool not available in hook)`);
        }
        
        if (slotsStored > 0) {
          console.log(`[AutoCapture] Complete: ${slotsStored} slots stored`);
        }
      } catch (error) {
        console.error("[AutoCapture] Hook error:", error);
      }
    });
    console.log("[AutoCapture] Registered onAfterAgentEnd hook");
  } else {
    console.warn("[AutoCapture] onAfterAgentEnd hook not available - only manual capture enabled");
  }
}
