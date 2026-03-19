/**
 * Agent-Memo: Slot Memory Plugin for OpenClaw v3.0
 *
 * Refactored to use modular tool structure with single Qdrant collection
 * - Slot tools: memory_slot_get/set/delete/list
 * - Graph tools: memory_graph_entity_get/set/rel_add/rel_remove/search
 * - Qdrant tools: memory_search, memory_store (from modules)
 * - Hooks: auto-recall, auto-capture
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerTelegramAddProjectCommand } from "./commands/telegram-addproject-command.js";
import { SemanticMemoryUseCase } from "./core/usecases/semantic-memory-usecase.js";
import { SlotDB } from "./db/slot-db.js";
import { registerAutoCapture } from "./hooks/auto-capture.js";
// Hook modules
import { registerAutoRecall } from "./hooks/auto-recall.js";
import { registerMemoryToolContextInjector } from "./hooks/tool-context-injector.js";
import { DeduplicationService } from "./services/dedupe.js";
import { type EmbedBackend, EmbeddingClient } from "./services/embedding.js";
import { QdrantClient } from "./services/qdrant.js";
import { resolveAsmRuntimeConfig } from "./shared/asm-config.js";
import { resolveSlotDbDir } from "./shared/slotdb-path.js";
import { registerGraphTools } from "./tools/graph-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerSemanticMemoryTools } from "./tools/semantic-memory-tools.js";
// Tool modules
import { registerSlotTools } from "./tools/slot-tools.js";

// ============================================================================
// Plugin Configuration Interface
// ============================================================================

export interface AgentMemoConfig {
	asmConfigPath?: string;
}

const CONFIG_KEY_CANDIDATES: (keyof AgentMemoConfig)[] = ["asmConfigPath"];

function asObject(value: unknown): Record<string, any> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, any>)
		: null;
}

function hasAnyConfigKey(obj: Record<string, any> | null): boolean {
	if (!obj) return false;
	return CONFIG_KEY_CANDIDATES.some((key) => key in obj);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function findNestedStringKey(
	input: unknown,
	key: string,
	maxDepth = 5,
): string | undefined {
	const visited = new Set<unknown>();

	function walk(node: unknown, depth: number): string | undefined {
		if (
			!node ||
			typeof node !== "object" ||
			depth > maxDepth ||
			visited.has(node)
		) {
			return undefined;
		}

		visited.add(node);
		const obj = node as Record<string, unknown>;

		if (
			typeof obj[key] === "string" &&
			(obj[key] as string).trim().length > 0
		) {
			return (obj[key] as string).trim();
		}

		for (const value of Object.values(obj)) {
			const found = walk(value, depth + 1);
			if (found) return found;
		}

		return undefined;
	}

	return walk(input, 0);
}

function resolveLegacyConfig(rawConfig: unknown): {
	config: AgentMemoConfig;
	source: string;
} {
	const root = asObject(rawConfig);

	const candidates: Array<{
		source: string;
		value: Record<string, any> | null;
	}> = [
		{ source: "api.config", value: root },
		{ source: "api.config.config", value: asObject(root?.config) },
		{ source: "api.config.entry.config", value: asObject(root?.entry?.config) },
		{
			source: "api.config.plugin.config",
			value: asObject(root?.plugin?.config),
		},
		{ source: "api.config.value.config", value: asObject(root?.value?.config) },
		{
			source: "api.config.settings.config",
			value: asObject(root?.settings?.config),
		},
	];

	for (const candidate of candidates) {
		if (hasAnyConfigKey(candidate.value)) {
			return {
				config: candidate.value as AgentMemoConfig,
				source: candidate.source,
			};
		}
	}

	// Backward compatibility for wrapper style { enabled, config }
	if (asObject(root?.config)) {
		return {
			config: asObject(root?.config) as AgentMemoConfig,
			source: "api.config.config (wrapper-fallback)",
		};
	}

	return { config: {}, source: "default" };
}

function resolvePluginConfig(
	api: OpenClawPluginApi,
	pluginId: string,
): { config: AgentMemoConfig; source: string } {
	const pluginConfig = asObject((api as any).pluginConfig);
	if (
		typeof pluginConfig?.asmConfigPath === "string" &&
		pluginConfig.asmConfigPath.trim()
	) {
		return {
			config: { asmConfigPath: pluginConfig.asmConfigPath.trim() },
			source: "pluginConfig",
		};
	}

	const legacyEntryConfig = asObject(
		(api as any)?.config?.plugins?.entries?.[pluginId]?.config,
	);
	if (
		typeof legacyEntryConfig?.asmConfigPath === "string" &&
		legacyEntryConfig.asmConfigPath.trim()
	) {
		return {
			config: { asmConfigPath: legacyEntryConfig.asmConfigPath.trim() },
			source: "api.config.plugins.entries[pluginId].config",
		};
	}

	return { config: {}, source: "default" };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const DEFAULT_CATEGORIES = [
	"profile",
	"preferences",
	"project",
	"environment",
	"custom",
];

export const AGENT_MEMO_PLUGIN_ID = "agent-smart-memo";
export const AGENT_MEMO_PLUGIN_NAME = "Agent Memo (Slot Memory + Graph)";
export const AGENT_MEMO_PLUGIN_DESCRIPTION =
	"Structured slot memory, graph relationships, and semantic search for OpenClaw";

export const AGENT_MEMO_CONFIG_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		slotCategories: {
			type: "array",
			items: { type: "string" },
			description: "Allowed slot categories",
		},
		maxSlots: {
			type: "number",
			description: "Maximum number of slots per scope",
		},
		injectStateTokenBudget: {
			type: "number",
			description: "Max tokens for Current State injection",
		},
		asmConfigPath: {
			type: "string",
			description:
				"Path to shared ASM config source-of-truth used by the OpenClaw plugin runtime.",
		},
		qdrantHost: {
			type: "string",
			description: "Qdrant host",
		},
		qdrantPort: {
			type: "number",
			description: "Qdrant port",
		},
		qdrantCollection: {
			type: "string",
			description: "Qdrant collection name",
		},
		qdrantVectorSize: {
			type: "number",
			description: "Qdrant vector size",
		},
		llmBaseUrl: {
			type: "string",
			description: "Base URL for LLM API",
		},
		llmApiKey: {
			type: "string",
			description: "API key for LLM provider",
		},
		llmModel: {
			type: "string",
			description: "LLM model name",
		},
		embedBaseUrl: {
			type: "string",
			description: "Base URL for embedding service",
		},
		embedBackend: {
			type: "string",
			description: "Embedding backend",
		},
		embedModel: {
			type: "string",
			description: "Embedding model",
		},
		embedDimensions: {
			type: "number",
			description: "Embedding vector dimensions",
		},
		autoCaptureEnabled: {
			type: "boolean",
			description: "Enable automatic capture",
		},
		autoCaptureMinConfidence: {
			type: "number",
			description: "Minimum confidence threshold for auto-capture",
		},
		contextWindowMaxTokens: {
			type: "number",
			description: "Context window maximum tokens",
		},
		summarizeEveryActions: {
			type: "number",
			description: "Summarize every N actions",
		},
		projectWorkspaceRoot: {
			type: "string",
			description: "Project workspace root path",
		},
		slotDbDir: {
			type: "string",
			description: "SlotDB directory",
		},
	},
} as const;

export const AGENT_MEMO_UI_HINTS = {
	slotCategories: {
		label: "Slot Categories",
		placeholder: "profile, preferences, project, environment",
	},
	maxSlots: {
		label: "Max Slots",
		placeholder: "500",
	},
	injectStateTokenBudget: {
		label: "State Injection Token Budget",
		placeholder: "500",
	},
	qdrantHost: {
		label: "Qdrant Host",
		placeholder: "localhost",
	},
	qdrantPort: {
		label: "Qdrant Port",
		placeholder: "6333",
	},
	qdrantCollection: {
		label: "Qdrant Collection",
		placeholder: "mrc_bot_memory",
	},
	llmBaseUrl: {
		label: "LLM Base URL",
		placeholder: "http://localhost:8317/v1",
	},
	llmApiKey: {
		label: "LLM API Key",
		placeholder: "proxypal-local",
	},
	llmModel: {
		label: "LLM Model",
		placeholder: "gemini-3.1-pro-low",
	},
	embedBaseUrl: {
		label: "Embedding Base URL",
		placeholder: "http://localhost:11434",
	},
	embedBackend: {
		label: "Embedding Backend",
		placeholder: "ollama",
	},
	embedModel: {
		label: "Embedding Model",
		placeholder: "qwen3-embedding:0.6b",
	},
	embedDimensions: {
		label: "Embedding Dimensions",
		placeholder: "1024",
	},
	slotDbDir: {
		label: "SlotDB Directory",
		placeholder: "/Users/you/.openclaw/agent-memo",
	},
	projectWorkspaceRoot: {
		label: "Project Workspace Root",
		placeholder: "/Users/you/Work/projects",
	},
	autoCaptureEnabled: {
		label: "Auto Capture Enabled",
	},
	autoCaptureMinConfidence: {
		label: "Min Confidence",
		placeholder: "0.7",
	},
	contextWindowMaxTokens: {
		label: "Context Window Max Tokens",
		placeholder: "12000",
	},
	summarizeEveryActions: {
		label: "Summarize Every N Actions",
		placeholder: "6",
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
		// ----------------------------------------------------------------
		// Resolve config with priority:
		// 1) api.pluginConfig
		// 2) api.config.plugins.entries[pluginId].config (compat)
		// 3) legacy api.config shapes
		// ----------------------------------------------------------------
		const rawConfig = (api as any).config;
		const { config, source } = resolvePluginConfig(api, "agent-smart-memo");

		const slotCategories = DEFAULT_CATEGORIES;
		const asmConfigPath = firstNonEmptyString(config.asmConfigPath);
		const runtime = resolveAsmRuntimeConfig({
			configPath: asmConfigPath,
			env: process.env,
			homeDir: process.env.HOME,
		});
		const qdrantHost = runtime.qdrantHost;
		const qdrantPort = runtime.qdrantPort;
		const qdrantCollection = runtime.qdrantCollection;
		const qdrantVectorSize = runtime.qdrantVectorSize;
		const llmBaseUrl = runtime.llmBaseUrl;
		const llmApiKey = runtime.llmApiKey;
		const llmModel = runtime.llmModel;
		const llmModelFallbackUsed = false;
		const embedBaseUrl = runtime.embedBaseUrl;
		const embedBackend = runtime.embedBackend as EmbedBackend | undefined;
		const embedModel = runtime.embedModel;
		const embedDimensions = runtime.embedDimensions;
		const autoCaptureEnabled = runtime.autoCaptureEnabled;
		const autoCaptureMinConfidence = runtime.autoCaptureMinConfidence;
		const contextWindowMaxTokens = runtime.contextWindowMaxTokens;
		const summarizeEveryActions = runtime.summarizeEveryActions;
		const projectWorkspaceRoot = runtime.projectWorkspaceRoot;

		const stateDir =
			process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
		const slotDbDir = runtime.slotDbDir;

		if (projectWorkspaceRoot) {
			process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT = projectWorkspaceRoot;
			process.env.AGENT_MEMO_REPO_CLONE_ROOT = projectWorkspaceRoot;
		}

		console.log(
			`[AgentMemo] Startup config: source=${source}, resolved llmModel: ${llmModel}, fallbackUsed=${llmModelFallbackUsed}`,
		);
		console.log("[AgentMemo] Configuration:");
		console.log(`  Slot categories: ${slotCategories.join(", ")}`);
		console.log(`  Qdrant: ${qdrantHost}:${qdrantPort}/${qdrantCollection}`);
		console.log(`  LLM: ${llmBaseUrl} (model: ${llmModel})`);
		console.log(
			`  Embedding: ${embedBaseUrl} (backend: ${embedBackend || "auto"}, model: ${embedModel}, ${embedDimensions}d)`,
		);
		console.log(
			`  AutoCapture: ${autoCaptureEnabled ? "enabled" : "disabled"}`,
		);
		console.log(`  ContextWindow: ${contextWindowMaxTokens} tokens`);
		console.log(`  SummarizeEveryActions: ${summarizeEveryActions}`);
		console.log(`  SlotDB dir: ${slotDbDir}`);
		if (projectWorkspaceRoot) {
			console.log(`  ProjectWorkspaceRoot: ${projectWorkspaceRoot}`);
		}

		// ----------------------------------------------------------------
		// Initialize services
		// ----------------------------------------------------------------
		const slotDB = new SlotDB(stateDir, { slotDbDir });

		// Single Qdrant collection for all agents - namespace isolation via payload
		const routeMapRaw = process.env.EMBEDDING_DIM_ROUTE_MAP || "";
		const routeMap = routeMapRaw
			.split(",")
			.map((pair) => pair.trim())
			.filter(Boolean)
			.reduce<Record<number, string>>((acc, pair) => {
				const [dimText, collection] = pair.split(":").map((x) => x?.trim());
				const dim = Number(dimText);
				if (Number.isFinite(dim) && dim > 0 && collection) {
					acc[dim] = collection;
				}
				return acc;
			}, {});

		const qdrant = new QdrantClient({
			host: qdrantHost,
			port: qdrantPort,
			collection: qdrantCollection,
			vectorSize: qdrantVectorSize,
			dimensionRouteMap: routeMap,
		});

		const embedding = new EmbeddingClient({
			embeddingApiUrl: embedBaseUrl,
			backend: embedBackend,
			model: embedModel,
			dimensions: embedDimensions,
			stateDir,
		});

		embedding.calibrateRuntimeCapability(true).catch((error: any) => {
			console.warn(
				`[AgentMemo] Embedding calibration skipped: ${error.message}`,
			);
		});

		try {
			mkdirSync(join(stateDir, "plugin-data", "agent-smart-memo"), {
				recursive: true,
			});
			writeFileSync(
				join(
					stateDir,
					"plugin-data",
					"agent-smart-memo",
					"runtime-manifest.json",
				),
				JSON.stringify(
					{
						pluginId: "agent-smart-memo",
						distEntry: import.meta.url,
						generatedAt: new Date().toISOString(),
						embedModel,
						embedBaseUrl,
						embedBackend: embedBackend || "auto",
						embedDimensions,
						qdrantCollection,
					},
					null,
					2,
				),
				"utf8",
			);
		} catch (error: any) {
			console.warn(
				`[AgentMemo] Failed to write runtime manifest: ${error.message}`,
			);
		}

		const dedupe = new DeduplicationService(0.95, console);
		const semanticUseCaseBySlotDbDir = new Map<string, SemanticMemoryUseCase>();
		const getSemanticUseCase = (
			resolvedSlotDbDir: string,
		): SemanticMemoryUseCase => {
			let uc = semanticUseCaseBySlotDbDir.get(resolvedSlotDbDir);
			if (!uc) {
				uc = new SemanticMemoryUseCase(qdrant, embedding, dedupe);
				semanticUseCaseBySlotDbDir.set(resolvedSlotDbDir, uc);
			}
			return uc;
		};

		// ----------------------------------------------------------------
		// Register tools through shared use-case runtime boundary
		// ----------------------------------------------------------------
		registerSemanticMemoryTools(api, {
			stateDir,
			slotDbDir,
			semanticUseCaseFactory: (resolvedSlotDbDir) =>
				getSemanticUseCase(resolvedSlotDbDir),
		});

		// ----------------------------------------------------------------
		// Register Slot & Graph tools
		// ----------------------------------------------------------------
		registerSlotTools(api, slotCategories, {
			stateDir,
			slotDbDir,
			semanticUseCaseFactory: (resolvedSlotDbDir) =>
				getSemanticUseCase(resolvedSlotDbDir),
		});
		registerGraphTools(api, {
			stateDir,
			slotDbDir,
			semanticUseCaseFactory: (resolvedSlotDbDir) =>
				getSemanticUseCase(resolvedSlotDbDir),
		});
		registerProjectTools(api, {
			stateDir,
			slotDbDir,
			semanticUseCaseFactory: (resolvedSlotDbDir) =>
				getSemanticUseCase(resolvedSlotDbDir),
		});
		registerTelegramAddProjectCommand(api);

		// ----------------------------------------------------------------
		// Register lifecycle hooks
		// ----------------------------------------------------------------
		registerAutoRecall(api, slotDB, qdrant, embedding);
		registerAutoCapture(api, slotDB, qdrant, embedding, dedupe, {
			enabled: autoCaptureEnabled,
			minConfidence: autoCaptureMinConfidence,
			useLLM: true,
			llmBaseUrl,
			llmApiKey,
			llmModel,
			contextWindowMaxTokens,
			summarizeEveryActions,
		});
		registerMemoryToolContextInjector(api);

		console.log("[AgentMemo] Plugin registered successfully");
		console.log(
			"[AgentMemo] Tools: memory_search, memory_store, memory_slot_*, memory_graph_*, project_registry_*, project_task_*, project_hybrid_search",
		);
		console.log(
			"[AgentMemo] Hooks: auto-recall, auto-capture, tool-context-injector",
		);
	},
};

export default agentMemoPlugin;
