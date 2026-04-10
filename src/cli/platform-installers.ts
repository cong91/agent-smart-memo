import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { runInitOpenClaw } from "../../scripts/init-openclaw.mjs";
import { runInstallOrchestration } from "../core/usecases/install-orchestration.js";
import {
	doctorAsmSharedConfig,
	getAsmSharedConfig,
	resolveAsmConfigPath,
	resolveAsmRuntimeConfig,
} from "../shared/asm-config.js";

export interface AsmShellResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
	error: string;
}

export type AsmShellRunner = (
	command: string,
	args?: string[],
) => AsmShellResult;

export interface AsmInstallContext {
	runner: AsmShellRunner;
	log: (line: string) => void;
	argv: string[];
	env: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	initOpenClaw: typeof runInitOpenClaw;
}

export interface AsmInstallerDescriptor {
	id: string;
	displayName: string;
	status: "implemented" | "planned";
	summary: string;
	requiredSharedConfigKeys: string[];
	platformLocalConfigPaths: string[];
}

export interface AsmInstallerResult {
	ok: boolean;
	step: string;
	platform: string;
	details?: Record<string, unknown>;
}

function buildSetupOpenClawReport(details: Record<string, unknown>): {
	status: "pass" | "skip" | "fail";
	createdFiles: string[];
	changedFiles: string[];
	skippedFiles: string[];
} {
	const createdFiles = [
		...((details.surfacesCreated as string[] | undefined) || []).filter(
			Boolean,
		),
		...((details.wikiFilesCreated as string[] | undefined) || []).filter(
			Boolean,
		),
		...(details.openclawConfigPath && details.openclawConfigExisted === false
			? [String(details.openclawConfigPath)]
			: []),
	];
	const changedFiles = [
		...(details.asmConfigChanged
			? [String(details.asmConfigPath || "")].filter(Boolean)
			: []),
		...((details.surfacesPatched as string[] | undefined) || []).filter(
			Boolean,
		),
		...(details.openclawConfigPath && details.openclawConfigExisted !== false
			? [String(details.openclawConfigPath)]
			: []),
	];
	const skippedFiles = [
		...((details.surfacesAlreadyCurrent as string[] | undefined) || []).filter(
			Boolean,
		),
		...((details.wikiFilesAlreadyPresent as string[] | undefined) || []).filter(
			Boolean,
		),
	];
	const status = createdFiles.length || changedFiles.length ? "pass" : "skip";
	return { status, createdFiles, changedFiles, skippedFiles };
}

export interface AsmPlatformInstaller {
	id: string;
	describe(): AsmInstallerDescriptor;
	install(ctx: AsmInstallContext): Promise<AsmInstallerResult>;
}

const ASM_PLUGIN_ID = "agent-smart-memo";

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function includesAsmPlugin(output: unknown): boolean {
	const haystack = String(output || "").toLowerCase();
	return (
		haystack.includes("agent-smart-memo") ||
		haystack.includes("@mrc2204/agent-smart-memo")
	);
}

export function createShellRunner(spawnImpl = spawnSync): AsmShellRunner {
	return (command, args = []) => {
		const result = spawnImpl(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		return {
			ok: result.status === 0 && !result.error,
			code: result.status ?? (result.error ? 1 : 0),
			stdout: text(result.stdout),
			stderr: text(result.stderr),
			error: result.error ? String(result.error.message || result.error) : "",
		};
	};
}

function parseNonInteractive(argv: string[] = []): {
	nonInteractive: boolean;
	autoApply: boolean;
} {
	const args = Array.isArray(argv)
		? argv.map((item) => String(item).trim()).filter(Boolean)
		: [];
	const enabled =
		args.includes("--yes") ||
		args.includes("-y") ||
		args.includes("--non-interactive");
	return { nonInteractive: enabled, autoApply: enabled };
}

function toInt(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function toFloat(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "y"].includes(normalized)) return true;
		if (["0", "false", "no", "n"].includes(normalized)) return false;
	}
	return fallback;
}

