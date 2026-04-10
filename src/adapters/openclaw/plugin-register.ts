import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerTelegramAddProjectCommand } from "../../commands/telegram-addproject-command.js";
import { SemanticMemoryUseCase } from "../../core/usecases/semantic-memory-usecase.js";
import { SlotDB } from "../../db/slot-db.js";
import { registerAutoCapture } from "../../hooks/auto-capture.js";
import { registerAutoRecall } from "../../hooks/auto-recall.js";
import { registerMemoryToolContextInjector } from "../../hooks/tool-context-injector.js";
import { resolveAsmRuntimeConfig } from "../../shared/asm-config.js";
import { registerGraphTools } from "../../tools/graph-tools.js";
import { registerProjectTools } from "../../tools/project-tools.js";
import { registerSemanticMemoryTools } from "../../tools/semantic-memory-tools.js";
import { registerSlotTools } from "../../tools/slot-tools.js";

const DEFAULT_CATEGORIES = [
	"profile",
	"preferences",
	"project",
	"environment",
	"custom",
] as const;

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function expandHome(input: string, homeDir?: string): string {
	if (!input.startsWith("~")) return input;

	const home = firstNonEmptyString(homeDir, process.env.HOME);
	if (!home) return input;

	if (input === "~") return home;
	if (input.startsWith("~/")) return join(home, input.slice(2));
	return input;
}

function normalizeRuntimePath(input: string, homeDir?: string): string {
	return resolve(expandHome(input, homeDir));
}

function resolveRuntimeFromPluginConfig(options: {
	projectWorkspaceRoot?: string;
	slotDbDir?: string;
	wikiDir?: string;
	asmConfigPath?: string;
}):
	| {
			mode: "explicit_plugin_config";
			projectWorkspaceRoot: string;
			slotDbDir: string;
			wikiDir: string;
	  }
	| { mode: "legacy_shared_config" }
	| never {
	const projectWorkspaceRoot = firstNonEmptyString(
		options.projectWorkspaceRoot,
	);
	const slotDbDir = firstNonEmptyString(options.slotDbDir);
	const wikiDir = firstNonEmptyString(options.wikiDir);

	const hasAnyExplicitField = Boolean(
		projectWorkspaceRoot || slotDbDir || wikiDir,
	);

	if (!hasAnyExplicitField) {
		return { mode: "legacy_shared_config" };
	}

	const missingFields: string[] = [];
	if (!projectWorkspaceRoot) missingFields.push("projectWorkspaceRoot");
	if (!slotDbDir) missingFields.push("slotDbDir");
	if (!wikiDir) missingFields.push("wikiDir");
	if (missingFields.length > 0) {
		throw new Error(
			`AgentMemo plugin config is explicit but incomplete; required fields missing: ${missingFields.join(
				", ",
			)}. No fallback guessing is applied when explicit plugin config is present.`,
		);
	}

	const explicitProjectWorkspaceRoot = projectWorkspaceRoot as string;
	const explicitSlotDbDir = slotDbDir as string;
	const explicitWikiDir = wikiDir as string;

	return {
		mode: "explicit_plugin_config",
		projectWorkspaceRoot: normalizeRuntimePath(
			explicitProjectWorkspaceRoot,
			process.env.HOME,
		),
		slotDbDir: normalizeRuntimePath(explicitSlotDbDir, process.env.HOME),
		wikiDir: normalizeRuntimePath(explicitWikiDir, process.env.HOME),
	};
}

