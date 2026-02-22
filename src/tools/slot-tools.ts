/**
 * Slot Memory Tools for OpenClaw Agent - Task 3.3: Cross-Agent Memory Sharing
 *
 * Supports scoping: private (agent-only), team (shared), public (all agents)
 * 
 * Tools:
 * - memory_slot_get: Retrieve a slot by key or category (with scope filter)
 * - memory_slot_set: Upsert a slot with scope (private/team/public)
 * - memory_slot_list: List all slots with scope filter
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";

// Singleton DB instances keyed by state dir
const dbInstances = new Map<string, SlotDB>();

function getSlotDB(stateDir: string): SlotDB {
  let db = dbInstances.get(stateDir);
  if (!db) {
    db = new SlotDB(stateDir);
    dbInstances.set(stateDir, db);
  }
  return db;
}

/**
 * Extract scope identifiers from the session context.
 * For cross-agent sharing, we use special agentId values:
 * - "private": current agent only (default)
 * - "team": shared across all agents
 * - "public": global scope
 */
function extractScope(sessionKey: string, scope?: string): { userId: string; agentId: string } {
  const parts = sessionKey.split(":");
  const agentId = parts.length >= 2 ? parts[1] : "main";
  const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";
  
  // Map scope to agentId for storage
  if (scope === "team") {
    return { userId, agentId: "__team__" }; // Shared across agents
  } else if (scope === "public") {
    return { userId: "__public__", agentId: "__public__" }; // Global
  }
  
  // Default: private scope (agent-specific)
  return { userId, agentId };
}

// Helper to create proper tool result
function createResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { toolResult: { text } },
    isError,
  };
}

