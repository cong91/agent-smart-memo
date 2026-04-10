import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AsmSharedConfig } from "../../shared/asm-config.js";
import { scanAgentSurfaces } from "./agent-surface-scan.js";
import {
	ASM_WIKI_FIRST_BLOCK_VERSION,
	patchReinforcementSurface,
} from "./reinforcement-patch.js";

export interface InstallOrchestrationInput {
	config: AsmSharedConfig;
	configPath: string;
	homeDir?: string;
	cwd?: string;
	now?: Date;
	log?: (line: string) => void;
	ensureAgentSurfaceTargets?: boolean;
}

export interface InstallOrchestrationResult {
	config: AsmSharedConfig;
	configChanged: boolean;
	runtimeDefaultsApplied: string[];
	surfacesScanned: string[];
	surfacesCreated: string[];
	surfacesPatched: string[];
	surfacesAlreadyCurrent: string[];
	wikiFilesCreated: string[];
	wikiFilesAlreadyPresent: string[];
	wikiDirsEnsured: string[];
	blockVersion: string;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function expandHome(input: string, homeDir?: string): string {
	if (!input.startsWith("~")) return input;
	const home = text(homeDir) || text(process.env.HOME);
	if (!home) return input;
	if (input === "~") return home;
	if (input.startsWith("~/")) return resolve(home, input.slice(2));
	return input;
}

function toPortablePath(path: string, homeDir?: string): string {
	const home = text(homeDir) || text(process.env.HOME);
	if (!home) return path;
	const normalizedHome = resolve(home);
	const normalizedPath = resolve(expandHome(path, homeDir));
	if (normalizedPath === normalizedHome) return "~";
	if (normalizedPath.startsWith(`${normalizedHome}/`)) {
		return `~/${normalizedPath.slice(normalizedHome.length + 1)}`;
	}
	return path;
}

function cloneConfig(config: AsmSharedConfig): AsmSharedConfig {
	return JSON.parse(JSON.stringify(config || {})) as AsmSharedConfig;
}

function buildDefaultWikiDir(projectWorkspaceRoot: string): string {
	const normalizedRoot = projectWorkspaceRoot.replace(/\/$/u, "");
	return `${normalizedRoot}/agent-smart-memo/memory/wiki`;
}

function ensureFileIfMissing(
	path: string,
	content: string,
): "created" | "already-present" {
	if (existsSync(path)) return "already-present";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	return "created";
}

function ensureWikiBootstrapSurface(wikiDir: string): {
	createdFiles: string[];
	alreadyPresentFiles: string[];
	ensuredDirs: string[];
} {
	const root = resolve(expandHome(wikiDir));
	const ensuredDirs = [
		resolve(root),
		resolve(root, "live"),
		resolve(root, "briefings"),
		resolve(root, "drafts"),
		resolve(root, "raw"),
	];
	for (const dir of ensuredDirs) {
		mkdirSync(dir, { recursive: true });
	}

	const fileSpecs = [
		{
			path: resolve(root, "index.md"),
			content: [
				"# ASM Wiki Memory Index",
				"",
				"Use this wiki as the working surface for repo-specific context.",
				"",
				"## Pages",
				"",
			].join("\n"),
		},
		{
			path: resolve(root, "schema.md"),
			content: [
				"# ASM Wiki Memory Schema",
				"",
				"- `live/`: working pages for current project knowledge.",
				"- `briefings/`: concise derived summaries.",
				"- `drafts/`: intermediary notes before promotion.",
				"- `raw/`: captured artifacts and append-only imports.",
				"- `log.md`: append-only wiki activity log.",
			].join("\n"),
		},
		{
			path: resolve(root, "log.md"),
			content: "# ASM Wiki Memory Log\n\n",
		},
	];

	const createdFiles: string[] = [];
	const alreadyPresentFiles: string[] = [];
	for (const spec of fileSpecs) {
		const status = ensureFileIfMissing(spec.path, spec.content);
		(status === "created" ? createdFiles : alreadyPresentFiles).push(spec.path);
	}

	return { createdFiles, alreadyPresentFiles, ensuredDirs };
}

export function ensureRuntimeConfigDefaults(
	config: AsmSharedConfig,
	homeDir?: string,
): { config: AsmSharedConfig; applied: string[] } {
	const next = cloneConfig(config);
	next.schemaVersion =
		typeof next.schemaVersion === "number" ? next.schemaVersion : 1;
	next.core = { ...(next.core || {}) };
	next.adapters = { ...(next.adapters || {}) };
	const core = next.core as Record<string, unknown>;
	const applied: string[] = [];

	const projectWorkspaceRoot =
		text(core.projectWorkspaceRoot) || "~/Work/projects";
	if (!text(core.projectWorkspaceRoot)) {
		core.projectWorkspaceRoot = projectWorkspaceRoot;
		applied.push("core.projectWorkspaceRoot");
	}

	const slotDbDir =
		text(core.slotDbDir) ||
		text((core.storage as Record<string, unknown> | undefined)?.slotDbDir) ||
		"~/.local/share/asm/slotdb";
	if (!text(core.slotDbDir)) {
		core.slotDbDir = slotDbDir;
		applied.push("core.slotDbDir");
	}
	const storage = {
		...((core.storage as Record<string, unknown> | undefined) || {}),
		slotDbDir,
	};
	if (
		text((core.storage as Record<string, unknown> | undefined)?.slotDbDir) !==
		slotDbDir
	) {
		applied.push("core.storage.slotDbDir");
	}
	core.storage = storage;

	const wikiDir =
		text(core.wikiDir) || buildDefaultWikiDir(projectWorkspaceRoot);
	if (!text(core.wikiDir)) {
		core.wikiDir = wikiDir;
		applied.push("core.wikiDir");
	}

	const openclaw: Record<string, unknown> = {
		enabled: true,
		...((next.adapters.openclaw as Record<string, unknown> | undefined) || {}),
	};
	const previousInstallState =
		(openclaw.installOrchestration as Record<string, unknown> | undefined) ||
		{};
	openclaw.installOrchestration = previousInstallState;
	next.adapters.openclaw = openclaw;

	return { config: next, applied };
}

function persistConfigIfChanged(
	path: string,
	before: AsmSharedConfig,
	after: AsmSharedConfig,
): boolean {
	const beforeText = `${JSON.stringify(before, null, 2)}\n`;
	const afterText = `${JSON.stringify(after, null, 2)}\n`;
	if (beforeText === afterText) return false;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, afterText, "utf8");
	return true;
}