export function registerAgentMemoOpenClawRuntime(
	api: OpenClawPluginApi,
	options: {
		configSource: string;
		projectWorkspaceRoot?: string;
		slotDbDir?: string;
		wikiDir?: string;
		asmConfigPath?: string;
	},
) {
	const slotCategories = [...DEFAULT_CATEGORIES];
	const pluginRuntime = resolveRuntimeFromPluginConfig(options);
	const runtime =
		pluginRuntime.mode === "explicit_plugin_config"
			? {
					asmConfigPath: "",
					projectWorkspaceRoot: pluginRuntime.projectWorkspaceRoot,
					slotDbDir: pluginRuntime.slotDbDir,
					wikiDir: pluginRuntime.wikiDir,
				}
			: resolveAsmRuntimeConfig({
					configPath: options.asmConfigPath,
					env: process.env,
					homeDir: process.env.HOME,
				});
	const projectWorkspaceRoot = runtime.projectWorkspaceRoot;
	const wikiDir = runtime.wikiDir;

	const stateDir =
		process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
	const slotDbDir = runtime.slotDbDir;

	if (projectWorkspaceRoot) {
		process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT = projectWorkspaceRoot;
		process.env.AGENT_MEMO_REPO_CLONE_ROOT = projectWorkspaceRoot;
	}
	if (wikiDir) {
		process.env.ASM_WIKI_ROOT = wikiDir;
	}

	const autoCaptureEnabled =
		String(process.env.ASM_AUTO_CAPTURE_ENABLED || "true").toLowerCase() !==
		"false";
	const autoCaptureMinConfidence = Number(
		process.env.ASM_AUTO_CAPTURE_MIN_CONFIDENCE || "0.7",
	);
	const contextWindowMaxTokens = Number(
		process.env.ASM_CONTEXT_WINDOW_MAX_TOKENS || "12000",
	);
	const summarizeEveryActions = Number(
		process.env.ASM_SUMMARIZE_EVERY_ACTIONS || "6",
	);

	console.log(`[AgentMemo] Startup config: source=${options.configSource}`);
	console.log(
		`[AgentMemo] Runtime config mode: ${pluginRuntime.mode === "explicit_plugin_config" ? "plugin-config" : "shared-config"}`,
	);
	console.log("[AgentMemo] Configuration:");
	console.log(`  Slot categories: ${slotCategories.join(", ")}`);
	console.log(`  Wiki dir: ${wikiDir}`);
	console.log(`  AutoCapture: ${autoCaptureEnabled ? "enabled" : "disabled"}`);
	console.log(`  ContextWindow: ${contextWindowMaxTokens} tokens`);
	console.log(`  SummarizeEveryActions: ${summarizeEveryActions}`);
	console.log(`  SlotDB dir: ${slotDbDir}`);
	if (projectWorkspaceRoot) {
		console.log(`  ProjectWorkspaceRoot: ${projectWorkspaceRoot}`);
	}

	const slotDB = new SlotDB(stateDir, { slotDbDir });

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
					slotDbDir,
					wikiDir,
					projectWorkspaceRoot,
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

	const semanticUseCaseBySlotDbDir = new Map<string, SemanticMemoryUseCase>();
	const getSemanticUseCase = (
		resolvedSlotDbDir: string,
	): SemanticMemoryUseCase => {
		let uc = semanticUseCaseBySlotDbDir.get(resolvedSlotDbDir);
		if (!uc) {
			uc = new SemanticMemoryUseCase();
			semanticUseCaseBySlotDbDir.set(resolvedSlotDbDir, uc);
		}
		return uc;
	};

	registerSemanticMemoryTools(api, {
		stateDir,
		slotDbDir,
		semanticUseCaseFactory: (resolvedSlotDbDir) =>
			getSemanticUseCase(resolvedSlotDbDir),
	});

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

	registerAutoRecall(api, slotDB);
	registerAutoCapture(api, slotDB, {
		enabled: autoCaptureEnabled,
		minConfidence: autoCaptureMinConfidence,
		bootstrapSafeRawFirst:
			String(
				process.env.ASM_BOOTSTRAP_SAFE_RAW_FIRST || "true",
			).toLowerCase() !== "false",
		useLLM:
			String(process.env.ASM_AUTO_CAPTURE_USE_LLM || "true").toLowerCase() !==
			"false",
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
}
