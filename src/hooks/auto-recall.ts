/**
 * Auto-Recall Enhancement - Task 3.4
 * 
 * Automatically injects Slot Memory and Graph context into System Prompt
 * before each agent run (OnBeforeAgentStart hook).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";

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
    xml += `    <entity name=\"${e.name}\" type=\"${e.type}\"/>\n`;
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
 * Gather auto-recall context from all memory sources
 */
export async function gatherRecallContext(
  db: SlotDB,
  ctx: RecallContext,
): Promise<{
  currentState: string;
  graphContext: string;
  recentUpdates: string;
}> {
  // 1. Get Current State from slots (all scopes)
  const scopes = [
    { userId: ctx.userId, agentId: ctx.agentId, label: "private" },
    { userId: ctx.userId, agentId: "__team__", label: "team" },
    { userId: "__public__", agentId: "__public__", label: "public" },
  ];
  
  const mergedState: Record<string, Record<string, unknown>> = {};
  
  for (const scope of scopes) {
    const state = db.getCurrentState(scope.userId, scope.agentId);
    for (const [category, slots] of Object.entries(state)) {
      if (!mergedState[category]) mergedState[category] = {};
      // Private takes precedence over team, team over public
      for (const [key, value] of Object.entries(slots)) {
        if (!(key in mergedState[category])) {
          mergedState[category][key] = value;
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
  
  return {
    currentState: currentStateXml,
    graphContext: graphContextXml,
    recentUpdates,
  };
}

/**
 * Inject recall context into system prompt
 */
export function injectRecallContext(systemPrompt: string, context: {
  currentState: string;
  graphContext: string;
  recentUpdates: string;
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
export function registerAutoRecall(api: OpenClawPluginApi, db: SlotDB): void {
  // Hook into agent lifecycle if supported
  if (api.hooks?.onBeforeAgentStart) {
    api.hooks.onBeforeAgentStart(async (ctx: any) => {
      const sessionKey = ctx?.sessionKey || "agent:main:default";
      const parts = sessionKey.split(":");
      const agentId = parts.length >= 2 ? parts[1] : "main";
      const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";
      
      const recallCtx: RecallContext = {
        sessionKey,
        stateDir: ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
        userId,
        agentId,
      };
      
      try {
        const context = await gatherRecallContext(db, recallCtx);
        
        // If there's a way to modify system prompt, do it
        if (ctx.systemPrompt !== undefined) {
          ctx.systemPrompt = injectRecallContext(ctx.systemPrompt, context);
        }
        
        // Also store in context for tools to access
        ctx.recallContext = context;
      } catch (error) {
        console.error("Auto-recall error:", error);
      }
    });
  }
}

/**
 * Get formatted recall context for manual injection
 */
export async function getRecallContextText(
  db: SlotDB,
  sessionKey: string,
): Promise<string> {
  const parts = sessionKey.split(":");
  const agentId = parts.length >= 2 ? parts[1] : "main";
  const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";
  
  const ctx: RecallContext = {
    sessionKey,
    stateDir: process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
    userId,
    agentId,
  };
  
  const context = await gatherRecallContext(db, ctx);
  
  const parts2: string[] = [];
  if (context.currentState) parts2.push(context.currentState);
  if (context.graphContext) parts2.push(context.graphContext);
  if (context.recentUpdates) parts2.push(context.recentUpdates);
  
  return parts2.join("\n\n");
}