async function promptYesNo(
	question: string,
	fallback = false,
): Promise<boolean> {
	if (!input.isTTY || !output.isTTY) return fallback;
	const rl = createInterface({ input, output });
	try {
		const answer = String(await rl.question(question))
			.trim()
			.toLowerCase();
		if (!answer) return fallback;
		if (["y", "yes", "1", "true"].includes(answer)) return true;
		if (["n", "no", "0", "false"].includes(answer)) return false;
		return fallback;
	} finally {
		rl.close();
	}
}

async function promptText(question: string, fallback: string): Promise<string> {
	if (!input.isTTY || !output.isTTY) return fallback;
	const rl = createInterface({ input, output });
	try {
		const answer = String(
			await rl.question(`${question} [${fallback}]: `),
		).trim();
		return answer || fallback;
	} finally {
		rl.close();
	}
}

async function buildWizardCoreConfig(
	existing: Record<string, unknown> | undefined,
	defaults: {
		projectWorkspaceRoot: string;
		qdrantHost: string;
		qdrantPort: number;
		qdrantCollection: string;
		qdrantVectorSize: number;
		embedBaseUrl: string;
		embedBackend: string;
		embedModel: string;
		embedDimensions: number;
		autoCaptureEnabled: boolean;
		autoCaptureMinConfidence: number;
		contextWindowMaxTokens: number;
		summarizeEveryActions: number;
		slotDbDir: string;
		wikiDir: string;
	},
	mode: { nonInteractive: boolean },
): Promise<Record<string, unknown>> {
	const current = existing || {};

	if (mode.nonInteractive) {
		return {
			projectWorkspaceRoot:
				text(current.projectWorkspaceRoot) || defaults.projectWorkspaceRoot,
			qdrantHost: text(current.qdrantHost) || defaults.qdrantHost,
			qdrantPort: toInt(current.qdrantPort, defaults.qdrantPort),
			qdrantCollection:
				text(current.qdrantCollection) || defaults.qdrantCollection,
			qdrantVectorSize: toInt(
				current.qdrantVectorSize,
				defaults.qdrantVectorSize,
			),
			embedBaseUrl: text(current.embedBaseUrl) || defaults.embedBaseUrl,
			embedBackend: text(current.embedBackend) || defaults.embedBackend,
			embedModel: text(current.embedModel) || defaults.embedModel,
			embedDimensions: toInt(current.embedDimensions, defaults.embedDimensions),
			autoCaptureEnabled: toBool(
				current.autoCaptureEnabled,
				defaults.autoCaptureEnabled,
			),
			autoCaptureMinConfidence: toFloat(
				current.autoCaptureMinConfidence,
				defaults.autoCaptureMinConfidence,
			),
			contextWindowMaxTokens: toInt(
				current.contextWindowMaxTokens,
				defaults.contextWindowMaxTokens,
			),
			summarizeEveryActions: toInt(
				current.summarizeEveryActions,
				defaults.summarizeEveryActions,
			),
			slotDbDir:
				text(current.slotDbDir) ||
				text(
					(current.storage as Record<string, unknown> | undefined)?.slotDbDir,
				) ||
				defaults.slotDbDir,
			wikiDir: text(current.wikiDir) || defaults.wikiDir,
			storage: {
				slotDbDir:
					text(
						(current.storage as Record<string, unknown> | undefined)?.slotDbDir,
					) || defaults.slotDbDir,
			},
		};
	}

	const projectWorkspaceRoot = await promptText(
		"projectWorkspaceRoot",
		text(current.projectWorkspaceRoot) || defaults.projectWorkspaceRoot,
	);
	const qdrantHost = await promptText(
		"Qdrant host",
		text(current.qdrantHost) || defaults.qdrantHost,
	);
	const qdrantPort = toInt(
		await promptText(
			"Qdrant port",
			String(toInt(current.qdrantPort, defaults.qdrantPort)),
		),
		defaults.qdrantPort,
	);
	const qdrantCollection = await promptText(
		"Qdrant collection",
		text(current.qdrantCollection) || defaults.qdrantCollection,
	);
	const qdrantVectorSize = toInt(
		await promptText(
			"Qdrant vector size",
			String(toInt(current.qdrantVectorSize, defaults.qdrantVectorSize)),
		),
		defaults.qdrantVectorSize,
	);
	const embedBaseUrl = await promptText(
		"Embedding base URL",
		text(current.embedBaseUrl) || defaults.embedBaseUrl,
	);
	const embedBackend = await promptText(
		"Embedding backend",
		text(current.embedBackend) || defaults.embedBackend,
	);
	const embedModel = await promptText(
		"Embedding model",
		text(current.embedModel) || defaults.embedModel,
	);
	const embedDimensions = toInt(
		await promptText(
			"Embedding dimensions",
			String(toInt(current.embedDimensions, defaults.embedDimensions)),
		),
		defaults.embedDimensions,
	);
	const autoCaptureEnabled = toBool(
		await promptText(
			"autoCaptureEnabled (true/false)",
			String(toBool(current.autoCaptureEnabled, defaults.autoCaptureEnabled)),
		),
		defaults.autoCaptureEnabled,
	);
	const autoCaptureMinConfidence = toFloat(
		await promptText(
			"autoCaptureMinConfidence",
			String(
				toFloat(
					current.autoCaptureMinConfidence,
					defaults.autoCaptureMinConfidence,
				),
			),
		),
		defaults.autoCaptureMinConfidence,
	);
	const contextWindowMaxTokens = toInt(
		await promptText(
			"contextWindowMaxTokens",
			String(
				toInt(current.contextWindowMaxTokens, defaults.contextWindowMaxTokens),
			),
		),
		defaults.contextWindowMaxTokens,
	);
	const summarizeEveryActions = toInt(
		await promptText(
			"summarizeEveryActions",
			String(
				toInt(current.summarizeEveryActions, defaults.summarizeEveryActions),
			),
		),
		defaults.summarizeEveryActions,
	);
	const slotDbDir = await promptText(
		"slotDbDir",
		text((current.storage as Record<string, unknown> | undefined)?.slotDbDir) ||
			defaults.slotDbDir,
	);
	const wikiDir = await promptText(
		"wikiDir",
		text(current.wikiDir) || defaults.wikiDir,
	);

	return {
		projectWorkspaceRoot,
		qdrantHost,
		qdrantPort,
		qdrantCollection,
		qdrantVectorSize,
		embedBaseUrl,
		embedBackend,
		embedModel,
		embedDimensions,
		autoCaptureEnabled,
		autoCaptureMinConfidence,
		contextWindowMaxTokens,
		summarizeEveryActions,
		wikiDir,
		slotDbDir,
		storage: {
			slotDbDir,
		},
	};
}

