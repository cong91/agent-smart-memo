/**
 * Agent-Memo: Slot Memory Plugin for OpenClaw v3.0
 *
 * Refactored to use modular tool structure with wiki-first memory
 * - Slot tools: memory_slot_get/set/delete/list
 * - Graph tools: memory_graph_entity_get/set/rel_add/rel_remove/search
 * - Memory tools: memory_search, memory_store (from modules)
 * - Hooks: auto-recall, auto-capture
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAgentMemoOpenClawRuntime } from "./adapters/openclaw/plugin-register.js";

// ============================================================================
// Plugin Configuration Interface
// ============================================================================

export interface AgentMemoConfig {
	projectWorkspaceRoot?: string;
	slotDbDir?: string;
	wikiDir?: string;
	// Legacy compatibility (schema no longer advertises this field).
	asmConfigPath?: string;
}

function asObject(value: unknown): Record<string, any> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, any>)
		: null;
}

function resolvePluginConfig(
	api: OpenClawPluginApi,
	pluginId: string,
): { config: AgentMemoConfig; source: string } {
	const normalizeConfig = (
		value: Record<string, any> | null,
	): AgentMemoConfig => {
		const next: AgentMemoConfig = {};
		if (!value) return next;

		const projectWorkspaceRoot =
			typeof value.projectWorkspaceRoot === "string"
				? value.projectWorkspaceRoot.trim()
				: "";
		if (projectWorkspaceRoot) next.projectWorkspaceRoot = projectWorkspaceRoot;

		const slotDbDir =
			typeof value.slotDbDir === "string" ? value.slotDbDir.trim() : "";
		if (slotDbDir) next.slotDbDir = slotDbDir;

		const wikiDir =
			typeof value.wikiDir === "string" ? value.wikiDir.trim() : "";
		if (wikiDir) next.wikiDir = wikiDir;

		const asmConfigPath =
			typeof value.asmConfigPath === "string" ? value.asmConfigPath.trim() : "";
		if (asmConfigPath) next.asmConfigPath = asmConfigPath;

		return next;
	};

	const hasValues = (value: AgentMemoConfig): boolean =>
		Object.keys(value).length > 0;

	const pluginConfig = asObject((api as any).pluginConfig);
	const normalizedPluginConfig = normalizeConfig(pluginConfig);
	if (hasValues(normalizedPluginConfig)) {
		return {
			config: normalizedPluginConfig,
			source: "pluginConfig",
		};
	}

	const legacyEntryConfig = asObject(
		(api as any)?.config?.plugins?.entries?.[pluginId]?.config,
	);
	const normalizedLegacyConfig = normalizeConfig(legacyEntryConfig);
	if (hasValues(normalizedLegacyConfig)) {
		return {
			config: normalizedLegacyConfig,
			source: "api.config.plugins.entries[pluginId].config",
		};
	}

	return { config: {}, source: "default" };
}

// ============================================================================
// Plugin Definition
// ============================================================================

export const AGENT_MEMO_PLUGIN_ID = "agent-smart-memo";
export const AGENT_MEMO_PLUGIN_NAME = "Agent Memo (Slot Memory + Graph)";
export const AGENT_MEMO_PLUGIN_DESCRIPTION =
	"Structured slot memory, graph relationships, and wiki-first semantic recall for OpenClaw";

export const AGENT_MEMO_CONFIG_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["projectWorkspaceRoot", "slotDbDir", "wikiDir"],
	properties: {
		projectWorkspaceRoot: {
			type: "string",
			description: "Project workspace root path used by ASM runtime",
		},
		slotDbDir: {
			type: "string",
			description: "SlotDB directory used by ASM runtime",
		},
		wikiDir: {
			type: "string",
			description:
				"Wiki memory directory used by ASM runtime (qmdRoot is derived internally)",
		},
	},
} as const;

export const AGENT_MEMO_UI_HINTS = {
	slotDbDir: {
		label: "SlotDB Directory",
		placeholder: "/Users/you/.openclaw/agent-memo",
	},
	wikiDir: {
		label: "Wiki Directory",
		placeholder: "/Users/you/Work/projects/agent-smart-memo/memory/wiki",
	},
	projectWorkspaceRoot: {
		label: "Project Workspace Root",
		placeholder: "/Users/you/Work/projects",
	},
} as const;

export function getAgentMemoPluginDefinition() {
	return {
		id: AGENT_MEMO_PLUGIN_ID,
		name: AGENT_MEMO_PLUGIN_NAME,
		description: AGENT_MEMO_PLUGIN_DESCRIPTION,
		kind: "memory" as const,
		configSchema: AGENT_MEMO_CONFIG_SCHEMA,
		uiHints: AGENT_MEMO_UI_HINTS,
	};
}

export function loadAgentMemoPluginDefinitionFromSource() {
	const pluginPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../openclaw.plugin.json",
	);
	return JSON.parse(readFileSync(pluginPath, "utf8"));
}

const agentMemoPlugin = {
	...getAgentMemoPluginDefinition(),

	register(api: OpenClawPluginApi) {
		const { config, source } = resolvePluginConfig(api, AGENT_MEMO_PLUGIN_ID);
		registerAgentMemoOpenClawRuntime(api, {
			configSource: source,
			projectWorkspaceRoot: config.projectWorkspaceRoot,
			slotDbDir: config.slotDbDir,
			wikiDir: config.wikiDir,
			asmConfigPath: config.asmConfigPath,
		});
	},
};

export default agentMemoPlugin;
