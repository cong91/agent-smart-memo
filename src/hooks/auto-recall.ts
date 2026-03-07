/**
 * Auto-Recall Enhancement - Task 3.4
 *
 * Automatically injects Slot Memory, Graph context, and Semantic Memories into System Prompt
 * before each agent run (OnBeforeAgentStart hook).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";
import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { getAgentNamespaces, MemoryNamespace, normalizeUserId, getNamespaceWeight } from "../shared/memory-config.js";

// Token budget for different context types
const TOKEN_BUDGETS = {
  currentState: 500,
  recentSlots: 300,
  graphContext: 400,
  semanticMemories: 600,
};

interface RecallContext {
  sessionKey: string;
  stateDir: string;
  userId: string;
  agentId: string;
}

interface RecallHintSet {
  sessionKeys: Set<string>;
  topicTags: Set<string>;
}

interface SemanticMemoryCandidate {
  text: string;
  score: number;
  namespace?: string;
  payload?: Record<string, any>;
  adjustedScore?: number;
  sameSession?: boolean;
  sameProject?: boolean;
  crossProject?: boolean;
}

interface SemanticSelectionResult {
  memories: Array<{ text: string; score: number; namespace?: string }>;
  recallConfidence: "high" | "medium" | "low";
  suppressed: boolean;
  suppressionReason?: string;
}

/**
 * Format current state as XML for system prompt injection
 */
function formatCurrentState(state: Record<string, Record<string, unknown>>): string {
  if (Object.keys(state).length === 0) return "";
  
  let xml = "<current-state>\n";
  for (const [category, slots] of Object.entries(state)) {
    xml += `  <${category}>\n`;
    for (const [key, value] of Object.entries(slots)) {
      // Skip internal keys (e.g. _autocapture_hash)
      if (key.startsWith('_')) continue;
      const displayKey = key.includes(".") ? key.split(".").slice(1).join(".") : key;
      const displayValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      // Truncate long values
      const truncated = displayValue.length > 100 ? displayValue.substring(0, 100) + "..." : displayValue;
      xml += `    <${displayKey}>${truncated}</${displayKey}>\n`;
    }
    xml += `  </${category}>\n`;
  }
  xml += "</current-state>";
  return xml;
}


function formatProjectLivingState(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const v = value as {
    last_actions?: unknown;
    current_focus?: unknown;
    next_steps?: unknown;
  };

  const lastActions = Array.isArray(v.last_actions)
    ? v.last_actions.map((x) => String(x)).slice(-5)
    : [];
  const currentFocus = typeof v.current_focus === "string" ? v.current_focus : "";
  const nextSteps = Array.isArray(v.next_steps)
    ? v.next_steps.map((x) => String(x)).slice(0, 5)
    : [];

  if (lastActions.length === 0 && !currentFocus && nextSteps.length === 0) {
    return "";
  }

  const xmlEscape = (s: string) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  let xml = "<project-living-state>\n";

  if (lastActions.length > 0) {
    xml += "  <last_actions>\n";
    lastActions.forEach((a, i) => {
      xml += `    <action index="${i + 1}">${xmlEscape(a)}</action>\n`;
    });
    xml += "  </last_actions>\n";
  }

  if (currentFocus) {
    xml += `  <current_focus>${xmlEscape(currentFocus)}</current_focus>\n`;
  }

  if (nextSteps.length > 0) {
    xml += "  <next_steps>\n";
    nextSteps.forEach((s, i) => {
      xml += `    <step index="${i + 1}">${xmlEscape(s)}</step>\n`;
    });
    xml += "  </next_steps>\n";
  }

  xml += "</project-living-state>";
  return xml;
}

/**
 * Format graph context showing related entities
 */