export function registerSlotTools(api: OpenClawPluginApi, defaultCategories: string[]): void {
  // Tool 1: memory_slot_get
  api.registerTool({
    name: "memory_slot_get",
    description: `Retrieve a memory slot by its key (dot-notation like "profile.name") or get all slots in a category. Supports cross-agent sharing with scope filter.`,
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: 'Dot-notation key, e.g. "profile.name"' })),
      category: Type.Optional(Type.String({ description: 'Category: "profile", "preferences", "project", "environment", "custom"' })),
      scope: Type.Optional(Type.String({ description: 'Scope filter: "private" (default), "team" (shared), "public" (global), "all" (merge all scopes)' })),
    }),
    async execute(_id: string, params: { key?: string; category?: string; scope?: string }, ctx: any) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const db = getSlotDB(stateDir);

        // Determine which scopes to query
        const scopesToQuery: Array<{ userId: string; agentId: string; label: string }> = [];
        
        if (params.scope === "all") {
          // Query all scopes: private (current agent) + team + public
          const { userId, agentId } = extractScope(sessionKey, "private");
          scopesToQuery.push({ userId, agentId, label: "private" });
          scopesToQuery.push({ userId, agentId: "__team__", label: "team" });
          scopesToQuery.push({ userId: "__public__", agentId: "__public__", label: "public" });
        } else {
          // Query specific scope
          const { userId, agentId } = extractScope(sessionKey, params.scope);
          scopesToQuery.push({ userId, agentId, label: params.scope || "private" });
        }

        // Collect results from all scopes
        const allResults: Array<any> = [];
        
        for (const scopeInfo of scopesToQuery) {
          if (!params.key && !params.category) {
            const slots = db.list(scopeInfo.userId, scopeInfo.agentId);
            slots.forEach(s => allResults.push({ ...s, _scope: scopeInfo.label }));
          } else {
            const result = db.get(scopeInfo.userId, scopeInfo.agentId, { key: params.key, category: params.category });
            if (result) {
              if (Array.isArray(result)) {
                result.forEach(r => allResults.push({ ...r, _scope: scopeInfo.label }));
              } else {
                allResults.push({ ...result, _scope: scopeInfo.label });
              }
            }
          }
        }

        if (allResults.length === 0) {
          return createResult(`No slot found${params.key ? ` for key "${params.key}"` : ""}${params.category ? ` in category "${params.category}"` : ""}${params.scope ? ` with scope "${params.scope}"` : ""}.`);
        }

        // For single key query, return first match (private > team > public)
        if (params.key && allResults.length > 0) {
          const prioritized = allResults.sort((a, b) => {
            const priority = { private: 0, team: 1, public: 2 };
            return (priority[a._scope as keyof typeof priority] || 0) - (priority[b._scope as keyof typeof priority] || 0);
          });
          const result = prioritized[0];
          return createResult(JSON.stringify({
            key: result.key,
            value: result.value,
            category: result.category,
            version: result.version,
            scope: result._scope,
          }, null, 2));
        }

        // For category/list queries, return all with scope labels
        return createResult(JSON.stringify(allResults.map(r => ({
          key: r.key,
          value: r.value,
          category: r.category,
          version: r.version,
          scope: r._scope,
        })), null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // Tool 2: memory_slot_set
  api.registerTool({
    name: "memory_slot_set",
    description: `Store or update a structured memory slot with scoping. Uses upsert semantics with auto-versioning. Scope determines visibility: "private" (agent-only), "team" (shared across agents), "public" (global).`,
    parameters: Type.Object({
      key: Type.String({ description: 'Dot-notation key, e.g. "profile.name"' }),
      value: Type.Any({ description: "Value to store" }),
      category: Type.Optional(Type.String({ description: "Override auto-inferred category" })),
      source: Type.Optional(Type.String({ description: '"manual", "auto_capture", or "tool"' })),
      scope: Type.Optional(Type.String({ description: 'Visibility scope: "private" (default), "team" (shared), "public" (global)' })),
    }),
    async execute(_id: string, params: { key: string; value: unknown; category?: string; source?: string; scope?: string }, ctx: any) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey, params.scope);
        const db = getSlotDB(stateDir);

        const slot = db.set(userId, agentId, {
          key: params.key,
          value: params.value,
          category: params.category,
          source: (params.source as "manual" | "auto_capture" | "tool") || "tool",
        });

        const scopeLabel = params.scope || "private";
        return createResult(`✅ Slot "${slot.key}" ${slot.version > 1 ? `updated (v${slot.version})` : "created"} in category "${slot.category}" [scope: ${scopeLabel}].\nValue: ${JSON.stringify(slot.value)}`);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // Tool 3: memory_slot_list
  api.registerTool({
    name: "memory_slot_list",
    description: `List all stored memory slots with optional scope filter. Shows which scope each slot belongs to.`,
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      prefix: Type.Optional(Type.String({ description: "Filter by key prefix" })),
      scope: Type.Optional(Type.String({ description: 'Scope filter: "private", "team", "public", or "all" (default: all)' })),
    }),
    async execute(_id: string, params: { category?: string; prefix?: string; scope?: string }, ctx: any) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const db = getSlotDB(stateDir);

        // Determine scopes to query
        const scopesToQuery: Array<{ userId: string; agentId: string; label: string }> = [];
        const queryScope = params.scope || "all";
        
        if (queryScope === "all") {
          const { userId, agentId } = extractScope(sessionKey, "private");
          scopesToQuery.push({ userId, agentId, label: "private" });
          scopesToQuery.push({ userId, agentId: "__team__", label: "team" });
          scopesToQuery.push({ userId: "__public__", agentId: "__public__", label: "public" });
        } else {
          const { userId, agentId } = extractScope(sessionKey, queryScope);
          scopesToQuery.push({ userId, agentId, label: queryScope });
        }

        // Collect from all scopes
        const allSlots: Array<any> = [];
        for (const scopeInfo of scopesToQuery) {
          const slots = db.list(scopeInfo.userId, scopeInfo.agentId, { category: params.category, prefix: params.prefix });
          slots.forEach(s => allSlots.push({ ...s, _scope: scopeInfo.label }));
        }

        if (allSlots.length === 0) {
          return createResult(params.category
            ? `No slots found in category "${params.category}"${params.scope ? ` with scope "${params.scope}"` : ""}.`
            : "No memory slots stored yet. Use memory_slot_set to store structured data.");
        }

        // Group by scope
        const grouped: Record<string, Array<{ key: string; value: unknown; version: number }>> = {};
        for (const slot of allSlots) {
          const scope = slot._scope || "private";
          if (!grouped[scope]) grouped[scope] = [];
          grouped[scope].push({ key: slot.key, value: slot.value, version: slot.version });
        }

        let output = `📋 Memory Slots (${allSlots.length} total)\n\n`;
        for (const [scope, items] of Object.entries(grouped)) {
          output += `[${scope.toUpperCase()}]\n`;
          for (const item of items) {
            const val = typeof item.value === "object" ? JSON.stringify(item.value) : String(item.value);
            output += `  ${item.key} = ${val} (v${item.version})\n`;
          }
          output += "\n";
        }

        return createResult(output.trim());
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
}
