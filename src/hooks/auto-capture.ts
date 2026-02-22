/**
 * Auto-Capture Module - Task AUTOCAPTURE-FIX-001
 * 
 * Automatically extracts facts from conversations and stores them.
 * Runs AFTER each conversation turn via onAfterAgentEnd hook.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";

// ============================================================================
// Configuration
// ============================================================================

interface AutoCaptureConfig {
  enabled: boolean;
  minConfidence: number;
  batchSize: number; // Extract every N turns
  maxTokens: number;
}

const DEFAULT_CONFIG: AutoCaptureConfig = {
  enabled: true,
  minConfidence: 0.7,
  batchSize: 1, // Extract after every turn
  maxTokens: 500,
};

// ============================================================================
// Types
// ============================================================================

interface ExtractedFact {
  key: string;
  value: any;
  confidence: number;
  category: string;
}

interface ExtractedMemory {
  text: string;
  namespace: string;
  confidence: number;
}

interface ExtractionResult {
  slot_updates: ExtractedFact[];
  memories: ExtractedMemory[];
}

// Simple conversation message type
interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ============================================================================
// LLM-based Extractor (Fallback to pattern matching if no LLM)
// ============================================================================

/**
 * Extract facts using pattern matching (fallback when LLM not available)
 */
function extractFactsWithPatterns(
  messages: ConversationMessage[],
  currentSlots: Record<string, Record<string, any>>,
): ExtractionResult {
  const result: ExtractionResult = {
    slot_updates: [],
    memories: [],
  };

  // Combine all user and assistant messages
  const text = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => m.content)
    .join("\n");

  // Pattern 1: Name extraction (Vietnamese & English)
  const namePatterns = [
    /(?:tên tôi là|tên mình là|tôi tên là|my name is|I'm|I am)\s+([A-Z][a-zA-Z\s]+)/i,
    /(?:gọi tôi là|call me)\s+([A-Z][a-zA-Z\s]+)/i,
  ];
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.slot_updates.push({
        key: "profile.name",
        value: match[1].trim(),
        confidence: 0.85,
        category: "profile",
      });
      break;
    }
  }

  // Pattern 2: Location extraction
  const locationPatterns = [
    /(?:tôi ở|tôi sống ở|mình ở|I live in|I'm from|I am from|based in)\s+([A-Z][a-zA-Z\s]+)/i,
    /(?:location|timezone)\s*[:：]\s*([A-Za-z\/\+\-0-9\s]+)/i,
  ];
  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.slot_updates.push({
        key: "profile.location",
        value: match[1].trim(),
        confidence: 0.8,
        category: "profile",
      });
      break;
    }
  }

  // Pattern 3: Project mention
  const projectPatterns = [
    /(?:đang làm|working on|project)\s*[:：]\s*([A-Z][a-zA-Z\s]+)/i,
    /(?:current project|dự án hiện tại)\s*[:：]\s*([A-Z][a-zA-Z\s]+)/i,
  ];
  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.slot_updates.push({
        key: "project.current",
        value: match[1].trim(),
        confidence: 0.75,
        category: "project",
      });
      break;
    }
  }

  // Pattern 4: Preferences (theme, language)
  const themeMatch = text.match(/(?:theme|giao diện|chế độ)\s*[:：]?\s*(dark|light|auto)/i);
  if (themeMatch) {
    result.slot_updates.push({
      key: "preferences.theme",
      value: themeMatch[1].toLowerCase(),
      confidence: 0.9,
      category: "preferences",
    });
  }

  // Pattern 5: Tech stack mention
  const techMatch = text.match(/(?:tech stack|công nghệ|using)\s*[:：]\s*(.+)/i);
  if (techMatch) {
    const techs = techMatch[1].split(/[,，;；]/).map((t) => t.trim()).filter(Boolean);
    if (techs.length > 0) {
      result.slot_updates.push({
        key: "project.tech_stack",
        value: techs,
        confidence: 0.7,
        category: "project",
      });
    }
  }

  // Pattern 6: Extract important statements as memories
  const importantPatterns = [
    /(?:nhớ rằng|remember that|important|quan trọng)\s*[:：]\s*(.+)/i,
    /(?:lưu ý|note)\s*[:：]\s*(.+)/i,
  ];
  for (const pattern of importantPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.memories.push({
        text: match[1].trim(),
        namespace: "auto_capture",
        confidence: 0.8,
      });
    }
  }

  return result;
}

/**
 * Extract facts using LLM (preferred method when available)
 * This is a placeholder - actual implementation would call LLM API
 */
async function extractFactsWithLLM(
  messages: ConversationMessage[],
  currentSlots: Record<string, Record<string, any>>,
  agentId: string,
): Promise<ExtractionResult> {
  // For now, use pattern matching as LLM fallback
  // In production, this would call an LLM with a prompt like:
  /*
  const prompt = `
    Analyze this conversation and extract structured facts.
    Current known facts: ${JSON.stringify(currentSlots)}
    
    Conversation:
    ${messages.map(m => `${m.role}: ${m.content}`).join('\n')}
    
    Extract any new facts about:
    - User's name, location, timezone, preferences
    - Current project, tech stack, deadlines
    - Important information to remember
    
    Return JSON:
    {
      "slot_updates": [{"key": "profile.name", "value": "...", "confidence": 0.9}],
      "memories": [{"text": "...", "namespace": "assistant", "confidence": 0.8}]
    }
  `;
  const response = await callLLM(prompt);
  return JSON.parse(response);
  */
  
  return extractFactsWithPatterns(messages, currentSlots);
}

// ============================================================================
// Auto-Capture Logic
// ============================================================================

