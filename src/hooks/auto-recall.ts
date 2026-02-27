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
import { getAgentNamespaces, MemoryNamespace, normalizeUserId } from "../shared/memory-config.js";

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

/**
 * Build multi-namespace filter for Qdrant search
 */
function buildNamespaceFilter(namespaces: MemoryNamespace[]): any {
  if (namespaces.length === 0) {
    return { must: [{ key: "namespace", match: { value: "agent_decisions" } }] };
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
  graphContext: string;
  recentUpdates: string;
  semanticMemories: string;
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
  if (userQuery && userQuery.trim().length > 0) {
    try {
      // Get agent's namespaces
      const namespaces = getAgentNamespaces(ctx.agentId);
      
      // Generate embedding for the query
      const vector = await embedding.embed(userQuery);
      
      // Build multi-namespace filter
      const namespaceFilter = buildNamespaceFilter(namespaces);
      
      // Search for relevant memories
      const results = await qdrant.search(vector, 5, namespaceFilter);
      
      // Filter by score and format
      const relevantMemories = results
        .filter((r: any) => r.score >= 0.7)
        .map((r: any) => ({ 
          text: r.payload?.text || "", 
          score: r.score,
          namespace: r.payload?.namespace,
        }))
        .filter((m: any) => m.text.length > 0);
      
      semanticMemoriesXml = formatSemanticMemories(relevantMemories);
      
      if (relevantMemories.length > 0) {
        console.log(`[AutoRecall] Found ${relevantMemories.length} relevant semantic memories for query (namespaces: ${namespaces.join(", ")})`);
      }
    } catch (error: any) {
      console.error("[AutoRecall] Error querying semantic memories:", error.message);
      semanticMemoriesXml = "";
    }
  }
  
  return {
    currentState: currentStateXml,
    graphContext: graphContextXml,
    recentUpdates,
    semanticMemories: semanticMemoriesXml,
  };
}

/**
 * Inject recall context into system prompt
 */
export function injectRecallContext(systemPrompt: string, context: {
  currentState: string;
  graphContext: string;
  recentUpdates: string;
  semanticMemories: string;
}): string {
  // Build injection block
  const injectionParts: string[] = [];
  
  if (context.currentState) {
    injectionParts.push(context.currentState);
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
  if (context.graphContext) parts2.push(context.graphContext);
  if (context.recentUpdates) parts2.push(context.recentUpdates);
  if (context.semanticMemories) parts2.push(context.semanticMemories);
  
  return parts2.join("\n\n");
}
