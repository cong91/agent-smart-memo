/**
 * Auto-Capture Module v3 - LLM Based
 *
 * Uses OpenAI Completions API compatible LLM for intelligent fact extraction
 * Default: gemini-2.5-flash via local proxy
 * Falls back to pattern matching if LLM unavailable
 */
import crypto from "crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";
import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { DeduplicationService } from "../services/dedupe.js";
import { extractWithLLM, checkLLMHealth, DistillMode } from "../services/llm-extractor.js";
import { NoiseFilter, getAutoCaptureNamespace, isTraderAgent, MemoryNamespace, normalizeUserId, isLearningContent } from "../shared/memory-config.js";

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
  summarizeEveryActions?: number;
}

const DEFAULT_CONFIG: AutoCaptureConfig = {
  enabled: true,
  minConfidence: 0.7,
  useLLM: true,
  llmBaseUrl: "http://localhost:8317/v1",
  llmApiKey: "proxypal-local",
  llmModel: "gemini-2.5-flash",
  summarizeEveryActions: 6,
};

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}


interface LivingStateSummary {
  last_actions: string[];
  current_focus: string;
  next_steps: string[];
  active_context?: string;
  timestamp?: number;
  ttl?: number;
}

interface SessionSummaryValue {
  summary: string;
  key_decisions: string[];
  outcomes: string[];
  ttl: number;
  timestamp: number;
}

function trimLine(s: string, max = 180): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function inferCurrentFocus(lines: string[]): string {
  const joined = lines.join(" ").toLowerCase();

  const focusPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /\b(test|fix|bug|error|debug)\b/, label: "Fixing/testing implementation details" },
    { re: /\b(refactor|cleanup|optimi[sz]e)\b/, label: "Refactoring and improving code quality" },
    { re: /\b(implement|th[êe]m|t[ií]ch h[ợo]p|x[aâ]y d[ựu]ng)\b/, label: "Implementing requested feature changes" },
    { re: /\b(prompt|inject|system prompt|before_agent_start)\b/, label: "Updating prompt injection and session context" },
    { re: /\b(slot|memory|project_living_state)\b/, label: "Maintaining SlotDB project living state" },
  ];

  for (const p of focusPatterns) {
    if (p.re.test(joined)) return p.label;
  }

  return "Working on current user-requested task";
}

function inferNextSteps(lines: string[], currentFocus: string): string[] {
  const lower = lines.map((l) => l.toLowerCase());
  const next: string[] = [];

  const hasTest = lower.some((l) => /\btest|spec|verify|assert\b/.test(l));
  const hasBuild = lower.some((l) => /\bbuild|compile|tsc\b/.test(l));
  const hasHook = lower.some((l) => /\bhook|auto-capture|auto-recall|before_agent_start\b/.test(l));

  if (hasHook) next.push("Validate hook flow end-to-end with realistic session events");
  if (hasBuild) next.push("Re-run build to ensure no TypeScript/runtime regressions");
  if (hasTest) next.push("Run and review targeted tests for auto-capture and recall behavior");

  if (next.length === 0) {
    next.push(`Continue: ${currentFocus}`);
    next.push("Verify outputs in SlotDB and injected system prompt context");
  }

  return next.slice(0, 3);
}