function formatGraphContext(
  entities: Array<{ name: string; type: string }>,
  relationships: Array<{ source: string; target: string; type: string }>,
): string {
  if (entities.length === 0) return "";
  
  let xml = "<knowledge-graph>\n";
  
  // List entities
  xml += "  <entities>\n";
  entities.slice(0, 10).forEach((e) => { // Limit to 10 entities
    xml += `    <entity name="${e.name}" type="${e.type}"/>\n`;
  });
  xml += "  </entities>\n";
  
  // List key relationships
  if (relationships.length > 0) {
    xml += "  <relationships>\n";
    relationships.slice(0, 8).forEach((r) => { // Limit to 8 relationships
      xml += `    <rel>${r.source} --[${r.type}]--> ${r.target}</rel>\n`;
    });
    xml += "  </relationships>\n";
  }
  
  xml += "</knowledge-graph>";
  return xml;
}

/**
 * Format semantic memories as XML for system prompt injection
 */
function formatSemanticMemories(memories: Array<{ text: string; score: number; namespace?: string }>): string {
  if (memories.length === 0) return "";
  
  let xml = "<semantic-memories>\n";
  memories.forEach((m, i) => {
    const nsAttr = m.namespace ? ` ns="${m.namespace}"` : "";
    xml += `  <memory index="${i + 1}" relevance="${(m.score * 100).toFixed(0)}%"${nsAttr}>${m.text}</memory>\n`;
  });
  xml += "</semantic-memories>";
  return xml;
}

function normalizeToken(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim().toLowerCase();
  return s;
}

function splitToTags(input: string): string[] {
  return input
    .split(/[\s,;|:/\\]+/g)
    .map((x) => normalizeToken(x))
    .filter((x) => x.length >= 3)
    .slice(0, 12);
}

function collectRecallHints(
  sessionKey: string,
  projectLivingStateValue: unknown,
  currentState: Record<string, Record<string, unknown>>,
): RecallHintSet {
  const hints: RecallHintSet = {
    sessionKeys: new Set<string>(),
    topicTags: new Set<string>(),
  };

  const normalizedSession = normalizeToken(sessionKey);
  if (normalizedSession) hints.sessionKeys.add(normalizedSession);

  const sessionTail = normalizeToken(sessionKey.split(":").slice(2).join(":"));
  if (sessionTail) hints.sessionKeys.add(sessionTail);

  const living = (projectLivingStateValue && typeof projectLivingStateValue === "object")
    ? (projectLivingStateValue as Record<string, unknown>)
    : null;

  if (living) {
    const activeContext = normalizeToken(living.active_context);
    if (activeContext) {
      hints.topicTags.add(activeContext);
      splitToTags(activeContext).forEach((t) => hints.topicTags.add(t));
    }

    const currentFocus = normalizeToken(living.current_focus);
    if (currentFocus) {
      splitToTags(currentFocus).forEach((t) => hints.topicTags.add(t));
    }
  }

  const projectState = currentState.project || {};
  for (const key of ["project.current", "project.current_epic", "project.current_task", "project.phase", "project.status"]) {
    const raw = projectState[key];
    const normalized = normalizeToken(raw);
    if (normalized) {
      hints.topicTags.add(normalized);
      splitToTags(normalized).forEach((t) => hints.topicTags.add(t));
    }
  }

  return hints;
}

function getSessionTokenFromPayload(payload: Record<string, any>): string {
  const direct = normalizeToken(payload.sessionId || payload.session_id || payload.thread_id || payload.threadId || payload.conversationId || payload.conversation_id);
  if (direct) return direct;

  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata as Record<string, any> : {};
  return normalizeToken(meta.sessionId || meta.session_id || meta.thread_id || meta.threadId || meta.conversationId || meta.conversation_id);
}

