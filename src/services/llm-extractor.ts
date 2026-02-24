/**
 * LLM Extractor for Auto-Capture
 * Uses OpenAI Completions API format with configurable provider
 * Default: gemini-3.1-pro-low via local proxy
 */

import type { SlotDB } from "../db/slot-db.js";
import type { MemoryNamespace } from "../shared/memory-config.js";

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ExtractionResult {
  slot_updates: Array<{
    key: string;
    value: any;
    confidence: number;
    category: string;
  }>;
  memories: Array<{
    text: string;
    namespace: MemoryNamespace;
    confidence: number;
  }>;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
    index: number;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Extract facts using LLM via OpenAI Completions API
 */
export async function extractWithLLM(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>,
  config: LLMConfig
): Promise<ExtractionResult> {
  const systemInstruction = buildSystemInstruction(currentSlots);
  const userPrompt = buildUserPrompt(conversation, currentSlots);
  
  // Log prompt size for debugging context length issues
  const totalPromptChars = systemInstruction.length + userPrompt.length;
  console.log(`[LLMExtractor] Prompt size: ${totalPromptChars} chars (system: ${systemInstruction.length}, user: ${userPrompt.length})`);
  
  // Log full user prompt for debugging
  console.log("[LLMExtractor] User Prompt sent to LLM:\n", userPrompt);
  
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAIChatResponse;
    
    console.log("[LLMExtractor] Raw LLM response received, model:", config.model);
    
    // Parse OpenAI response format
    const responseText = data.choices?.[0]?.message?.content;
    
    if (!responseText) {
      console.error("[LLMExtractor] No content found in response");
      console.error("[LLMExtractor] Response structure:", JSON.stringify(data, null, 2)?.substring(0, 500));
      return { slot_updates: [], memories: [] };
    }
    
    console.log("[LLMExtractor] Response length:", responseText.length);
    console.log("[LLMExtractor] Response preview:", responseText.substring(0, 200));
    
    // Try to find JSON object in the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[LLMExtractor] No JSON found in response");
      console.error("[LLMExtractor] Response content:", responseText.substring(0, 500));
      return { slot_updates: [], memories: [] };
    }
    
    console.log("[LLMExtractor] JSON match found, length:", jsonMatch[0].length);
    
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
      console.log("[LLMExtractor] JSON parsed successfully");
    } catch (parseError: any) {
      console.error("[LLMExtractor] JSON parse error:", parseError.message);
      console.error("[LLMExtractor] Response content:", jsonMatch[0].substring(0, 500));
      return { slot_updates: [], memories: [] };
    }
    
    const slotUpdates = (result.slot_updates || []).filter((s: any) => s.confidence >= 0.7);
    const memories = (result.memories || []).filter((m: any) => m.confidence >= 0.7);
    
    console.log(`[LLMExtractor] Extracted ${slotUpdates.length} slots, ${memories.length} memories`);
    
    // Validate and normalize
    return {
      slot_updates: slotUpdates,
      memories: memories,
    };
  } catch (error) {
    console.error("[LLMExtractor] Error:", error);
    return { slot_updates: [], memories: [] };
  }
}

function buildSystemInstruction(
  currentSlots: Record<string, Record<string, any>>
): string {
  return `You are a memory extraction assistant. Your task is to analyze conversations and extract facts about the user.

EXTRACTION GUIDELINES:
- Extract facts the user explicitly states or clearly implies from context
- Focus on: names, locations, preferences, project details, tech stack, deadlines, goals
- IMPORTANT: If conversation contains only routine/repetitive data with no new facts, return empty arrays
- DO NOT extract trading data, price information, order details, or technical indicator readings as memories
- If conversation is purely trading/signal data, return empty arrays

NAMESPACES:
Memories can be stored in one of these 4 namespaces:
1. "agent_decisions" - General decisions, knowledge, and facts from conversations (default for most agents)
2. "user_profile" - User personal information (names, preferences, contact info) - for assistant and creator agents
3. "project_context" - Project details, code, tasks, tech stack - for scrum, fullstack, creator agents
4. "trading_signals" - Trading data, signals, positions - ONLY for trader agent (use memory_store tool manually)

For auto-capture, choose the appropriate namespace based on content type and agent role.

CONFIDENCE SCORING:
- 0.9-1.0: Explicitly stated (e.g., "My name is John")
- 0.8-0.9: Strongly implied by context
- 0.7-0.8: Reasonable inference from conversation
- Below 0.7: Do not include

RESPONSE FORMAT:
Return ONLY a valid JSON object with this structure:
{
  "slot_updates": [
    {"key": "profile.name", "value": "extracted value", "confidence": 0.9, "category": "profile"}
  ],
  "memories": [
    {"text": "description of fact", "namespace": "agent_decisions", "confidence": 0.85}
  ]
}

Available categories: profile, preferences, project, environment, custom

IMPORTANT: Memories MUST include the appropriate namespace field from the 4 namespaces listed above.
- DO NOT extract trading data, price information, order details, or technical indicator readings as memories
- DO NOT use "default" as namespace - use one of the 4 valid namespaces

EXAMPLE 1 - Explicit facts:
Input: "My name is Sarah and I work on the backend team. I prefer dark theme."
Output:
{
  "slot_updates": [
    {"key": "profile.name", "value": "Sarah", "confidence": 0.95, "category": "profile"},
    {"key": "profile.team", "value": "backend", "confidence": 0.9, "category": "profile"},
    {"key": "preferences.theme", "value": "dark", "confidence": 0.9, "category": "preferences"}
  ],
  "memories": []
}

EXAMPLE 2 - Implicit/conversational:
Input: "I've been struggling with the deployment pipeline all morning. Docker keeps timing out."
Output:
{
  "slot_updates": [],
  "memories": [
    {"text": "User is experiencing Docker timeout issues with deployment pipeline", "namespace": "project_context", "confidence": 0.85}
  ]
}

EXAMPLE 3 - Trading data (return empty - do NOT extract):
Input: "BUY BTC @ 45000, TP 48000, SL 42000. RSI showing bullish divergence."
Output:
{
  "slot_updates": [],
  "memories": []
}

EXAMPLE 4 - User profile for assistant:
Input: "I live in Ho Chi Minh City and I usually wake up at 7 AM."
Output:
{
  "slot_updates": [],
  "memories": [
    {"text": "User lives in Ho Chi Minh City", "namespace": "user_profile", "confidence": 0.9},
    {"text": "User usually wakes up at 7 AM", "namespace": "user_profile", "confidence": 0.85}
  ]
}

EXAMPLE 5 - No meaningful facts:
Input: "Hello, how are you today?"
Output:
{
  "slot_updates": [],
  "memories": []
}

REMEMBER: It's OK to return empty arrays if there's nothing meaningful to extract. Quality over quantity.`;
}

function buildUserPrompt(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>
): string {
  return `Current known facts about the user:
${JSON.stringify(currentSlots, null, 2)}

Please analyze this conversation and extract any facts about the user:

---
${conversation}
---

Remember to:
1. Look for explicit statements AND contextually implied facts
2. Extract names, locations, preferences, projects, tech stack, deadlines
3. Use confidence scores to indicate certainty level
4. Choose the appropriate namespace: "agent_decisions", "user_profile", "project_context", or "trading_signals"
5. Return ONLY the JSON response`;
}

/**
 * Health check for LLM service
 */
export async function checkLLMHealth(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