function summarizeProjectLivingState(messages: ConversationMessage[]): LivingStateSummary {
  const actionable = messages
    .filter((m) => m.role === "assistant" || m.role === "user")
    .map((m) => extractMessageText(m.content))
    .flatMap((txt) => txt.split("\n"))
    .map((l) => trimLine(l))
    .filter((l) => l.length > 0)
    .filter((l) => !/^NO_REPLY$/i.test(l))
    .filter((l) => !/^HEARTBEAT_OK$/i.test(l))
    .filter((l) => !/^\[Tool/i.test(l))
    .slice(-16);

  const lastActions = actionable.slice(-5);
  const currentFocus = inferCurrentFocus(actionable);
  const nextSteps = inferNextSteps(actionable, currentFocus);

  return {
    last_actions: lastActions,
    current_focus: currentFocus,
    next_steps: nextSteps,
  };
}

const SHORT_TERM_TTL_MS = 48 * 3600 * 1000;
const MID_TERM_TTL_MS = 30 * 24 * 3600 * 1000;
const ONE_DAY_MS = 24 * 3600 * 1000;

function toExpiryIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function getDateKey(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

function getYesterdayDateKey(): string {
  return getDateKey(new Date(Date.now() - ONE_DAY_MS));
}

function isExpired(value: any): boolean {
  if (!value || typeof value !== "object") return true;
  const ts = typeof value.timestamp === "number" ? value.timestamp : 0;
  const ttl = typeof value.ttl === "number" ? value.ttl : 0;
  if (!ts || !ttl) return true;
  return Date.now() > ts + ttl;
}

function detectImportantPattern(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  const keywords = [
    "hack",
    "exploit",
    "drawdown",
    "root cause",
    "regulation",
    "sec",
    "etf",
    "delist",
    "breakout",
    "black swan",
    "critical",
    "incident",
  ];
  return keywords.some((k) => normalized.includes(k));
}

function extractDecisions(messages: ConversationMessage[]): string[] {
  return messages
    .map((m) => extractMessageText(m.content))
    .flatMap((txt) => txt.split("\n"))
    .map((line) => trimLine(line))
    .filter((line) => /(quyết định|chốt|decide|approved|approve|selected)/i.test(line))
    .slice(-5);
}

function extractOutcomes(messages: ConversationMessage[]): string[] {
  return messages
    .map((m) => extractMessageText(m.content))
    .flatMap((txt) => txt.split("\n"))
    .map((line) => trimLine(line))
    .filter((line) => /(done|xong|completed|passed|failed|deployed|delivered)/i.test(line))
    .slice(-5);
}

function buildDaySummary(messages: ConversationMessage[]): string {
  const lines = messages
    .map((m) => extractMessageText(m.content))
    .flatMap((txt) => txt.split("\n"))
    .map((line) => trimLine(line, 220))
    .filter((line) => line.length > 0)
    .slice(-12);

  return lines.join("\n");
}

function formatMemoryContext(livingState: any, recentSummary: any, vectorResults: Array<{ text: string }> = []): string {
  const blocks: string[] = [];

  if (livingState) {
    blocks.push(`SHORT_TERM: ${JSON.stringify(livingState)}`);
  }

  if (recentSummary) {
    blocks.push(`MID_TERM: ${JSON.stringify(recentSummary)}`);
  }

  if (vectorResults.length > 0) {
    blocks.push(`LONG_TERM: ${vectorResults.map((v) => v.text).join(" | ")}`);
  }

  return blocks.join("\n");
}

/**
 * Auto-recall helper: short-term -> mid-term -> long-term fallback
 */
export async function injectMemoryContext(
  agentId: string,
  deps: { db: SlotDB; qdrant: QdrantClient; embedding: EmbeddingClient; userId: string; query?: string }
): Promise<string> {
  const { db, qdrant, embedding, userId, query } = deps;

  const living = db.get(userId, agentId, { key: "project_living_state" });
  const livingState = living && !Array.isArray(living) ? living.value : null;

  let recentSummary: any = null;
  const vectorResults: Array<{ text: string }> = [];

  if (!livingState || isExpired(livingState)) {
    const yesterday = getYesterdayDateKey();
    const mid = db.get(userId, agentId, { key: `session.${yesterday}.summary` });
    recentSummary = mid && !Array.isArray(mid) ? mid.value : null;

    if (!recentSummary && query && query.trim().length > 0) {
      try {
        const vector = await embedding.embed(query);
        const results = await qdrant.search(vector, 5, {
          must: [{ key: "namespace", match: { value: "session_summaries" } }],
        });
        for (const r of results) {
          if (r.payload?.text) {
            vectorResults.push({ text: String(r.payload.text) });
          }
        }
      } catch (error: any) {
        console.error("[AutoCapture] injectMemoryContext semantic fallback error:", error.message);
      }
    }
  }

  return formatMemoryContext(livingState, recentSummary, vectorResults);
}

/**
 * Infer distill mode based on agent type and content
 */
function inferDistillMode(agentId: string, text: string): DistillMode {
  // Trader agent → market signals
  if (isTraderAgent(agentId)) {
    return "market_signal";
  }

  // Learning content → principles
  if (isLearningContent(text)) {
    return "principles";
  }

  // Scrum/Fullstack/Creator → requirements (technical constraints)
  if (["scrum", "fullstack", "creator"].includes(agentId)) {
    return "requirements";
  }

  // Default
  return "general";
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
 * PROJECT CONTEXT PATTERNS (TASK-4)
 * Detects configuration, deployment, and environment-related content
 */
const PROJECT_CONTEXT_PATTERNS: RegExp[] = [
  /\b(đã config|đã chốt|rule mới|quy định|cấu hình)\b/i,
  /\b(deploy|release|migration|rollback)\b/i,
  /\b(production|staging|environment)\b/i,
  /\b(API key|endpoint|port|host|database)\b/i,
];

/**
 * Check if content contains project context patterns
 * Used to route configuration/deployment content to project_context namespace
 */
function isProjectContextContent(text: string): boolean {
  return PROJECT_CONTEXT_PATTERNS.some(p => p.test(text));
}

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
  distillMode: DistillMode = "general",
): Promise<{ slot_updates: any[]; slot_removals: any[]; memories: any[] }> {
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
      return extractWithLLM(text, currentSlots, llmConfig, distillMode);
    }
    console.log("[AutoCapture] LLM unavailable, using pattern fallback");
  }

  // Fallback to pattern matching
  return extractWithPatterns(text);
}