function collectPayloadTopicTags(payload: Record<string, any>): Set<string> {
  const tags = new Set<string>();
  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata as Record<string, any> : {};

  const rawCandidates: unknown[] = [
    payload.project,
    payload.projectTag,
    payload.project_tag,
    payload.topic,
    payload.topicTag,
    payload.topic_tag,
    meta.project,
    meta.projectTag,
    meta.project_tag,
    meta.topic,
    meta.topicTag,
    meta.topic_tag,
    payload.namespace,
  ];

  for (const raw of rawCandidates) {
    const v = normalizeToken(raw);
    if (!v) continue;
    tags.add(v);
    splitToTags(v).forEach((x) => tags.add(x));
  }

  const listCandidates: unknown[] = [payload.tags, payload.topics, meta.tags, meta.topics];
  for (const lc of listCandidates) {
    if (Array.isArray(lc)) {
      lc.forEach((item) => {
        const v = normalizeToken(item);
        if (v) {
          tags.add(v);
          splitToTags(v).forEach((x) => tags.add(x));
        }
      });
    }
  }

  return tags;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

function applyRecencyBoost(baseScore: number, payload: Record<string, any>, sameSession: boolean): number {
  const tsRaw = payload.updatedAt || payload.timestamp || payload.ts;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts <= 0) return baseScore;

  const ageMs = Math.max(0, Date.now() - ts);
  if (sameSession) {
    if (ageMs <= 60 * 60 * 1000) return baseScore + 0.12;
    if (ageMs <= 24 * 60 * 60 * 1000) return baseScore + 0.07;
    if (ageMs <= 3 * 24 * 60 * 60 * 1000) return baseScore + 0.03;
  }
  if (ageMs <= 60 * 60 * 1000) return baseScore + 0.02;
  return baseScore;
}

export function selectSemanticMemories(
  results: Array<{ score: number; payload?: Record<string, any> }>,
  ctx: RecallContext,
  hints: RecallHintSet,
): SemanticSelectionResult {
  const weighted: SemanticMemoryCandidate[] = results
    .filter((r: any) => (r.payload?.namespace || "") !== "noise.filtered")
    .map((r: any) => {
      const payload = (r.payload || {}) as Record<string, any>;
      const ns = String(payload.namespace || "");
      const baseWeighted = Math.min(1, r.score * getNamespaceWeight(ctx.agentId, ns));

      const sessionToken = getSessionTokenFromPayload(payload);
      const sameSession = sessionToken ? hints.sessionKeys.has(sessionToken) : false;

      const memoryTags = collectPayloadTopicTags(payload);
      const sameProject = intersects(hints.topicTags, memoryTags);
      const crossProject = hints.topicTags.size > 0 && memoryTags.size > 0 && !sameProject;

      let adjusted = baseWeighted;
      if (sameSession) adjusted += 0.2;
      if (sameProject) adjusted += 0.1;
      if (crossProject) adjusted -= 0.18;
      adjusted = applyRecencyBoost(adjusted, payload, sameSession);

      return {
        text: payload.text || "",
        score: baseWeighted,
        namespace: ns,
        payload,
        adjustedScore: Math.max(0, Math.min(1, adjusted)),
        sameSession,
        sameProject,
        crossProject,
      };
    })
    .filter((m) => m.text.length > 0)
    .sort((a, b) => (b.adjustedScore || 0) - (a.adjustedScore || 0));

  const kept = weighted.filter((m) => (m.adjustedScore || 0) >= 0.7).slice(0, 5);

  if (kept.length === 0) {
    return {
      memories: [],
      recallConfidence: "low",
      suppressed: true,
      suppressionReason: "no_high_relevance",
    };
  }

  const top3 = kept.slice(0, 3);
  const crossCount = top3.filter((m) => m.crossProject).length;
  const sessionCount = top3.filter((m) => m.sameSession).length;
  const projectCount = top3.filter((m) => m.sameProject).length;

  if (crossCount >= 2 && sessionCount === 0 && projectCount === 0) {
    return {
      memories: [],
      recallConfidence: "low",
      suppressed: true,
      suppressionReason: "mixed_or_cross_topic_top_hits",
    };
  }

  const recallConfidence: "high" | "medium" | "low" =
    sessionCount >= 1 || projectCount >= 2
      ? "high"
      : crossCount >= 1
        ? "medium"
        : "high";

  const cap = recallConfidence === "medium" ? 2 : 5;
  return {
    memories: kept.slice(0, cap).map((m) => ({
      text: m.text,
      score: m.adjustedScore || m.score,
      namespace: m.namespace,
    })),
    recallConfidence,
    suppressed: false,
  };
}