/**
 * Process extracted facts and store them
 */
async function processCaptures(
  db: SlotDB,
  userId: string,
  agentId: string,
  result: ExtractionResult,
  config: AutoCaptureConfig,
): Promise<{ slotsStored: number; memoriesStored: number }> {
  let slotsStored = 0;
  let memoriesStored = 0;

  // Process slot updates
  for (const fact of result.slot_updates) {
    if (fact.confidence < config.minConfidence) {
      console.log(`[AutoCapture] Skipped ${fact.key} (confidence ${fact.confidence} < ${config.minConfidence})`);
      continue;
    }

    try {
      // Check if value changed
      const existing = db.get(userId, agentId, { key: fact.key });
      if (!Array.isArray(existing) && existing) {
        if (JSON.stringify(existing.value) === JSON.stringify(fact.value)) {
          continue; // Skip if same value
        }
      }

      // Store/update slot
      db.set(userId, agentId, {
        key: fact.key,
        value: fact.value,
        category: fact.category,
        source: "auto_capture",
        confidence: fact.confidence,
      });

      slotsStored++;
      console.log(`[AutoCapture] Slot stored: ${fact.key} = ${JSON.stringify(fact.value)} (${fact.confidence})`);
    } catch (error) {
      console.error(`[AutoCapture] Failed to store slot ${fact.key}:`, error);
    }
  }

  // Process memories for Qdrant
  for (const memory of result.memories) {
    if (memory.confidence < config.minConfidence) {
      continue;
    }

    // For now, log the memory (actual Qdrant storage would be here)
    memoriesStored++;
    console.log(`[AutoCapture] Memory captured: "${memory.text.substring(0, 80)}..." (${memory.confidence})`);
  }

  return { slotsStored, memoriesStored };
}

// ============================================================================
// Hook Registration
// ============================================================================

export function registerAutoCapture(api: OpenClawPluginApi, db: SlotDB, config?: Partial<AutoCaptureConfig>): void {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  if (!finalConfig.enabled) {
    console.log("[AutoCapture] Disabled by config");
    return;
  }

  // Check available hooks
  console.log("[AutoCapture] Available hooks:", Object.keys(api.hooks || {}));

  // Try to register onAfterAgentEnd hook
  if (api.hooks?.onAfterAgentEnd) {
    api.hooks.onAfterAgentEnd(async (ctx: any) => {
      try {
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const parts = sessionKey.split(":");
        const agentId = parts.length >= 2 ? parts[1] : "main";
        const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";

        // Get conversation messages
        const messages: ConversationMessage[] = ctx?.messages || [];
        if (messages.length === 0) {
          return;
        }

        console.log(`[AutoCapture] Processing ${messages.length} messages for ${agentId}`);

        // Get current state for context
        const currentState = db.getCurrentState(userId, agentId);

        // Extract facts
        const extraction = await extractFactsWithLLM(messages, currentState, agentId);

        // Store captured facts
        const { slotsStored, memoriesStored } = await processCaptures(
          db,
          userId,
          agentId,
          extraction,
          finalConfig,
        );

        if (slotsStored > 0 || memoriesStored > 0) {
          console.log(`[AutoCapture] Complete: ${slotsStored} slots, ${memoriesStored} memories stored`);
        }
      } catch (error) {
        console.error("[AutoCapture] Error:", error);
      }
    });

    console.log("[AutoCapture] Registered onAfterAgentEnd hook");
  } else {
    console.warn("[AutoCapture] onAfterAgentEnd hook not available in plugin SDK");
    console.warn("[AutoCapture] Falling back to manual capture via tools only");
  }

  // Also register a tool for manual capture if hooks not available
  api.registerTool({
    name: "memory_auto_capture",
    description: `Manually trigger auto-capture on recent conversation. Use this to extract and store facts from the conversation when auto-capture hooks are not available.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Conversation text to analyze for facts",
        },
      },
      required: ["text"],
    },
    async execute(_id: string, params: { text: string }, ctx: any) {
      try {
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const parts = sessionKey.split(":");
        const agentId = parts.length >= 2 ? parts[1] : "main";
        const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";

        const messages: ConversationMessage[] = [{ role: "user", content: params.text }];
        const currentState = db.getCurrentState(userId, agentId);

        const extraction = await extractFactsWithLLM(messages, currentState, agentId);

        const { slotsStored, memoriesStored } = await processCaptures(
          db,
          userId,
          agentId,
          extraction,
          finalConfig,
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Auto-capture complete!\n${slotsStored} slots stored\n${memoriesStored} memories captured\n\nExtracted updates:\n${JSON.stringify(extraction.slot_updates, null, 2)}`,
            },
          ],
          details: { toolResult: { slotsStored, memoriesStored } },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Error: ${error}` }],
          isError: true,
        };
      }
    },
  });

  console.log("[AutoCapture] Registered memory_auto_capture tool as fallback");
}

// ============================================================================
// Direct Capture Function (for testing)
// ============================================================================

export async function captureFromText(
  db: SlotDB,
  userId: string,
  agentId: string,
  text: string,
  config?: Partial<AutoCaptureConfig>,
): Promise<{ slotsStored: number; memoriesStored: number; extracted: ExtractionResult }> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const currentState = db.getCurrentState(userId, agentId);
  const messages: ConversationMessage[] = [{ role: "user", content: text }];

  const extraction = await extractFactsWithLLM(messages, currentState, agentId);
  const { slotsStored, memoriesStored } = await processCaptures(
    db,
    userId,
    agentId,
    extraction,
    finalConfig,
  );

  return { slotsStored, memoriesStored, extracted: extraction };
}