/**
 * Pattern-based extraction (fallback)
 */
function extractWithPatterns(text: string): { slot_updates: any[]; slot_removals: any[]; memories: any[] } {
  const result: { slot_updates: any[]; slot_removals: any[]; memories: any[] } = {
    slot_updates: [],
    slot_removals: [],
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



async function embedWithMetadataCompat(
  embedding: any,
  text: string,
): Promise<{ vector: number[]; metadata: Record<string, any> }> {
  if (embedding && typeof embedding.embedDetailed === "function") {
    return embedding.embedDetailed(text);
  }

  const vector = await embedding.embed(text);
  return {
    vector,
    metadata: {
      embedding_chunked: false,
      embedding_chunks_count: 1,
      embedding_chunking_strategy: "array_batch_weighted_avg",
      embedding_model: "unknown",
      embedding_max_tokens: 0,
      embedding_safe_chunk_tokens: 0,
    },
  };
}

async function storeSemanticMemory(
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  text: string,
  namespace: string,
  payloadExtras: Record<string, unknown> = {},
): Promise<void> {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText) {
    console.warn(`[AutoCapture] Skip semantic memory upsert: empty text (namespace=${namespace})`);
    return;
  }

  const embeddingResult = await embedWithMetadataCompat(embedding as any, normalizedText);
  const vector = embeddingResult.vector;
  await qdrant.upsert([
    {
      id: crypto.randomUUID(),
      vector,
      payload: {
        text: normalizedText,
        namespace,
        ...embeddingResult.metadata,
        metadata: {
          ...((payloadExtras as any)?.metadata || {}),
          ...embeddingResult.metadata,
        },
        timestamp: Date.now(),
        ...payloadExtras,
      },
    },
  ]);
}

export function captureShortTermState(
  db: SlotDB,
  userId: string,
  agentId: string,
  messages: ConversationMessage[],
  activeContext: string,
  actionsSinceLastCapture: number,
): boolean {
  if (actionsSinceLastCapture < 3) return false;

  const summary = summarizeProjectLivingState(messages);
  const shortTermValue: LivingStateSummary = {
    last_actions: summary.last_actions.slice(-5),
    current_focus: summary.current_focus,
    next_steps: summary.next_steps.slice(0, 3),
    active_context: activeContext,
    timestamp: Date.now(),
    ttl: SHORT_TERM_TTL_MS,
  };

  db.set(userId, agentId, {
    key: "project_living_state",
    value: shortTermValue,
    category: "project",
    source: "auto_capture",
    confidence: 0.85,
    expires_at: toExpiryIso(SHORT_TERM_TTL_MS),
  });

  return true;
}

export async function captureMidTermSummary(
  db: SlotDB,
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  input: {
    userId: string;
    agentId: string;
    sessionKey: string;
    messages: ConversationMessage[];
    sessionEnding?: boolean;
    lastMidTermCaptureAt?: number;
    now?: number;
  }
): Promise<{ stored: boolean; capturedAt: number }> {
  const now = input.now ?? Date.now();
  const lastCaptured = input.lastMidTermCaptureAt ?? 0;
  const shouldCreateMidTermSummary = Boolean(input.sessionEnding) || now - lastCaptured >= ONE_DAY_MS;

  if (!shouldCreateMidTermSummary) {
    return { stored: false, capturedAt: lastCaptured };
  }

  const dateKey = getDateKey(new Date(now));
  const daySummary = buildDaySummary(input.messages);
  const extractedDecisions = extractDecisions(input.messages);
  const trackedOutcomes = extractOutcomes(input.messages);
  const sessionSummary: SessionSummaryValue = {
    summary: daySummary,
    key_decisions: extractedDecisions,
    outcomes: trackedOutcomes,
    ttl: MID_TERM_TTL_MS,
    timestamp: now,
  };

  db.set(input.userId, input.agentId, {
    key: `session.${dateKey}.summary`,
    value: sessionSummary,
    category: "custom",
    source: "auto_capture",
    confidence: 0.9,
    expires_at: new Date(now + MID_TERM_TTL_MS).toISOString(),
  });

  await storeSemanticMemory(qdrant, embedding, daySummary, "session_summaries", {
    date: dateKey,
    session_id: input.sessionKey,
    source_agent: input.agentId,
    source_type: "auto_capture",
    userId: input.userId,
    metadata: {
      date: dateKey,
      session_id: input.sessionKey,
    },
  });

  return { stored: true, capturedAt: now };
}

export async function captureLongTermPattern(
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  input: { text: string; agentId: string; userId: string }
): Promise<boolean> {
  if (!detectImportantPattern(input.text)) {
    return false;
  }

  await storeSemanticMemory(qdrant, embedding, input.text, "market_patterns", {
    entity_type: "principle",
    source_agent: input.agentId,
    source_type: "auto_capture",
    userId: input.userId,
  });

  return true;
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

  // Auto-summarize counters (per process lifecycle)
  let actionCounter = 0;
  let actionsSinceLastCapture = 0;
  let lastMidTermCaptureAt = Date.now();
  const summarizeEvery = Math.max(1, cfg.summarizeEveryActions ?? 6);


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
        const userId = normalizeUserId(sessionKey.split(":").slice(2).join(":") || "default");

        const messages = [{ role: "user" as const, content: params.text }];
        const currentState = db.getCurrentState(userId, agentId);

        // Pass use_llm param to override config
        const distillMode = inferDistillMode(agentId, params.text);
        const extracted = await extractFacts(messages, currentState, cfg, params.use_llm, distillMode);

        // Process slot removals first (manual tool parity with hook behavior)
        let slotsRemoved = 0;
        if (extracted.slot_removals && extracted.slot_removals.length > 0) {
          for (const removal of extracted.slot_removals) {
            try {
              const deleted = db.delete(userId, agentId, removal.key);
              if (deleted) slotsRemoved++;
            } catch (e) {
              console.error("[AutoCapture] Failed to remove slot:", e);
            }
          }
        }

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
            text: `✅ Extraction complete!\nMethod: ${params.use_llm !== false ? "LLM" : "Pattern"}\nSlots stored: ${slotsStored}\nSlots removed: ${slotsRemoved}\n\nExtracted:\n${JSON.stringify(extracted, null, 2)}`,
          }],
          details: { extracted, slotsStored, slotsRemoved },
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
      const typedCtx = ctx as { sessionKey?: string; channel?: string; messageChannel?: string };
      
      const sessionKey = typedCtx?.sessionKey ?? "agent:main:default";
      const agentId = sessionKey.split(":")[1] || "main";
      const userId = normalizeUserId(sessionKey.split(":").slice(2).join(":") || "default");
      
      // HEARTBEAT SKIP: heartbeat triggers agent_end but re-scans same old messages → wastes LLM tokens
      // agent_end ctx passes messageProvider (not messageChannel) — for heartbeat runs it equals "heartbeat"
      const messageProvider = (typedCtx as any)?.messageProvider || "";
      if (messageProvider === "heartbeat") {
        console.log(`[AutoCapture] Skipping: heartbeat channel (no new user content to capture)`);
        return;
      }
      
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
      
      // Use a wider window than just last 4 messages so model can see
      // transition language like "đã xong", "move to phase X", etc.
      // extractFacts() will still enforce token budget.
      const captureWindowMessages = messages.slice(-12);

      // Hash content để detect duplicate
      const turnText = captureWindowMessages
        .map((m: any) => `${m.role}: ${extractMessageText(m.content)}`)
        .join("\n");

      // Skip empty/noise turns: NO_REPLY, HEARTBEAT_OK, tool-only responses
      const trimmedText = turnText.replace(/^(user|assistant|system):\s*/gm, '').trim();
      const noisePatterns = [
        /^NO_REPLY$/i,
        /^HEARTBEAT_OK$/i,
        /^\[Tool:/,
        /^\{"type":"toolCall"/,
        /^$/,
      ];
      const meaningfulLines = trimmedText.split('\n').filter(line => {
        const l = line.trim();
        return l.length > 0 && !noisePatterns.some(p => p.test(l));
      });
      if (meaningfulLines.length === 0) {
        console.log(`[AutoCapture] Skipping: no meaningful content (NO_REPLY/HEARTBEAT_OK/tool-only)`);
        return;
      }

      const contentHash = crypto.createHash('sha256').update(turnText).digest('hex').slice(0, 16);

      // Check hash từ SlotDB (persist qua restart)
      const hashKey = '_autocapture_hash';
      const existingSlot = db.get(userId, agentId, { key: hashKey });
      const existingHash = Array.isArray(existingSlot) ? undefined : existingSlot?.value;

      if (existingHash === contentHash) {
        console.log(`[AutoCapture] Skipping: content hash unchanged (${contentHash})`);
        return;
      }

      console.log(`[AutoCapture] New content detected (hash: ${String(existingHash)?.slice(0,8)}→${contentHash.slice(0,8)})`);
      
      // Combine all message text for noise detection and namespace routing
      const fullText = captureWindowMessages
        .map((m: any) => extractMessageText(m.content))
        .join(" ");
      
      // V2 NAMESPACE ROUTING LOGIC
      let targetNamespace: MemoryNamespace = getAutoCaptureNamespace(agentId, fullText);
      
      // PRIORITY 1: Learning content gets special routing - NEVER filtered as noise
      if (isLearningContent(fullText)) {
        targetNamespace = "agent_learnings" as MemoryNamespace;
        console.log(`[AutoCapture] Learning content detected → routing to agent_learnings`);
      }
      // PRIORITY 2: Project context detection for scrum/fullstack/creator agents
      else if (isProjectContextContent(fullText) && ["scrum", "fullstack", "creator"].includes(agentId)) {
        targetNamespace = "project_context" as MemoryNamespace;
        console.log(`[AutoCapture] Project context detected → routing to project_context`);
      }
      
      // Check if content should be skipped (noise filter) - but learning content bypasses this
      if (!isLearningContent(fullText) && noiseFilter.shouldSkip(fullText)) {
        if (isTraderAgent(agentId)) {
          console.log(`[AutoCapture] Skipping trading content for trader agent - use memory_store tool to save trading data`);
        } else {
          console.log(`[AutoCapture] Skipping: content matches noise patterns`);
        }
        return;
      }
      
      console.log(`[AutoCapture] Processing ${captureWindowMessages.length} recent messages for ${agentId} (namespace: ${targetNamespace})`);
      
      const currentState = db.getCurrentState(userId, agentId);
      const distillMode = inferDistillMode(agentId, fullText);
      console.log(`[AutoCapture] Distill mode: ${distillMode} (agent: ${agentId})`);
      const extracted = await extractFacts(captureWindowMessages, currentState, cfg, undefined, distillMode);
      
      // Process slot REMOVALS first (invalidation)
      let slotsRemoved = 0;
      if (extracted.slot_removals && extracted.slot_removals.length > 0) {
        for (const removal of extracted.slot_removals) {
          try {
            const deleted = db.delete(userId, agentId, removal.key);
            if (deleted) {
              slotsRemoved++;
              console.log(`[AutoCapture] Removed stale slot: ${removal.key} (reason: ${removal.reason})`);
            }
          } catch (e) {
            console.error("[AutoCapture] Failed to remove slot:", e);
          }
        }
      }
      
      // Store slots
      let slotsStored = 0;
      
      // Save hash to SlotDB for next comparison
      db.set(userId, agentId, {
        key: hashKey,
        value: contentHash,
        category: "custom",
        source: "auto_capture",
        confidence: 1.0,
      });
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
            let embeddingMeta: Record<string, any> = {};
            try {
              const embeddingResult = await embedWithMetadataCompat(embedding as any, text);
              vector = embeddingResult.vector;
              embeddingMeta = embeddingResult.metadata;
              console.log(`[AutoCapture] Embedding generated, vector length: ${vector.length}, chunks=${embeddingResult.metadata.embedding_chunks_count}`);
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
                    ...embeddingMeta,
                    metadata: {
                      ...embeddingMeta,
                    },
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
                    ...embeddingMeta,
                    metadata: {
                      ...embeddingMeta,
                    },
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
      
      // Auto-summarize project living state after every N actions OR task transition
      actionCounter += 1;
      actionsSinceLastCapture += 1;
      const transitionKeys = new Set([
        "project.current",
        "project.current_task",
        "project.current_epic",
        "project.phase",
        "project.status",
      ]);
      const hasTaskTransition =
        extracted.slot_updates.some((s: any) => transitionKeys.has(s.key)) ||
        extracted.slot_removals.some((s: any) => transitionKeys.has(s.key));
      const shouldSummarize = actionCounter % summarizeEvery === 0 || hasTaskTransition;

      if (shouldSummarize || actionsSinceLastCapture >= 3) {
        try {
          const stored = captureShortTermState(
            db,
            userId,
            agentId,
            captureWindowMessages,
            fullText,
            actionsSinceLastCapture,
          );
          if (stored) {
            actionsSinceLastCapture = 0;
            console.log(
              `[AutoCapture] Updated slot: project_living_state (${hasTaskTransition ? "task transition" : `every ${summarizeEvery} actions`})`
            );
          }
        } catch (summaryError) {
          console.error("[AutoCapture] Failed to update project_living_state:", summaryError);
        }
      }

      const now = Date.now();
      const sessionEnding = Boolean((typedEvent?.metadata as any)?.sessionEnding);

      try {
        const midTerm = await captureMidTermSummary(db, qdrant, embedding, {
          userId,
          agentId,
          sessionKey,
          messages,
          sessionEnding,
          lastMidTermCaptureAt,
          now,
        });
        if (midTerm.stored) {
          lastMidTermCaptureAt = midTerm.capturedAt;
          console.log(`[AutoCapture] Stored mid-term session summary for ${getDateKey(new Date(midTerm.capturedAt))}`);
        }
      } catch (midTermError) {
        console.error("[AutoCapture] Failed to create mid-term session summary:", midTermError);
      }

      try {
        const storedPattern = await captureLongTermPattern(qdrant, embedding, {
          text: fullText,
          agentId,
          userId,
        });
        if (storedPattern) {
          console.log("[AutoCapture] Stored long-term market pattern");
        }
      } catch (patternError) {
        console.error("[AutoCapture] Failed to store long-term pattern:", patternError);
      }

      if (slotsStored > 0 || memoriesStored > 0 || slotsRemoved > 0) {
        console.log(`[AutoCapture] Complete: ${slotsStored} stored, ${slotsRemoved} removed, ${memoriesStored} memories`);
      }
    } catch (error) {
      console.error("[AutoCapture] Hook error:", error);
    } finally {
      // Always release the lock to prevent deadlocks
      isCapturing = false;
    }
  });
}