/**
 * Build multi-namespace filter for Qdrant search
 */
function buildNamespaceFilter(namespaces: MemoryNamespace[]): any {
  if (namespaces.length === 0) {
    return { must: [{ key: "namespace", match: { value: "shared.project_context" } }] };
  }
  
  if (namespaces.length === 1) {
    return { must: [{ key: "namespace", match: { value: namespaces[0] } }] };
  }
  
  // Multiple namespaces - use OR (should)
  return {
    must: [{
      should: namespaces.map(ns => ({
        key: "namespace",
        match: { value: ns },
      })),
    }],
  };
}

/**
 * Gather auto-recall context from all memory sources
 */
export async function gatherRecallContext(
  db: SlotDB,
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  ctx: RecallContext,
  userQuery?: string,
): Promise<{
  currentState: string;
  projectLivingState: string;
  graphContext: string;
  recentUpdates: string;
  semanticMemories: string;
  recallMeta: {
    recall_confidence: "high" | "medium" | "low";
    recall_suppressed: boolean;
    suppression_reason?: string;
  };
}> {
  // 1. Get Current State from slots (all scopes)
  const scopes = [
    { userId: ctx.userId, agentId: ctx.agentId, label: "private" },
    { userId: ctx.userId, agentId: "__team__", label: "team" },
    { userId: "__public__", agentId: "__public__", label: "public" },
  ];
  
  const mergedState: Record<string, Record<string, unknown>> = {};
  const mergedTimestamps: Record<string, Record<string, string>> = {};
  
  for (const scope of scopes) {
    const state = db.getCurrentState(scope.userId, scope.agentId);
    const slots = db.list(scope.userId, scope.agentId);
    // Build timestamp map
    const tsMap: Record<string, string> = {};
    for (const s of slots) {
      tsMap[s.key] = s.updated_at;
    }
    
    for (const [category, catSlots] of Object.entries(state)) {
      if (!mergedState[category]) {
        mergedState[category] = {};
        mergedTimestamps[category] = {};
      }
      for (const [key, value] of Object.entries(catSlots)) {
        // Skip internal keys (e.g. _autocapture_hash)
        if (key.startsWith('_')) continue;
        const existingTs = mergedTimestamps[category]?.[key];
        const newTs = tsMap[key] || "";
        // Keep the NEWEST version (freshness wins)
        if (!existingTs || newTs > existingTs) {
          mergedState[category][key] = value;
          mergedTimestamps[category][key] = newTs;
        }
      }
    }
  }
  
  const currentStateXml = formatCurrentState(mergedState);

  // 1.5 Get project_living_state slot (private > team > public)
  const projectLivingCandidates = [
    db.get(ctx.userId, ctx.agentId, { key: "project_living_state" }),
    db.get(ctx.userId, "__team__", { key: "project_living_state" }),
    db.get("__public__", "__public__", { key: "project_living_state" }),
  ];
  let projectLivingStateXml = "";
  let projectLivingStateValue: unknown = null;
  for (const c of projectLivingCandidates) {
    if (c && !Array.isArray(c)) {
      projectLivingStateValue = c.value;
      projectLivingStateXml = formatProjectLivingState(c.value);
      if (projectLivingStateXml) break;
    }
  }

  const recallHints = collectRecallHints(ctx.sessionKey, projectLivingStateValue, mergedState);
  
  // 2. Get Graph Context (from private scope only for privacy)
  const allEntities = db.graph.listEntities(ctx.userId, ctx.agentId);
  const entityList = allEntities.slice(0, 10).map((e) => ({ name: e.name, type: e.type }));
  
  const relationships: Array<{ source: string; target: string; type: string }> = [];
  for (const entity of allEntities.slice(0, 5)) {
    const rels = db.graph.getRelationships(ctx.userId, ctx.agentId, entity.id, "outgoing");
    for (const rel of rels.slice(0, 2)) {
      const target = db.graph.getEntity(ctx.userId, ctx.agentId, rel.target_entity_id);
      if (target) {
        relationships.push({ source: entity.name, target: target.name, type: rel.relation_type });
      }
    }
  }
  
  const graphContextXml = formatGraphContext(entityList, relationships);
  
  // 3. Recent Updates (last 5 modified slots)
  const allSlots: Array<{ key: string; updated_at: string }> = [];
  for (const scope of scopes) {
    const slots = db.list(scope.userId, scope.agentId);
    slots.forEach((s) => allSlots.push({ key: s.key, updated_at: s.updated_at }));
  }
  
  const recentSlots = allSlots
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5);
  
  const recentUpdates = recentSlots.length > 0
    ? `<recent-updates>\n${recentSlots.map((s) => `  <update key="${s.key}" at="${s.updated_at}"/>`).join("\n")}\n</recent-updates>`
    : "";
  
  // 4. Semantic Memories from Qdrant (NEW)
  let semanticMemoriesXml = "";
  let recallMeta: { recall_confidence: "high" | "medium" | "low"; recall_suppressed: boolean; suppression_reason?: string } = {
    recall_confidence: "medium",
    recall_suppressed: false,
  };

  if (userQuery && userQuery.trim().length > 0) {
    try {
      // Get agent's namespaces
      const namespaces = getAgentNamespaces(ctx.agentId);
      
      // Generate embedding for the query
      const vector = await embedding.embed(userQuery);
      
      // Build multi-namespace filter
      const namespaceFilter = buildNamespaceFilter(namespaces);
      
      // Search for relevant memories
      const results = await qdrant.search(vector, 8, namespaceFilter);

      const selection = selectSemanticMemories(results, ctx, recallHints);
      recallMeta = {
        recall_confidence: selection.recallConfidence,
        recall_suppressed: selection.suppressed,
        suppression_reason: selection.suppressionReason,
      };
      semanticMemoriesXml = formatSemanticMemories(selection.memories);
      
      if (selection.memories.length > 0) {
        console.log(`[AutoRecall] Found ${selection.memories.length} relevant semantic memories for query (confidence=${selection.recallConfidence}, namespaces: ${namespaces.join(", ")})`);
      } else if (selection.suppressed) {
        console.warn(`[AutoRecall] Semantic recall suppressed due to low confidence: ${selection.suppressionReason || "unknown"}`);
      }
    } catch (error: any) {
      console.error("[AutoRecall] Error querying semantic memories:", error.message);
      semanticMemoriesXml = "";
      recallMeta = {
        recall_confidence: "low",
        recall_suppressed: true,
        suppression_reason: "semantic_search_error",
      };
    }
  }
  
  return {
    currentState: currentStateXml,
    projectLivingState: projectLivingStateXml,
    graphContext: graphContextXml,
    recentUpdates,
    semanticMemories: semanticMemoriesXml,
    recallMeta,
  };
}