export async function runInitSetupFlow({
	log = console.log,
	env = process.env,
	homeDir = process.env.HOME,
	cwd = process.cwd(),
	argv = [],
}: {
	log?: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	argv?: string[];
} = {}) {
	const mode = parseNonInteractive(argv);
	const path = resolveAsmConfigPath({ env, homeDir });
	const doctor = doctorAsmSharedConfig({ env, homeDir });
	const loaded = getAsmSharedConfig({ env, homeDir });

	// Bootstrap-only defaults for first-time setup.
	// These values seed shared config and must not be treated as runtime fallback defaults.
	const bootstrapDefaults = {
		projectWorkspaceRoot: "~/Work/projects",
		qdrantHost: "localhost",
		qdrantPort: 6333,
		qdrantCollection: "mrc_bot",
		qdrantVectorSize: 1024,
		embedBaseUrl: "http://localhost:11434",
		embedBackend: "ollama",
		embedModel: "qwen3-embedding:0.6b",
		embedDimensions: 1024,
		autoCaptureEnabled: true,
		autoCaptureMinConfidence: 0.7,
		contextWindowMaxTokens: 32000,
		summarizeEveryActions: 6,
		slotDbDir: "~/.local/share/asm/slotdb",
		wikiDir: "~/Work/projects/agent-smart-memo/memory/wiki",
	} as const;

	const baseConfig = loaded.config || {
		schemaVersion: 1,
		core: {},
		adapters: {},
	};

	const adapters = {
		...(baseConfig.adapters || {}),
		openclaw: {
			enabled: true,
			...((baseConfig.adapters || {}).openclaw || {}),
		},
		opencode: {
			enabled: true,
			mode: "read-only",
			...((baseConfig.adapters || {}).opencode || {}),
		},
	};

	const shouldRunWizard = mode.nonInteractive
		? true
		: await promptYesNo(
				"[ASM-104] Run shared ASM setup wizard now? [y/N] ",
				false,
			);

	if (!shouldRunWizard) {
		if (doctor.exists) {
			log(`[ASM-104] init-setup kept existing shared config at: ${path}`);
			log(
				"[ASM-104] You can re-run `asm init-setup` anytime to open the full wizard.",
			);
			return {
				ok: true,
				step: "init-setup",
				path,
				existed: true,
				nonInteractive: mode.nonInteractive,
			};
		}

		const minimalConfig = {
			schemaVersion: 1,
			core: {},
			adapters,
		};
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(minimalConfig, null, 2)}\n`, "utf8");
		log(`[ASM-104] init-setup created minimal shared config at: ${path}`);
		log(
			"[ASM-104] Shared config wizard was skipped. Edit this file later or rerun `asm init-setup` for full prompts.",
		);
		return {
			ok: true,
			step: "init-setup",
			path,
			existed: false,
			nonInteractive: mode.nonInteractive,
		};
	}

	const wizardCore = await buildWizardCoreConfig(
		baseConfig.core as Record<string, unknown> | undefined,
		bootstrapDefaults,
		mode,
	);

	const nextConfig = {
		schemaVersion:
			typeof baseConfig.schemaVersion === "number"
				? baseConfig.schemaVersion
				: 1,
		...baseConfig,
		core: wizardCore,
		adapters,
	};
	const orchestrated = runInstallOrchestration({
		config: nextConfig,
		configPath: path,
		homeDir,
		cwd,
		log,
	});

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(orchestrated.config, null, 2)}\n`,
		"utf8",
	);
	log(
		`[ASM-104] init-setup ${doctor.exists ? "updated" : "created"} shared config at: ${path}`,
	);
	log(
		"[ASM-104] init-setup defaults are bootstrap-only; runtime must resolve from ASM shared config fields, not installer defaults.",
	);

	return {
		ok: true,
		step: "init-setup",
		path,
		existed: doctor.exists,
		nonInteractive: mode.nonInteractive,
		details: {
			runtimeDefaultsApplied: orchestrated.runtimeDefaultsApplied,
			surfacesScanned: orchestrated.surfacesScanned,
			surfacesPatched: orchestrated.surfacesPatched,
			surfacesAlreadyCurrent: orchestrated.surfacesAlreadyCurrent,
		},
	};
}

