/**
 * Ollama LLM Extractor for Auto-Capture
 * Uses local deepseek-r1:8b model for intelligent fact extraction
 */

import type { SlotDB } from "../db/slot-db.js";

interface OllamaConfig {
  ollamaHost: string;
  ollamaPort: number;
  ollamaModel: string;
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
    namespace: string;
    confidence: number;
  }>;
}

/**
 * Extract facts using Ollama LLM
 */
export async function extractWithOllama(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>,
  config: OllamaConfig
): Promise<ExtractionResult> {
  const prompt = buildExtractionPrompt(conversation, currentSlots);
  const baseUrl = `${config.ollamaHost}:${config.ollamaPort}`;
  
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt: prompt,
        stream: false,
        format: "json",
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.response);
    
    // Validate and normalize
    return {
      slot_updates: (result.slot_updates || []).filter((s: any) => s.confidence >= 0.7),
      memories: (result.memories || []).filter((m: any) => m.confidence >= 0.7),
    };
  } catch (error) {
    console.error("[OllamaExtractor] Error:", error);
    return { slot_updates: [], memories: [] };
  }
}

function buildExtractionPrompt(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>
): string {
  return `You are an intelligent memory extractor. Analyze the conversation and extract important facts about the user.

Current known facts:
${JSON.stringify(currentSlots, null, 2)}

New conversation:
"""${conversation}"""

Extract ANY new information about:
1. User's name, location, timezone, preferences
2. Current project, tech stack, deadlines
3. Important facts to remember

Return ONLY valid JSON in this exact format:
{
  "slot_updates": [
    {"key": "profile.name", "value": "extracted name", "confidence": 0.95, "category": "profile"},
    {"key": "profile.location", "value": "extracted location", "confidence": 0.85, "category": "profile"},
    {"key": "project.current", "value": "project name", "confidence": 0.9, "category": "project"},
    {"key": "preferences.theme", "value": "dark", "confidence": 0.88, "category": "preferences"}
  ],
  "memories": [
    {"text": "Important fact to remember", "namespace": "assistant", "confidence": 0.85}
  ]
}

Use confidence scores:
- 0.9-1.0: Explicitly stated, very clear
- 0.8-0.9: Likely correct, context supports
- 0.7-0.8: Possible, but uncertain
- Below 0.7: Skip (will be filtered out)

Available categories: profile, preferences, project, environment, custom
Available namespaces: assistant, scrum, fullstack, creator, team

If no new facts found, return empty arrays. Return ONLY the JSON, no other text.`;
}

/**
 * Health check for Ollama
 */
export async function checkOllamaHealth(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`${host}:${port}/api/tags`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}