/**
 * Inject recall context into system prompt
 */
export function injectRecallContext(systemPrompt: string, context: {
  currentState: string;
  projectLivingState: string;
  graphContext: string;
  recentUpdates: string;
  semanticMemories: string;
  recallMeta?: {
    recall_confidence: "high" | "medium" | "low";
    recall_suppressed: boolean;
    suppression_reason?: string;
  };
}): string {
  // Build injection block
  const injectionParts: string[] = [];
  
  if (context.currentState) {
    injectionParts.push(context.currentState);
  }
  
  if (context.projectLivingState) {
    injectionParts.push(context.projectLivingState);
  }

  if (context.graphContext) {
    injectionParts.push(context.graphContext);
  }
  
  if (context.recentUpdates) {
    injectionParts.push(context.recentUpdates);
  }
  
  if (context.semanticMemories) {
    injectionParts.push(context.semanticMemories);
  }

  if (context.recallMeta) {
    const confidenceBlock = `<recall-meta>\n  <recall_confidence>${context.recallMeta.recall_confidence}</recall_confidence>\n  <recall_suppressed>${String(context.recallMeta.recall_suppressed)}</recall_suppressed>${context.recallMeta.suppression_reason ? `\n  <suppression_reason>${context.recallMeta.suppression_reason}</suppression_reason>` : ""}\n</recall-meta>`;
    injectionParts.push(confidenceBlock);
  }
  
  if (injectionParts.length === 0) {
    return systemPrompt;
  }
  
  const injection = `<!-- Auto-Injected Context -->\n${injectionParts.join("\n\n")}\n<!-- End Auto-Injected Context -->\n\n`;
  
  // Insert after any existing system tags or at the beginning
  if (systemPrompt.includes("<system>")) {
    // Insert after </system> tag
    return systemPrompt.replace("</system>", `</system>\n\n${injection}`);
  }
  
  // Prepend to the prompt
  return injection + systemPrompt;
}

