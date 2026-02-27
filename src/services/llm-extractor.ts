/**
 * LLM Extractor for Auto-Capture v2
 * With slot invalidation support
 */

import type { SlotDB } from "../db/slot-db.js";
import type { MemoryNamespace } from "../shared/memory-config.js";

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ExtractionResult {
  slot_updates: Array<{
    key: string;
    value: any;
    confidence: number;
    category: string;
  }>;
  slot_removals: Array<{
    key: string;
    reason: string;
  }>;
  memories: Array<{
    text: string;
    namespace: MemoryNamespace;
    confidence: number;
  }>;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string; role: string };
    finish_reason: string;
    index: number;
  }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const EMPTY_RESULT: ExtractionResult = { slot_updates: [], slot_removals: [], memories: [] };

/**
 * Extract facts using LLM via OpenAI Completions API
 */
export async function extractWithLLM(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>,
  config: LLMConfig
): Promise<ExtractionResult> {
  const systemInstruction = buildSystemInstruction();
  const userPrompt = buildUserPrompt(conversation, currentSlots);
  
  const totalPromptChars = systemInstruction.length + userPrompt.length;
  console.log(`[LLMExtractor] Prompt size: ${totalPromptChars} chars`);
  
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
    const responseText = data.choices?.[0]?.message?.content;
    
    if (!responseText) {
      console.error("[LLMExtractor] No content in response");
      return EMPTY_RESULT;
    }
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[LLMExtractor] No JSON found in response");
      return EMPTY_RESULT;
    }
    
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseError: any) {
      console.error("[LLMExtractor] JSON parse error:", parseError.message);
      return EMPTY_RESULT;
    }
    
    const slotUpdates = (result.slot_updates || []).filter((s: any) => s.confidence >= 0.7);
    const slotRemovals = result.slot_removals || [];
    const memories = (result.memories || []).filter((m: any) => m.confidence >= 0.7);
    
    console.log(`[LLMExtractor] Extracted ${slotUpdates.length} updates, ${slotRemovals.length} removals, ${memories.length} memories`);
    
    return { slot_updates: slotUpdates, slot_removals: slotRemovals, memories: memories };
  } catch (error) {
    console.error("[LLMExtractor] Error:", error);
    return EMPTY_RESULT;
  }
}

function buildSystemInstruction(): string {
  return `You are a memory extraction assistant. Analyze conversations and extract/update/invalidate facts.

LANGUAGE RULE: Extract in the SAME language as the input. Do NOT translate.

YOUR 3 JOBS:
1. EXTRACT new facts → slot_updates
2. INVALIDATE outdated slots → slot_removals (CRITICAL - check currentSlots for stale data!)
3. CAPTURE important context → memories

SLOT INVALIDATION (NEW - MOST IMPORTANT):
- Review currentSlots carefully. If conversation shows a task/phase is COMPLETED or CHANGED, add it to slot_removals.
- Treat these keys as VOLATILE status keys and actively invalidate them when stale:
  project.current, project.current_task, project.current_epic, project.phase, project.status
- Trigger invalidation on phrases like: "đã xong", "đã hoàn thành", "done", "completed", "finished", "move to", "moved to", "next phase".
- Examples of stale data to remove:
  + project.current_task says "working on X" but conversation shows X is done
  + project.current_epic says "Phase 10" but team moved to Phase 11
  + project.phase says "10" but conversation says current phase is 11
  + environment.current_time from yesterday
  + Any slot that CONTRADICTS current conversation
- IMPORTANT: when phase/task changes, prefer BOTH actions: remove stale slot(s) AND add updated slot value.
- Be aggressive about removing outdated project/task status slots

CATEGORIES: profile, preferences, project, environment, custom
NAMESPACES: agent_decisions, user_profile, project_context, trading_signals

CONFIDENCE: 0.9-1.0 explicit, 0.8-0.9 strongly implied, 0.7-0.8 inferred. Below 0.7: skip.

DO NOT extract: trading data, prices, indicators, routine greetings, empty content.

RESPONSE FORMAT (JSON only):
{
  "slot_updates": [{"key": "project.current_task", "value": "new task", "confidence": 0.9, "category": "project"}],
  "slot_removals": [{"key": "project.current_task", "reason": "Task completed per conversation"}],
  "memories": [{"text": "fact description", "namespace": "project_context", "confidence": 0.85}]
}

Return empty arrays if nothing to extract/remove. Quality over quantity.`;
}

function buildUserPrompt(
  conversation: string,
  currentSlots: Record<string, Record<string, any>>
): string {
  // Only include non-empty, non-hash slots
  const filteredSlots: Record<string, Record<string, any>> = {};
  for (const [cat, slots] of Object.entries(currentSlots)) {
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(slots)) {
      if (key.startsWith('_autocapture')) continue;
      filtered[key] = value;
    }
    if (Object.keys(filtered).length > 0) {
      filteredSlots[cat] = filtered;
    }
  }

  return `CURRENT SLOTS (check for stale/outdated data):
${JSON.stringify(filteredSlots, null, 2)}

CONVERSATION TO ANALYZE:
---
${conversation}
---

Instructions:
1. Extract NEW facts from conversation
2. Check currentSlots - mark any OUTDATED/COMPLETED items in slot_removals
3. Especially audit volatile project keys: project.current, project.current_task, project.current_epic, project.phase, project.status
4. If a slot value should be UPDATED (not just removed), put new value in slot_updates
5. Return JSON only`;
}

/**
 * Health check for LLM service
 */
export async function checkLLMHealth(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
