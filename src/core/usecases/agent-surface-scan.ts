import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type AgentSurfaceKind = "agents_md" | "opencode_agents_md";

export interface AgentSurfaceTarget {
	path: string;
	kind: AgentSurfaceKind;
	scope: "workspace-root" | "current-working-directory";
	exists: boolean;
}

export interface ScanAgentSurfacesInput {
	projectWorkspaceRoot?: string;
	cwd?: string;
}

export interface ScanAgentSurfacesResult {
	surfaces: AgentSurfaceTarget[];
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeDir(value: unknown): string | null {
	const normalized = text(value);
	return normalized ? resolve(normalized) : null;
}

export function scanAgentSurfaces(
	input: ScanAgentSurfacesInput = {},
): ScanAgentSurfacesResult {
	const seen = new Set<string>();
	const surfaces: AgentSurfaceTarget[] = [];

	const candidates: Array<{
		baseDir: string | null;
		relativePath: string;
		kind: AgentSurfaceKind;
		scope: AgentSurfaceTarget["scope"];
	}> = [
		{
			baseDir: normalizeDir(input.projectWorkspaceRoot),
			relativePath: "AGENTS.md",
			kind: "agents_md",
			scope: "workspace-root",
		},
		{
			baseDir: normalizeDir(input.projectWorkspaceRoot),
			relativePath: join(".opencode", "AGENTS.md"),
			kind: "opencode_agents_md",
			scope: "workspace-root",
		},
		{
			baseDir: normalizeDir(input.cwd),
			relativePath: "AGENTS.md",
			kind: "agents_md",
			scope: "current-working-directory",
		},
		{
			baseDir: normalizeDir(input.cwd),
			relativePath: join(".opencode", "AGENTS.md"),
			kind: "opencode_agents_md",
			scope: "current-working-directory",
		},
	];

	const workspaceRoot = normalizeDir(input.projectWorkspaceRoot);
	if (workspaceRoot && existsSync(workspaceRoot)) {
		for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			candidates.push({
				baseDir: resolve(workspaceRoot, entry.name),
				relativePath: "AGENTS.md",
				kind: "agents_md",
				scope: "workspace-root",
			});
			candidates.push({
				baseDir: resolve(workspaceRoot, entry.name),
				relativePath: join(".opencode", "AGENTS.md"),
				kind: "opencode_agents_md",
				scope: "workspace-root",
			});
		}
	}

	for (const candidate of candidates) {
		if (!candidate.baseDir) continue;
		const path = resolve(candidate.baseDir, candidate.relativePath);
		if (seen.has(path)) continue;
		seen.add(path);
		surfaces.push({
			path,
			kind: candidate.kind,
			scope: candidate.scope,
			exists: existsSync(path),
		});
	}

	return { surfaces };
}