/**
 * Register auto-recall hook
 */
export function registerAutoRecall(
  api: OpenClawPluginApi,
  db: SlotDB,
  qdrant: QdrantClient,
  embedding: EmbeddingClient
): void {
  // Hook into agent lifecycle using the on() method
  api.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    const typedEvent = event as { messages?: Array<{ role: string; content: string }>; systemPrompt?: string };
    const typedCtx = ctx as { sessionKey?: string };
    
    const sessionKey = typedCtx?.sessionKey || "agent:main:default";
    const parts = sessionKey.split(":");
    const agentId = parts.length >= 2 ? parts[1] : "main";
    const userId = normalizeUserId(parts.length >= 3 ? parts.slice(2).join(":") : "default");
    
    // Extract user query from last user message for semantic search
    let userQuery = "";
    if (typedEvent?.messages && typedEvent.messages.length > 0) {
      // Find the last user message
      for (let i = typedEvent.messages.length - 1; i >= 0; i--) {
        const msg = typedEvent.messages[i];
        if (msg.role === "user" && msg.content) {
          userQuery = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          break;
        }
      }
    }
    
    const recallCtx: RecallContext = {
      sessionKey,
      stateDir: process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
      userId,
      agentId,
    };
    
    try {
      const context = await gatherRecallContext(db, qdrant, embedding, recallCtx, userQuery);
      
      // Get original system prompt from event if available
      const originalPrompt = typedEvent?.systemPrompt || "";
      
      // Return system prompt override via the hook result
      return {
        systemPrompt: injectRecallContext(originalPrompt, context),
      };
    } catch (error) {
      console.error("Auto-recall error:", error);
    }
  });
}

/**
 * Get formatted recall context for manual injection
 */
export async function getRecallContextText(
  db: SlotDB,
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  sessionKey: string,
  userQuery?: string,
): Promise<string> {
  const parts = sessionKey.split(":");
  const agentId = parts.length >= 2 ? parts[1] : "main";
  const userId = normalizeUserId(parts.length >= 3 ? parts.slice(2).join(":") : "default");
  
  const ctx: RecallContext = {
    sessionKey,
    stateDir: process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
    userId,
    agentId,
  };
  
  const context = await gatherRecallContext(db, qdrant, embedding, ctx, userQuery);
  
  const parts2: string[] = [];
  if (context.currentState) parts2.push(context.currentState);
  if (context.projectLivingState) parts2.push(context.projectLivingState);
  if (context.graphContext) parts2.push(context.graphContext);
  if (context.recentUpdates) parts2.push(context.recentUpdates);
  if (context.semanticMemories) parts2.push(context.semanticMemories);
  
  return parts2.join("\n\n");
}