async function runSetupOpenClawInstall(
	ctx: AsmInstallContext,
): Promise<AsmInstallerResult> {
	const { runner, log, env, homeDir } = ctx;
	log("[ASM-84] setup-openclaw: checking OpenClaw CLI ...");
	const openclawVersion = runner("openclaw", ["--version"]);
	if (!openclawVersion.ok) {
		log("[ASM-84] ❌ openclaw binary not found or not executable.");
		if (openclawVersion.stderr)
			log(`[ASM-84] details: ${openclawVersion.stderr}`);
		if (openclawVersion.error) log(`[ASM-84] error: ${openclawVersion.error}`);
		return { ok: false, step: "check-openclaw", platform: "openclaw" };
	}

	log(
		"[ASM-84] attempting direct plugin install/update: @mrc2204/agent-smart-memo",
	);
	const install = runner("openclaw", [
		"plugins",
		"install",
		"@mrc2204/agent-smart-memo",
	]);
	const installOutput = `${install.stdout || ""}\n${install.stderr || ""}`;
	const installedLikeSuccess =
		install.ok ||
		includesAsmPlugin(installOutput) ||
		/already installed|already exists|linked plugin path|plugin install command completed|Config overwrite/i.test(
			installOutput,
		);

	if (!installedLikeSuccess) {
		log("[ASM-84] ❌ failed to install or verify plugin via OpenClaw CLI.");
		if (install.stdout) log(install.stdout);
		if (install.stderr) log(install.stderr);
		return { ok: false, step: "install-plugin", platform: "openclaw" };
	}

	if (install.stdout) log(install.stdout);
	if (install.stderr) log(install.stderr);

	const asmConfigPath = resolveAsmConfigPath({ env, homeDir });
	if (!existsSync(asmConfigPath)) {
		log(`[ASM-104] ❌ Shared ASM config not found at: ${asmConfigPath}`);
		log(
			"[ASM-104] Run `asm init-setup` first to create shared config, then rerun `asm install openclaw`.",
		);
		return {
			ok: false,
			step: "missing-shared-config",
			platform: "openclaw",
			details: { asmConfigPath },
		};
	}
	const loaded = getAsmSharedConfig({ env, homeDir, reload: true });
	if (!loaded.config) {
		log(
			`[ASM-104] ❌ Shared ASM config could not be loaded at: ${asmConfigPath}`,
		);
		return {
			ok: false,
			step: "invalid-shared-config",
			platform: "openclaw",
			details: {
				asmConfigPath,
				status: loaded.lifecycle.status,
				warnings: loaded.lifecycle.warnings,
			},
		};
	}
	const orchestrated = runInstallOrchestration({
		config: loaded.config,
		configPath: asmConfigPath,
		homeDir,
		cwd: ctx.cwd || process.cwd(),
		log,
		ensureAgentSurfaceTargets: true,
	});

	const runtimeCore = resolveAsmRuntimeConfig({
		configPath: asmConfigPath,
		env,
		homeDir,
		reload: true,
	});

	const openclawConfigPath =
		text(env.OPENCLAW_CONFIG_PATH) ||
		text(env.OPENCLAW_RUNTIME_CONFIG) ||
		join(homeDir || env.HOME || process.cwd(), ".openclaw", "openclaw.json");
	const openclawConfigExisted = existsSync(openclawConfigPath);

	let openclawConfig: Record<string, unknown> = {};
	if (existsSync(openclawConfigPath)) {
		try {
			const parsed = JSON.parse(readFileSync(openclawConfigPath, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				openclawConfig = parsed as Record<string, unknown>;
			}
		} catch (error) {
			return {
				ok: false,
				step: "invalid-openclaw-config-json",
				platform: "openclaw",
				details: {
					openclawConfigPath,
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	const plugins =
		openclawConfig.plugins &&
		typeof openclawConfig.plugins === "object" &&
		!Array.isArray(openclawConfig.plugins)
			? { ...(openclawConfig.plugins as Record<string, unknown>) }
			: {};
	const entries =
		plugins.entries &&
		typeof plugins.entries === "object" &&
		!Array.isArray(plugins.entries)
			? { ...(plugins.entries as Record<string, unknown>) }
			: {};
	const prevEntry =
		entries[ASM_PLUGIN_ID] &&
		typeof entries[ASM_PLUGIN_ID] === "object" &&
		!Array.isArray(entries[ASM_PLUGIN_ID])
			? (entries[ASM_PLUGIN_ID] as Record<string, unknown>)
			: {};
	const allow = Array.isArray(plugins.allow)
		? (plugins.allow as unknown[]).map((item) => text(item)).filter(Boolean)
		: [];
	if (!allow.includes(ASM_PLUGIN_ID)) allow.push(ASM_PLUGIN_ID);

	const nextOpenClawConfig = {
		...openclawConfig,
		plugins: {
			...plugins,
			allow,
			entries: {
				...entries,
				[ASM_PLUGIN_ID]: {
					...prevEntry,
					enabled: true,
					config: {
						projectWorkspaceRoot: runtimeCore.projectWorkspaceRoot,
						slotDbDir: runtimeCore.slotDbDir,
						wikiDir: runtimeCore.wikiDir,
					},
				},
			},
		},
	};

	mkdirSync(dirname(openclawConfigPath), { recursive: true });
	writeFileSync(
		openclawConfigPath,
		`${JSON.stringify(nextOpenClawConfig, null, 2)}\n`,
		"utf8",
	);
	log(
		`[ASM-104] install openclaw bound runtime config fields for ${ASM_PLUGIN_ID}:`,
	);
	log(
		`[ASM-104]   projectWorkspaceRoot -> ${runtimeCore.projectWorkspaceRoot}`,
	);
	log(`[ASM-104]   slotDbDir -> ${runtimeCore.slotDbDir}`);
	log(`[ASM-104]   wikiDir -> ${runtimeCore.wikiDir}`);
	log(
		`[ASM-104] install openclaw ${openclawConfigExisted ? "updated" : "created"} config at: ${openclawConfigPath}`,
	);
	return {
		ok: true,
		step: "bind-openclaw-config",
		platform: "openclaw",
		details: {
			asmConfigPath,
			asmConfigChanged: orchestrated.configChanged,
			projectWorkspaceRoot: runtimeCore.projectWorkspaceRoot,
			slotDbDir: runtimeCore.slotDbDir,
			wikiDir: runtimeCore.wikiDir,
			openclawConfigPath,
			openclawConfigExisted,
			runtimeDefaultsApplied: orchestrated.runtimeDefaultsApplied,
			surfacesCreated: orchestrated.surfacesCreated,
			surfacesScanned: orchestrated.surfacesScanned,
			surfacesPatched: orchestrated.surfacesPatched,
			surfacesAlreadyCurrent: orchestrated.surfacesAlreadyCurrent,
			wikiFilesCreated: orchestrated.wikiFilesCreated,
			wikiFilesAlreadyPresent: orchestrated.wikiFilesAlreadyPresent,
			wikiDirsEnsured: orchestrated.wikiDirsEnsured,
			report: buildSetupOpenClawReport({
				asmConfigPath,
				asmConfigChanged: orchestrated.configChanged,
				openclawConfigPath,
				openclawConfigExisted,
				surfacesCreated: orchestrated.surfacesCreated,
				surfacesPatched: orchestrated.surfacesPatched,
				surfacesAlreadyCurrent: orchestrated.surfacesAlreadyCurrent,
				wikiFilesCreated: orchestrated.wikiFilesCreated,
				wikiFilesAlreadyPresent: orchestrated.wikiFilesAlreadyPresent,
			}),
		},
	};
}

function resolveOpencodeConfigPath(homeDir?: string): string {
	const home = homeDir || process.env.HOME || process.cwd();
	return join(home, ".config", "opencode", "config.json");
}

function resolveAsmCliCommandForOpencode(): string[] {
	const installerDir = dirname(fileURLToPath(import.meta.url));
	const asmCliPath = join(installerDir, "..", "..", "bin", "asm.mjs");
	return [process.execPath, asmCliPath, "mcp", "opencode"];
}

function ensureOpencodeConfig(
	opencodeConfigPath: string,
	asmConfigPath: string,
): { existed: boolean; config: Record<string, unknown> } {
	const existed = existsSync(opencodeConfigPath);
	let current: Record<string, unknown> = {};
	if (existed) {
		try {
			const parsed = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			}
		} catch {
			current = {};
		}
	}

	const currentMcp =
		current.mcp &&
		typeof current.mcp === "object" &&
		!Array.isArray(current.mcp)
			? { ...(current.mcp as Record<string, unknown>) }
			: {};
	const legacyServers =
		currentMcp.servers &&
		typeof currentMcp.servers === "object" &&
		!Array.isArray(currentMcp.servers)
			? (currentMcp.servers as Record<string, unknown>)
			: {};
	delete currentMcp.servers;

	const next = {
		...current,
		mcp: {
			...legacyServers,
			...currentMcp,
			asm: {
				type: "local",
				command: resolveAsmCliCommandForOpencode(),
				enabled: true,
				environment: {
					ASM_CONFIG: asmConfigPath,
					ASM_MCP_AGENT_ID: "opencode",
				},
			},
		},
	};

	mkdirSync(dirname(opencodeConfigPath), { recursive: true });
	writeFileSync(
		opencodeConfigPath,
		`${JSON.stringify(next, null, 2)}\n`,
		"utf8",
	);
	return { existed, config: next };
}

const openclawInstaller: AsmPlatformInstaller = {
	id: "openclaw",
	describe() {
		return {
			id: "openclaw",
			displayName: "OpenClaw",
			status: "implemented",
			summary:
				"Installs ASM into OpenClaw and bootstraps required runtime fields in openclaw.json from ASM shared config.",
			requiredSharedConfigKeys: [
				"core.projectWorkspaceRoot",
				"core.slotDbDir",
				"core.wikiDir",
				"core.qdrantHost",
				"core.embedModel",
				"adapters.openclaw.enabled",
			],
			platformLocalConfigPaths: [
				"~/.openclaw/openclaw.json",
				"~/.config/asm/config.json",
			],
		};
	},
	async install(ctx) {
		return runSetupOpenClawInstall(ctx);
	},
};

const opencodeInstaller: AsmPlatformInstaller = {
	id: "opencode",
	describe() {
		return {
			id: "opencode",
			displayName: "OpenCode",
			status: "implemented",
			summary:
				"Bootstrap OpenCode read-only/MCP integration using ASM shared config and ASM-106 retrieval contract.",
			requiredSharedConfigKeys: [
				"core.projectWorkspaceRoot",
				"core.storage.slotDbDir",
				"adapters.opencode.enabled",
				"adapters.opencode.mode",
			],
			platformLocalConfigPaths: ["~/.config/opencode/config.json"],
		};
	},
	async install(ctx) {
		const initSetup = await runInitSetupFlow({
			log: ctx.log,
			env: ctx.env,
			homeDir: ctx.homeDir,
			argv: ["--yes"],
		});
		const asmConfigPath = String(initSetup.path);
		const opencodeConfigPath = resolveOpencodeConfigPath(ctx.homeDir);
		const ensured = ensureOpencodeConfig(opencodeConfigPath, asmConfigPath);
		ctx.log(
			`[ASM-104] install opencode ${ensured.existed ? "updated" : "created"} config at: ${opencodeConfigPath}`,
		);
		ctx.log(
			"[ASM-104] OpenCode MCP/read-only integration now points to ASM shared config and should use ASM-106 retrieval contract.",
		);
		return {
			ok: true,
			step: "install-opencode",
			platform: "opencode",
			details: {
				asmConfigPath,
				opencodeConfigPath,
				existed: ensured.existed,
			},
		};
	},
};

const REGISTRY = new Map<string, AsmPlatformInstaller>([
	[openclawInstaller.id, openclawInstaller],
	[opencodeInstaller.id, opencodeInstaller],
]);

export function getAsmPlatformInstaller(
	platform: string,
): AsmPlatformInstaller | null {
	const normalized = String(platform || "")
		.trim()
		.toLowerCase();
	return REGISTRY.get(normalized) || null;
}

export function listAsmPlatformInstallers(): AsmInstallerDescriptor[] {
	return Array.from(REGISTRY.values()).map((installer) => installer.describe());
}

export async function runInstallPlatformFlow({
	platform,
	runner,
	initOpenClaw,
	log,
	argv,
	env = process.env,
	homeDir = process.env.HOME,
	cwd = process.cwd(),
}: {
	platform?: string;
	runner: AsmShellRunner;
	initOpenClaw: typeof runInitOpenClaw;
	log: (line: string) => void;
	argv: string[];
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
}): Promise<AsmInstallerResult> {
	const installer = getAsmPlatformInstaller(String(platform || ""));
	if (!installer) {
		log(
			`[ASM-104] Unknown install target: ${String(platform || "(empty)").trim() || "(empty)"}`,
		);
		log(
			`[ASM-104] Supported install targets right now: ${listAsmPlatformInstallers()
				.map((item) => item.id)
				.join(" | ")}`,
		);
		return {
			ok: false,
			step: "unknown-install-target",
			platform:
				String(platform || "")
					.trim()
					.toLowerCase() || "unknown",
		};
	}

	return installer.install({
		runner,
		initOpenClaw,
		log,
		argv,
		env,
		homeDir,
		cwd,
	});
}
