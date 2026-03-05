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

export type DistillMode = "principles" | "requirements" | "market_signal" | "general";

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
  config: LLMConfig,
  distillMode: DistillMode = "general"
): Promise<ExtractionResult> {
  const systemInstruction = buildSystemInstruction(distillMode);
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

function buildSystemInstruction(distillMode: DistillMode = "general"): string {
  return `You are a memory extraction assistant. Analyze conversations and extract/update/invalidate facts.

LANGUAGE RULE (PRIORITY):
- Prefer Vietnamese output when conversation contains Vietnamese or Vietnam-context operational commands.
- For mixed-language conversations, output memories/slot values in the dominant operational language; prioritize Vietnamese if ambiguous.
- Keep original technical tokens (endpoints, code symbols, config keys) unchanged.
- Do NOT normalize Vietnamese content into English.

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
NAMESPACES: agent.<agent>.working_memory | agent.<agent>.lessons | agent.<agent>.decisions | shared.project_context | shared.rules_slotdb | shared.runbooks | noise.filtered

CONFIDENCE: 0.9-1.0 explicit, 0.8-0.9 strongly implied, 0.7-0.8 inferred. Below 0.7: skip.

DO NOT extract:
- raw tool transcripts (exec/read/edit output), command logs, stack traces, file listings, HTTP payload dumps
- routine greetings, insults, pure emotional reactions without decision impact
- duplicate restatements of already-stored facts

CONTEXT EXTRACTION PRIORITY (highest -> lowest):
1) explicit decisions/approvals/rejections
2) constraints/rules/non-negotiables
3) configuration/runtime changes with concrete values
4) task ownership, status transitions, blockers, ETAs
5) risk/guard adjustments and rollout/rollback conditions

CONTEXT QUALITY RULES:
- If a statement only makes sense with nearby messages, rewrite as self-contained memory with the missing context included.
- Prefer "because" clauses and trigger-condition clauses in memories (why + when it applies).
- Keep causal links: "A changed -> B failed -> action C".
- If conflicting statements exist in the same window, keep the latest and invalidate the stale slot.

RESPONSE FORMAT (JSON only):
{
  "slot_updates": [{"key": "project.current_task", "value": "new task", "confidence": 0.9, "category": "project"}],
  "slot_removals": [{"key": "project.current_task", "reason": "Task completed per conversation"}],
  "memories": [{"text": "fact description", "namespace": "shared.project_context", "confidence": 0.85}]
}

DISTILL RULES (CRITICAL - apply to ALL outputs):
- DISTILL, never summarize. Remove decoration/noise; keep decision-grade core.
- memories[].text MUST be self-contained and operationally useful in isolation.
- memory format target: "Context -> Decision/Rule -> Condition/Scope" in 1-2 sentences.
- Preserve critical numbers, thresholds, symbols, time windows, and environment scope (prod/staging, mode paper/live).
- If content is mostly noise, return no memory instead of weak memory.
- slot_updates[].value: concise, actionable. Not "anh Công muốn backup trước khi sửa" -> "Rule: PHẢI backup config trước khi sửa openclaw.json"

MODE-SPECIFIC DISTILL:
${getDistillDirective(distillMode)}

Return empty arrays if nothing to extract/remove. Quality over quantity.`;
}

function getDistillDirective(mode: DistillMode): string {
  switch (mode) {
    case "principles":
      return [
        "Extract invariant principles only.",
        "Each memory: one principle in atomic form.",
        "No examples, no anecdotes, no story.",
      ].join("\n");
    case "requirements":
      return [
        "Extract non-negotiable requirements and constraints.",
        "Use implementable constraint wording.",
        "Prefer measurable/observable constraints.",
      ].join("\n");
    case "market_signal":
      return [
        "Extract tradable market signals only.",
        "Keep directional signal, risk level, trigger/action.",
        "No macro storytelling, no generic education.",
      ].join("\n");
    case "general":
    default:
      return [
        "Extract decision-grade facts and rules.",
        "Keep technical details, configurations, constraints.",
        "Remove conversational noise and pleasantries.",
      ].join("\n");
  }
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
1. Extract NEW facts from conversation with context preservation.
2. Check currentSlots and mark any OUTDATED/COMPLETED items in slot_removals.
3. Audit volatile project keys: project.current, project.current_task, project.current_epic, project.phase, project.status.
4. If a slot value should be UPDATED (not just removed), put new value in slot_updates.
5. For each memory, include WHY/CONDITION when available (not just WHAT).
6. Reject noisy/tool-dump content aggressively; quality over quantity.
7. Return JSON only.`;
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
