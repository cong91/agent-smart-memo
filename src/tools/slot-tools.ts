/**
 * Slot Memory Tools for OpenClaw Agent - Task 3.3: Cross-Agent Memory Sharing
 *
 * Supports scoping: private (agent-only), team (shared), public (all agents)
 *
 * Tools:
 * - memory_slot_get: Retrieve a slot by key or category (with scope filter)
 * - memory_slot_set: Upsert a slot with scope (private/team/public)
 * - memory_slot_delete: Delete a slot by key with explicit scope
 * - memory_slot_list: List all slots with scope filter
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  configureOpenClawRuntime,
  createOpenClawResult,
  getMemoryUseCasePortForContext,
  getSessionKey,
  parseOpenClawSessionIdentity,
} from "../adapters/openclaw/tool-runtime.js";
import type { SemanticMemoryUseCase } from "../core/usecases/semantic-memory-usecase.js";

function createResult(text: string, isError = false) {
  return createOpenClawResult(text, isError);
}

export function registerSlotTools(
  api: OpenClawPluginApi,
  _defaultCategories: string[],
  options?: {
    stateDir?: string;
    slotDbDir?: string;
    semanticUseCaseFactory?: (slotDbDir: string) => SemanticMemoryUseCase | undefined;
  },
): void {
  configureOpenClawRuntime(options);

  // Tool 1: memory_slot_get
  api.registerTool({
    name: "memory_slot_get",
    label: "Slot Memory Get",
    description: `Retrieve a memory slot by its key (dot-notation like "profile.name") or get all slots in a category. Supports cross-agent sharing with scope filter.`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Dot-notation key, e.g. "profile.name"' },
        category: { type: "string", description: 'Category: "profile", "preferences", "project", "environment", "custom"' },
        scope: { type: "string", description: 'Scope filter: "private" (default), "team" (shared), "public" (global), "all" (merge all scopes)' },
      },
    },
    async execute(_id: string, params: { key?: string; category?: string; scope?: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("slot.get", {
          context: { userId, agentId },
          payload: {
            key: params.key,
            category: params.category,
            scope: params.scope as any,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_slot_get",
            requestId: _id,
          },
        });

        if (!data || (Array.isArray(data) && data.length === 0)) {
          return createResult(`No slot found${params.key ? ` for key "${params.key}"` : ""}${params.category ? ` in category "${params.category}"` : ""}${params.scope ? ` with scope "${params.scope}"` : ""}.`);
        }

        if (!Array.isArray(data)) {
          return createResult(JSON.stringify({
            key: data.key,
            value: data.value,
            category: data.category,
            version: data.version,
            scope: data.scope,
          }, null, 2));
        }

        return createResult(JSON.stringify(data.map((r: any) => ({
          key: r.key,
          value: r.value,
          category: r.category,
          version: r.version,
          scope: r.scope,
        })), null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // Tool 2: memory_slot_set
  api.registerTool({
    name: "memory_slot_set",
    label: "Slot Memory Set",
    description: `Store or update a structured memory slot with scoping. Uses upsert semantics with auto-versioning. Scope determines visibility: "private" (agent-only), "team" (shared across agents), "public" (global).`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Dot-notation key, e.g. "profile.name"' },
        value: { description: "Value to store" },
        category: { type: "string", description: "Override auto-inferred category" },
        source: { type: "string", description: '"manual", "auto_capture", or "tool"' },
        scope: { type: "string", description: 'Visibility scope: "private" (default), "team" (shared), "public" (global)' },
      },
      required: ["key", "value"],
    },
    async execute(_id: string, params: { key: string; value: unknown; category?: string; source?: string; scope?: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const slot = await useCasePort.run<typeof params, any>("slot.set", {
          context: { userId, agentId },
          payload: {
            key: params.key,
            value: params.value,
            category: params.category,
            source: params.source as any,
            scope: params.scope as any,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_slot_set",
            requestId: _id,
          },
        });

        const scopeLabel = slot.scope || params.scope || "private";
        return createResult(`✅ Slot "${slot.key}" ${slot.version > 1 ? `updated (v${slot.version})` : "created"} in category "${slot.category}" [scope: ${scopeLabel}].\nValue: ${JSON.stringify(slot.value)}`);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // Tool 3: memory_slot_delete
  api.registerTool({
    name: "memory_slot_delete",
    label: "Slot Memory Delete",
    description: `Delete a memory slot by key from a specific scope. Use this for explicit cleanup/reset of structured memory.`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Dot-notation key to delete, e.g. "project.current_task"' },
        scope: { type: "string", description: 'Scope to delete from: "private" (default), "team", or "public"' },
      },
      required: ["key"],
    },
    async execute(_id: string, params: { key: string; scope?: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const result = await useCasePort.run<typeof params, { key: string; deleted: boolean; scope: string }>("slot.delete", {
          context: { userId, agentId },
          payload: {
            key: params.key,
            scope: params.scope as any,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_slot_delete",
            requestId: _id,
          },
        });

        const scopeLabel = result.scope || params.scope || "private";
        if (!result.deleted) {
          return createResult(`No slot found for key "${params.key}" in scope "${scopeLabel}".`);
        }

        return createResult(`✅ Deleted slot "${params.key}" from scope "${scopeLabel}".`);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // Tool 4: memory_slot_list
  api.registerTool({
    name: "memory_slot_list",
    label: "Slot Memory List",
    description: `List all stored memory slots with optional scope filter. Shows which scope each slot belongs to.`,
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" },
        prefix: { type: "string", description: "Filter by key prefix" },
        scope: { type: "string", description: 'Scope filter: "private", "team", "public", or "all" (default: all)' },
      },
    },
    async execute(_id: string, params: { category?: string; prefix?: string; scope?: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const allSlots = await useCasePort.run<typeof params, Array<{ key: string; value: unknown; version: number; scope: string }>>("slot.list", {
          context: { userId, agentId },
          payload: {
            category: params.category,
            prefix: params.prefix,
            scope: (params.scope || "all") as any,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_slot_list",
            requestId: _id,
          },
        });

        if (!allSlots || allSlots.length === 0) {
          return createResult(params.category
            ? `No slots found in category "${params.category}"${params.scope ? ` with scope "${params.scope}"` : ""}.`
            : "No memory slots stored yet. Use memory_slot_set to store structured data.");
        }

        const grouped: Record<string, Array<{ key: string; value: unknown; version: number }>> = {};
        for (const slot of allSlots) {
          const scope = slot.scope || "private";
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