export function runInstallOrchestration(
	input: InstallOrchestrationInput,
): InstallOrchestrationResult {
	const before = cloneConfig(input.config || {});
	const ensured = ensureRuntimeConfigDefaults(before, input.homeDir);
	const next = ensured.config;
	const core = (next.core || {}) as Record<string, unknown>;
	const projectWorkspaceRoot = text(core.projectWorkspaceRoot);
	const cwd = text(input.cwd) || process.cwd();
	const wikiDir = text(core.wikiDir);
	const scan = scanAgentSurfaces({ projectWorkspaceRoot, cwd });
	const targetSurfaces = input.ensureAgentSurfaceTargets
		? scan.surfaces.filter((surface) => surface.kind === "agents_md")
		: scan.surfaces.filter((surface) => surface.exists);
	const patches = targetSurfaces.map((surface) =>
		patchReinforcementSurface(surface.path, {
			createIfMissing:
				input.ensureAgentSurfaceTargets && surface.kind === "agents_md",
		}),
	);
	const surfacesCreated = patches
		.filter((item) => item.status === "created")
		.map((item) => item.path);
	const surfacesPatched = patches
		.filter((item) => item.status === "patched" || item.status === "updated")
		.map((item) => item.path);
	const surfacesAlreadyCurrent = patches
		.filter((item) => item.status === "already-current")
		.map((item) => item.path);
	const wikiBootstrap = ensureWikiBootstrapSurface(wikiDir);

	const openclaw = {
		...(((next.adapters || {}).openclaw as
			| Record<string, unknown>
			| undefined) || {}),
	};
	const previousState =
		(openclaw.installOrchestration as Record<string, unknown> | undefined) ||
		{};
	const hasPreviousState = Object.keys(previousState).length > 0;
	const appliedTimestamp =
		typeof previousState.lastAppliedAt === "string" &&
		previousState.lastAppliedAt
			? previousState.lastAppliedAt
			: (input.now || new Date()).toISOString();
	const nextState = {
		blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
		lastAppliedAt:
			surfacesCreated.length > 0 ||
			surfacesPatched.length > 0 ||
			wikiBootstrap.createdFiles.length > 0 ||
			!hasPreviousState
				? (input.now || new Date()).toISOString()
				: appliedTimestamp,
		patchedSurfaces: targetSurfaces.map((surface) => ({
			path: toPortablePath(surface.path, input.homeDir),
			kind: surface.kind,
			scope: surface.scope,
			status:
				patches.find((item) => item.path === surface.path)?.status ||
				"missing-target",
		})),
		workspaceRoot: toPortablePath(projectWorkspaceRoot, input.homeDir),
		configPath: toPortablePath(input.configPath, input.homeDir),
		wikiDir: toPortablePath(wikiDir, input.homeDir),
		wikiBootstrap: {
			createdFiles: wikiBootstrap.createdFiles.map((path) =>
				toPortablePath(path, input.homeDir),
			),
			alreadyPresentFiles: wikiBootstrap.alreadyPresentFiles.map((path) =>
				toPortablePath(path, input.homeDir),
			),
			ensuredDirs: wikiBootstrap.ensuredDirs.map((path) =>
				toPortablePath(path, input.homeDir),
			),
		},
	};
	openclaw.installOrchestration = nextState;
	next.adapters = {
		...(next.adapters || {}),
		openclaw,
	};

	const configChanged = persistConfigIfChanged(
		input.configPath,
		input.config,
		next,
	);
	if (input.log) {
		for (const field of ensured.applied) {
			input.log(`[ASM-104] install orchestration defaulted ${field}`);
		}
		for (const path of surfacesCreated) {
			input.log(`[ASM-104] created reinforcement surface: ${path}`);
		}
		for (const path of surfacesPatched) {
			input.log(`[ASM-104] patched reinforcement surface: ${path}`);
		}
		for (const path of surfacesAlreadyCurrent) {
			input.log(`[ASM-104] reinforcement surface already current: ${path}`);
		}
		for (const path of wikiBootstrap.createdFiles) {
			input.log(`[ASM-104] created wiki bootstrap file: ${path}`);
		}
		for (const path of wikiBootstrap.alreadyPresentFiles) {
			input.log(`[ASM-104] wiki bootstrap file already present: ${path}`);
		}
	}

	return {
		config: next,
		configChanged,
		runtimeDefaultsApplied: ensured.applied,
		surfacesScanned: scan.surfaces.map((surface) => surface.path),
		surfacesCreated,
		surfacesPatched,
		surfacesAlreadyCurrent,
		wikiFilesCreated: wikiBootstrap.createdFiles,
		wikiFilesAlreadyPresent: wikiBootstrap.alreadyPresentFiles,
		wikiDirsEnsured: wikiBootstrap.ensuredDirs,
		blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
	};
}
