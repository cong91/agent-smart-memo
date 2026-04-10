import crypto from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolveAsmCoreProjectWorkspaceRoot } from "../../shared/asm-config.js";
import {
	getAgentNamespaces,
	type MemoryNamespace,
	parseExplicitNamespace,
	resolveDefaultConfidence,
	resolveMemoryScopeFromNamespace,
	resolveMemoryTypeFromNamespace,
	toCoreAgent,
} from "../../shared/memory-config.js";
import type { MemoryContext } from "../contracts/adapter-contracts.js";
import { MEMORY_FOUNDATION_SCHEMA_VERSION } from "../migrations/memory-foundation-migration.js";
import {
	normalizeSessionToken,
	resolveSessionMode,
	scoreSemanticCandidate,
	shouldApplyStrictSessionFilter,
} from "../retrieval-policy.js";
import type { QmdLayer } from "./qmd-catalog.js";
import {
	ensureWikiQmdBootstrap,
	loadQmdEntriesForPage,
	loadQmdShards,
	writeQmdMemoryEntry,
} from "./qmd-store.js";

export interface MemoryCapturePayload {
	text: string;
	namespace?: string;
	sessionId?: string;
	userId?: string;
	timestamp?: number | string;
	updatedAt?: number | string;
	metadata?: Record<string, unknown>;
}

export interface MemorySearchPayload {
	query: string;
	limit?: number;
	minScore?: number;
	namespace?: string;
	sessionId?: string;
	sessionMode?: "strict" | "soft";
	userId?: string;
	sourceAgent?: string;
	includeDrafts?: boolean;
	includeRaw?: boolean;
}

export interface MemoryCaptureResult {
	id: string;
	created: boolean;
	updated: boolean;
	namespace: MemoryNamespace;
	score?: number;
}

export interface MemorySearchResult {
	query: string;
	count: number;
	results: Array<{
		id: string;
		score: number;
		rawScore: number;
		text: string;
		namespace: string;
		timestamp?: number;
		metadata?: Record<string, unknown>;
	}>;
}

export interface WikiMemorySearchInput {
	query: string;
	limit: number;
	minScore: number;
	namespaces: MemoryNamespace[];
	sourceAgent: string;
	sessionMode: "strict" | "soft";
	preferredSessionId?: string;
	userId?: string;
	sourceAgentFilter?: string;
	includeDrafts?: boolean;
	includeRaw?: boolean;
}

export interface WikiMemorySearchResultItem {
	id: string;
	score: number;
	rawScore: number;
	text: string;
	namespace: string;
	timestamp?: number;
	metadata?: Record<string, unknown>;
}

export interface WikiWorkingSetPage {
	path: string;
	title: string;
	kind: "entrypoint" | "canonical" | "task" | "rule" | "runbook" | "supporting";
	layer: "index" | "briefings" | "live" | "drafts" | "raw" | "qmd";
	reason: string;
	updatedAt?: number;
	namespace?: string;
}

export interface WikiWorkingSetInput {
	namespaces: MemoryNamespace[];
	sourceAgent: string;
	query?: string;
	userId?: string;
	preferredSessionId?: string;
	currentProject?: string;
	currentTask?: string;
	phase?: string;
	focus?: string;
	activeTaskHints?: string[];
	graphSignals?: string[];
	includeDrafts?: boolean;
	includeRaw?: boolean;
}

export interface WikiWorkingSetGraphAssist {
	matchedSignals: string[];
	expandedPages: WikiWorkingSetPage[];
}

export interface WikiWorkingSetResult {
	wikiRoot: string;
	entrypoint: string;
	canonicalPages: WikiWorkingSetPage[];
	taskPages: WikiWorkingSetPage[];
	rulePages: WikiWorkingSetPage[];
	runbookPages: WikiWorkingSetPage[];
	supportingPages: WikiWorkingSetPage[];
	graphAssist: WikiWorkingSetGraphAssist;
}

interface WikiFrontmatter {
	namespace?: string;
	sessionId?: string;
	userId?: string;
	source_agent?: string;
	timestamp?: string;
	updatedAt?: string;
	title?: string;
	[key: string]: string | undefined;
}

interface WikiPageDocument {
	absPath: string;
	relPath: string;
	frontmatter: WikiFrontmatter;
	body: string;
	namespace: MemoryNamespace;
	timestamp?: number;
}

interface RankedWorkingSetCandidate {
	path: string;
	title: string;
	layer: WikiWorkingSetPage["layer"];
	namespace: string;
	updatedAt?: number;
	score: number;
	pathScore: number;
	graphSignalHits: number;
	kindSignals: Set<"canonical" | "task" | "rule" | "runbook">;
	reasons: string[];
}

interface WikiMemoryWriteInput {
	text: string;
	namespace: MemoryNamespace;
	sourceAgent: string;
	sourceType: string;
	memoryScope: string;
	memoryType: string;
	promotionState?: string;
	confidence: number;
	timestamp?: number | string;
	updatedAt?: number | string;
	sessionId?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	wikiRoot?: string;
}

interface WikiMemoryWriteResult {
	id: string;
	created: boolean;
	updated: boolean;
	namespace: MemoryNamespace;
	wikiRoot: string;
	rawPath: string;
	draftPath: string;
	livePath: string;
	briefingPath: string;
}

function tokenize(value: string): string[] {
	return String(value || "")
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3);
}

function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function lexicalWikiScore(query: string, haystack: string): number {
	const q = String(query || "")
		.trim()
		.toLowerCase();
	const h = String(haystack || "").toLowerCase();
	if (!q || !h) return 0;

	const queryTokens = tokenize(q);
	if (queryTokens.length === 0) {
		return h.includes(q) ? 0.9 : 0;
	}

	const hits = queryTokens.filter((token) => h.includes(token)).length;
	const coverage = hits / queryTokens.length;
	const phraseBoost = h.includes(q) ? 0.2 : 0;

	return clampScore(coverage * 0.85 + phraseBoost);
}

function parseWikiFrontmatter(raw: string): {
	frontmatter: WikiFrontmatter;
	body: string;
} {
	const content = String(raw || "");
	if (!content.startsWith("---\n")) {
		return { frontmatter: {}, body: content };
	}

	const endMarker = "\n---\n";
	const end = content.indexOf(endMarker, 4);
	if (end < 0) {
		return { frontmatter: {}, body: content };
	}

	const frontmatterRaw = content.slice(4, end);
	const body = content.slice(end + endMarker.length);
	const frontmatter: WikiFrontmatter = {};

	for (const line of frontmatterRaw.split(/\r?\n/g)) {
		const sep = line.indexOf(":");
		if (sep <= 0) continue;
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (!key || !value) continue;
		frontmatter[key] = value;
	}

	return { frontmatter, body };
}

function parseTimestamp(
	frontmatter: WikiFrontmatter,
	absPath: string,
): number | undefined {
	for (const key of ["updatedAt", "timestamp"]) {
		const value = frontmatter[key];
		if (!value) continue;
		const asNumber = Number(value);
		if (Number.isFinite(asNumber) && asNumber > 0) {
			return asNumber;
		}
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}

	try {
		return statSync(absPath).mtimeMs;
	} catch {
		return undefined;
	}
}

function inferNamespaceFromWikiPath(
	relPath: string,
	fallback: MemoryNamespace,
	sourceAgent: string,
): MemoryNamespace {
	const normalized = relPath.replace(/\\/g, "/").toLowerCase();
	if (normalized.startsWith("briefings/")) {
		return "shared.project_context";
	}
	if (
		normalized.startsWith("live/projects/") ||
		normalized.startsWith("drafts/projects/")
	) {
		return "shared.project_context";
	}
	if (
		normalized.startsWith("live/concepts/") ||
		normalized.startsWith("drafts/concepts/")
	) {
		return `agent.${sourceAgent}.lessons` as MemoryNamespace;
	}
	if (
		normalized.startsWith("live/entities/") ||
		normalized.startsWith("drafts/entities/")
	) {
		return `agent.${sourceAgent}.working_memory` as MemoryNamespace;
	}
	if (normalized === "index.md") {
		return "shared.project_context";
	}
	return fallback;
}

function normalizeOptionalToken(value: unknown): string | undefined {
	const normalized = normalizeSessionToken(value);
	return normalized.length > 0 ? normalized : undefined;
}

function resolveWikiRootPath(options?: {
	create?: boolean;
	preferredRoot?: string;
}): string | null {
	const preferredRoot =
		typeof options?.preferredRoot === "string"
			? options.preferredRoot.trim()
			: "";
	if (preferredRoot) {
		const resolved = resolve(preferredRoot);
		if (existsSync(resolved)) return resolved;
		if (options?.create) return resolved;
	}

	const explicitRoot =
		typeof process.env.ASM_WIKI_ROOT === "string"
			? process.env.ASM_WIKI_ROOT.trim()
			: "";
	if (explicitRoot) {
		const resolved = resolve(explicitRoot);
		if (existsSync(resolved)) return resolved;
		if (options?.create) return resolved;
	}

	const candidates: string[] = [];

	const envWorkspace =
		typeof process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT === "string"
			? process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT.trim()
			: "";
	if (envWorkspace) {
		candidates.push(join(resolve(envWorkspace), "memory", "wiki"));
	}

	const configWorkspace = resolveAsmCoreProjectWorkspaceRoot({
		env: process.env,
		homeDir: process.env.HOME,
	});
	if (configWorkspace) {
		candidates.push(join(resolve(configWorkspace), "memory", "wiki"));
	}

	candidates.push(join(process.cwd(), "memory", "wiki"));

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	if (options?.create && candidates.length > 0) {
		return candidates[0];
	}

	return null;
}

function resolveWikiEntrypoint(wikiRoot: string): string {
	const primary = join(wikiRoot, "index.md");
	if (existsSync(primary)) return "index.md";

	for (const candidate of [
		"briefings/index.md",
		"live/index.md",
		"drafts/index.md",
	]) {
		if (existsSync(join(wikiRoot, candidate))) return candidate;
	}

	return "index.md";
}

function slugifySegment(value: string | undefined, fallback: string): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || fallback;
}

function uniqueNormalized(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const raw of values) {
		const value = String(raw || "").trim();
		if (!value) continue;
		const normalized = value.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(value);
	}
	return ordered;
}

function getWikiLayerFromPath(relPath: string): WikiWorkingSetPage["layer"] {
	const normalized = relPath.replace(/\\/g, "/").toLowerCase();
	if (normalized === "index.md") return "index";
	if (normalized.startsWith("briefings/")) return "briefings";
	if (normalized.startsWith("live/")) return "live";
	if (normalized.startsWith("drafts/")) return "drafts";
	if (normalized.startsWith("raw/")) return "raw";
	return "live";
}

function classifyWikiPageTraits(
	relPath: string,
	title: string,
	body: string,
): {
	isRule: boolean;
	isRunbook: boolean;
	isProjectScoped: boolean;
} {
	const haystack = `${relPath} ${title} ${body}`.toLowerCase();
	return {
		isRule:
			/(^|\b)(rule|rules|policy|policies|guardrail|guardrails|convention|conventions|standard|standards)(\b|$)/.test(
				haystack,
			),
		isRunbook:
			/(^|\b)(runbook|runbooks|playbook|playbooks|checklist|checklists|procedure|procedures)(\b|$)/.test(
				haystack,
			),
		isProjectScoped:
			relPath.startsWith("briefings/") ||
			relPath.startsWith("live/projects/") ||
			relPath.startsWith("drafts/projects/"),
	};
}

function compareWorkingSetCandidates(
	a: RankedWorkingSetCandidate,
	b: RankedWorkingSetCandidate,
): number {
	const byScore = b.score - a.score;
	if (byScore !== 0) return byScore;
	const byGraphSignals = b.graphSignalHits - a.graphSignalHits;
	if (byGraphSignals !== 0) return byGraphSignals;
	const byPathScore = b.pathScore - a.pathScore;
	if (byPathScore !== 0) return byPathScore;
	const byTime = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
	if (byTime !== 0) return byTime;
	return a.path.localeCompare(b.path);
}

function toWorkingSetPage(
	candidate: RankedWorkingSetCandidate,
	kind: WikiWorkingSetPage["kind"],
	reason: string,
): WikiWorkingSetPage {
	return {
		path: candidate.path,
		title: candidate.title,
		kind,
		layer: candidate.layer,
		reason,
		updatedAt: candidate.updatedAt,
		namespace: candidate.namespace,
	};
}

function chooseWorkingSetPages(
	candidates: RankedWorkingSetCandidate[],
	filter: (candidate: RankedWorkingSetCandidate) => boolean,
	limit: number,
	kind: WikiWorkingSetPage["kind"],
): WikiWorkingSetPage[] {
	const selected: WikiWorkingSetPage[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!filter(candidate)) continue;
		if (seen.has(candidate.path)) continue;
		selected.push(
			toWorkingSetPage(candidate, kind, candidate.reasons[0] || kind),
		);
		seen.add(candidate.path);
		if (selected.length >= limit) break;
	}
	return selected;
}

export function buildWikiWorkingSet(
	input: WikiWorkingSetInput,
): WikiWorkingSetResult | null {
	const wikiRoot = resolveWikiRootPath();
	if (!wikiRoot) return null;

	const docs = loadWikiDocuments(input.namespaces, input.sourceAgent, {
		includeDrafts: input.includeDrafts,
		includeRaw: input.includeRaw,
	});
	const entrypoint = resolveWikiEntrypoint(wikiRoot);

	const signals = uniqueNormalized([
		input.currentProject,
		input.currentTask,
		input.phase,
		input.focus,
		...(input.activeTaskHints || []),
		input.query,
	]);
	const graphSignals = uniqueNormalized(input.graphSignals || []);
	const graphTokenSet = new Set(
		graphSignals.flatMap((signal) => tokenize(signal.toLowerCase())),
	);
	const combinedSignalText = signals.join(" ");
	const projectSlug = slugifySegment(input.currentProject, "project");
	const taskSlug = slugifySegment(input.currentTask, "task");

	const ranked = docs
		.map((doc): RankedWorkingSetCandidate | null => {
			const title = String(doc.frontmatter.title || doc.relPath).trim();
			const compactBody = doc.body.replace(/\s+/g, " ").trim();
			const haystack = `${doc.relPath} ${title} ${compactBody}`;
			const traits = classifyWikiPageTraits(doc.relPath, title, compactBody);

			let score = 0;
			const reasons: string[] = [];
			const kindSignals = new Set<"canonical" | "task" | "rule" | "runbook">();
			const docTokens = new Set(tokenize(haystack));
			const graphSignalHits = [...graphTokenSet].filter((token) =>
				docTokens.has(token),
			).length;

			if (doc.relPath === entrypoint) {
				score += 1;
				reasons.push("wiki entrypoint");
				kindSignals.add("canonical");
			}

			if (doc.relPath.startsWith("briefings/")) {
				score += 0.45;
				reasons.push("briefing page");
				kindSignals.add("canonical");
			}

			if (traits.isProjectScoped) {
				score += 0.2;
				reasons.push("project-scoped page");
				kindSignals.add("canonical");
			}

			if (traits.isRule) {
				score += 0.18;
				reasons.push("rule/policy page");
				kindSignals.add("rule");
			}

			if (traits.isRunbook) {
				score += 0.18;
				reasons.push("runbook/checklist page");
				kindSignals.add("runbook");
			}

			if (combinedSignalText) {
				const signalScore = lexicalWikiScore(combinedSignalText, haystack);
				if (signalScore > 0) {
					score += signalScore;
					reasons.push("matched task/project signals");
				}
			}

			if (graphSignalHits > 0) {
				score += Math.min(0.24, graphSignalHits * 0.06);
				reasons.push("graph-assisted expansion hint");
			}

			const normalizedPath = doc.relPath.toLowerCase();
			if (
				input.currentProject &&
				(projectSlug !== "project" || input.currentProject.trim()) &&
				normalizedPath.includes(projectSlug)
			) {
				score += 0.35;
				reasons.push("project path match");
				kindSignals.add("canonical");
			}

			if (
				input.currentTask &&
				(taskSlug !== "task" || input.currentTask.trim()) &&
				normalizedPath.includes(taskSlug)
			) {
				score += 0.45;
				reasons.push("task path match");
				kindSignals.add("task");
			}

			if (
				input.currentTask &&
				lexicalWikiScore(input.currentTask, haystack) >= 0.6
			) {
				score += 0.3;
				reasons.push("task content match");
				kindSignals.add("task");
			}

			if (score <= 0) return null;

			return {
				path: doc.relPath,
				title,
				layer: getWikiLayerFromPath(doc.relPath),
				namespace: doc.namespace,
				updatedAt: doc.timestamp,
				score,
				pathScore: lexicalWikiScore(combinedSignalText || title, doc.relPath),
				graphSignalHits,
				kindSignals,
				reasons,
			};
		})
		.filter((candidate): candidate is RankedWorkingSetCandidate =>
			Boolean(candidate),
		)
		.sort(compareWorkingSetCandidates);

	const seen = new Set<string>();
	const canonicalPages: WikiWorkingSetPage[] = [];
	const entrypointCandidate = ranked.find(
		(candidate) => candidate.path === entrypoint,
	);
	if (entrypointCandidate) {
		canonicalPages.push(
			toWorkingSetPage(entrypointCandidate, "entrypoint", "wiki entrypoint"),
		);
		seen.add(entrypointCandidate.path);
	}

	for (const page of chooseWorkingSetPages(
		ranked,
		(candidate) =>
			candidate.kindSignals.has("canonical") && !seen.has(candidate.path),
		3,
		"canonical",
	)) {
		canonicalPages.push(page);
		seen.add(page.path);
	}

	const taskPages = chooseWorkingSetPages(
		ranked,
		(candidate) =>
			candidate.kindSignals.has("task") && !seen.has(candidate.path),
		3,
		"task",
	);
	taskPages.forEach((page) => seen.add(page.path));

	const rulePages = chooseWorkingSetPages(
		ranked,
		(candidate) =>
			candidate.kindSignals.has("rule") && !seen.has(candidate.path),
		3,
		"rule",
	);
	rulePages.forEach((page) => seen.add(page.path));

	const runbookPages = chooseWorkingSetPages(
		ranked,
		(candidate) =>
			candidate.kindSignals.has("runbook") && !seen.has(candidate.path),
		3,
		"runbook",
	);
	runbookPages.forEach((page) => seen.add(page.path));

	const supportingPages = chooseWorkingSetPages(
		ranked,
		(candidate) => !seen.has(candidate.path),
		4,
		"supporting",
	);
	supportingPages.forEach((page) => seen.add(page.path));

	const graphExpandedPages = chooseWorkingSetPages(
		ranked,
		(candidate) => candidate.graphSignalHits > 0 && !seen.has(candidate.path),
		2,
		"supporting",
	).map((page) => ({
		...page,
		reason: "graph-assisted expansion hint",
	}));

	return {
		wikiRoot,
		entrypoint,
		canonicalPages,
		taskPages,
		rulePages,
		runbookPages,
		supportingPages,
		graphAssist: {
			matchedSignals: graphSignals,
			expandedPages: graphExpandedPages,
		},
	};
}

function normalizeTextForId(value: string): string {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function computeWikiMemoryId(namespace: MemoryNamespace, text: string): string {
	return crypto
		.createHash("sha1")
		.update(`${namespace}\n${normalizeTextForId(text)}`)
		.digest("hex")
		.slice(0, 16);
}

function serializeFrontmatter(frontmatter: WikiFrontmatter): string {
	const lines = Object.entries(frontmatter)
		.filter(([, value]) => typeof value === "string" && value.trim().length > 0)
		.map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join("\n")}\n---\n`;
}

function writeMarkdownFile(
	absPath: string,
	frontmatter: WikiFrontmatter,
	body: string,
): void {
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(
		absPath,
		`${serializeFrontmatter(frontmatter)}\n${body.trimEnd()}\n`,
		"utf8",
	);
}

function ensureWikiBootstrap(wikiRoot: string): void {
	const dirs = [
		join(wikiRoot, "raw"),
		join(wikiRoot, "drafts", "projects"),
		join(wikiRoot, "drafts", "concepts"),
		join(wikiRoot, "drafts", "entities"),
		join(wikiRoot, "live", "projects"),
		join(wikiRoot, "live", "concepts"),
		join(wikiRoot, "live", "entities"),
		join(wikiRoot, "briefings"),
	];
	for (const dir of dirs) mkdirSync(dir, { recursive: true });

	const schemaPath = join(wikiRoot, "schema.md");
	if (!existsSync(schemaPath)) {
		writeFileSync(
			schemaPath,
			[
				"# ASM Wiki Memory Schema",
				"",
				"- `raw/`: append-only capture artifacts.",
				"- `drafts/`: intermediary layer before promotion to live.",
				"- `live/`: canonical grouped pages used for wiki-first semantic recall.",
				"- `briefings/`: concise summaries derived from live pages.",
				"- `index.md`: human-readable page index.",
				"- `log.md`: append-only write log.",
			].join("\n"),
			"utf8",
		);
	}

	const indexPath = join(wikiRoot, "index.md");
	if (!existsSync(indexPath)) {
		writeFileSync(
			indexPath,
			["# ASM Wiki Memory Index", "", "## Pages", ""].join("\n"),
			"utf8",
		);
	}

	const logPath = join(wikiRoot, "log.md");
	if (!existsSync(logPath)) {
		writeFileSync(logPath, "# ASM Wiki Memory Log\n\n", "utf8");
	}
}

type WikiStorageBackend = "md" | "qmd" | "dual_read_qmd_first";

function resolveWikiStorageBackend(): WikiStorageBackend {
	const raw = [
		process.env.ASM_WIKI_STORAGE_BACKEND,
		process.env.WIKI_STORAGE_BACKEND,
		process.env.wiki_storage_backend,
	]
		.map((value) =>
			String(value || "")
				.trim()
				.toLowerCase(),
		)
		.find((value) => value.length > 0);

	if (raw === "qmd") return "qmd";
	if (raw === "dual_read_qmd_first") return "dual_read_qmd_first";
	return "md";
}

function resolveWikiGroupingPaths(input: WikiMemoryWriteInput): {
	liveRelPath: string;
	draftRelPath: string;
	briefingRelPath: string;
	rawRelPath: string;
	pageKey: string;
	title: string;
} {
	const agentSlug = slugifySegment(input.sourceAgent, "assistant");
	const userSlug = slugifySegment(input.userId, "anon");
	const sessionSlug = slugifySegment(input.sessionId, "shared");
	const dateKey = new Date().toISOString().slice(0, 10);

	if (input.namespace === "shared.project_context") {
		return {
			liveRelPath: `live/projects/${userSlug}/${sessionSlug}.md`,
			draftRelPath: `drafts/projects/${userSlug}/${sessionSlug}.md`,
			briefingRelPath: `briefings/project-${userSlug}-${sessionSlug}.md`,
			rawRelPath: `raw/${dateKey}/project-${userSlug}-${sessionSlug}.md`,
			pageKey: `projects/${userSlug}/${sessionSlug}`,
			title: "Project Context Memory",
		};
	}

	if (String(input.namespace).endsWith(".lessons")) {
		return {
			liveRelPath: `live/concepts/${agentSlug}/${userSlug}-${sessionSlug}.md`,
			draftRelPath: `drafts/concepts/${agentSlug}/${userSlug}-${sessionSlug}.md`,
			briefingRelPath: `briefings/concepts-${agentSlug}-${userSlug}-${sessionSlug}.md`,
			rawRelPath: `raw/${dateKey}/concepts-${agentSlug}-${userSlug}-${sessionSlug}.md`,
			pageKey: `concepts/${agentSlug}/${userSlug}-${sessionSlug}`,
			title: `${input.sourceAgent} Lessons Memory`,
		};
	}

	return {
		liveRelPath: `live/entities/${agentSlug}/${userSlug}-${sessionSlug}.md`,
		draftRelPath: `drafts/entities/${agentSlug}/${userSlug}-${sessionSlug}.md`,
		briefingRelPath: `briefings/entities-${agentSlug}-${userSlug}-${sessionSlug}.md`,
		rawRelPath: `raw/${dateKey}/entities-${agentSlug}-${userSlug}-${sessionSlug}.md`,
		pageKey: `entities/${agentSlug}/${userSlug}-${sessionSlug}`,
		title: `${input.sourceAgent} Working Memory`,
	};
}

interface ParsedWikiMemoryEntry {
	id: string;
	timestamp: string;
	namespace?: string;
	text: string;
	sourceType?: string;
	memoryScope?: string;
	memoryType?: string;
	promotionState?: string;
	confidence?: string;
	sessionId?: string;
	userId?: string;
}

function parseWikiMemoryEntries(body: string): ParsedWikiMemoryEntry[] {
	const content = String(body || "");
	const entries: ParsedWikiMemoryEntry[] = [];
	const regex =
		/<!-- ASM-MEMORY-START:([^>]+) -->\n([\s\S]*?)\n<!-- ASM-MEMORY-END:\1 -->/g;
	for (const match of content.matchAll(regex)) {
		const id = String(match[1] || "").trim();
		const block = String(match[2] || "");
		const textMarker = "text:\n";
		const textIdx = block.indexOf(textMarker);
		const headerPart = textIdx >= 0 ? block.slice(0, textIdx) : block;
		const textPart =
			textIdx >= 0 ? block.slice(textIdx + textMarker.length) : "";
		const fields: Record<string, string> = {};
		for (const line of headerPart.split(/\r?\n/g)) {
			const sep = line.indexOf(":");
			if (sep <= 0) continue;
			fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
		}
		entries.push({
			id,
			timestamp: fields.timestamp || "",
			namespace: fields.namespace,
			text: textPart.trim(),
			sourceType: fields.source_type,
			memoryScope: fields.memory_scope,
			memoryType: fields.memory_type,
			promotionState: fields.promotion_state,
			confidence: fields.confidence,
			sessionId: fields.sessionId,
			userId: fields.userId,
		});
	}
	return entries;
}

function scoreEntryTimestamp(entry: ParsedWikiMemoryEntry): number {
	const parsed = Date.parse(entry.timestamp || "");
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return 0;
}

function compareEntriesDeterministically(
	a: ParsedWikiMemoryEntry,
	b: ParsedWikiMemoryEntry,
): number {
	const byTime = scoreEntryTimestamp(b) - scoreEntryTimestamp(a);
	if (byTime !== 0) return byTime;
	const byId = String(a.id || "").localeCompare(String(b.id || ""));
	if (byId !== 0) return byId;
	return String(a.text || "").localeCompare(String(b.text || ""));
}

function buildWikiMemoryEntry(
	input: WikiMemoryWriteInput,
	id: string,
	timestampIso: string,
): string {
	return [
		`<!-- ASM-MEMORY-START:${id} -->`,
		`timestamp: ${timestampIso}`,
		`namespace: ${input.namespace}`,
		`source_type: ${input.sourceType}`,
		`memory_scope: ${input.memoryScope}`,
		`memory_type: ${input.memoryType}`,
		`promotion_state: ${input.promotionState || "raw"}`,
		`confidence: ${String(input.confidence)}`,
		`sessionId: ${input.sessionId || ""}`,
		`userId: ${input.userId || ""}`,
		"text:",
		String(input.text || "").trim(),
		`<!-- ASM-MEMORY-END:${id} -->`,
	].join("\n");
}

function toIsoTimestamp(value: unknown, fallbackIso: string): string {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		const ms = value < 1_000_000_000_000 ? value * 1000 : value;
		const iso = new Date(ms).toISOString();
		if (iso !== "Invalid Date") return iso;
	}

	if (typeof value === "string" && value.trim().length > 0) {
		const trimmed = value.trim();
		const asNumber = Number(trimmed);
		if (Number.isFinite(asNumber) && asNumber > 0) {
			const ms = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
			const iso = new Date(ms).toISOString();
			if (iso !== "Invalid Date") return iso;
		}

		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed) && parsed > 0) {
			const iso = new Date(parsed).toISOString();
			if (iso !== "Invalid Date") return iso;
		}
	}

	return fallbackIso;
}

function upsertWikiMemoryEntry(
	body: string,
	id: string,
	entryBlock: string,
): {
	body: string;
	updated: boolean;
} {
	const trimmed = String(body || "").trimEnd();
	const regex = new RegExp(
		`<!-- ASM-MEMORY-START:${id} -->\\n[\\s\\S]*?\\n<!-- ASM-MEMORY-END:${id} -->`,
		"g",
	);
	if (regex.test(trimmed)) {
		return {
			body: trimmed.replace(regex, entryBlock),
			updated: true,
		};
	}
	const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
	return {
		body: `${prefix}${entryBlock}`,
		updated: false,
	};
}

function refreshWikiIndex(
	wikiRoot: string,
	title: string,
	liveRelPath: string,
	briefingRelPath: string,
): void {
	const indexPath = join(wikiRoot, "index.md");
	const line = `- ${title}: [live](${liveRelPath}) | [briefing](${briefingRelPath})`;
	const existing = existsSync(indexPath)
		? readFileSync(indexPath, "utf8")
		: "# ASM Wiki Memory Index\n\n## Pages\n\n";
	if (!existing.includes(line)) {
		writeFileSync(indexPath, `${existing.trimEnd()}\n${line}\n`, "utf8");
	}
}

function appendWikiLog(wikiRoot: string, entry: string): void {
	appendFileSync(join(wikiRoot, "log.md"), `${entry}\n`, "utf8");
}

function supportsQmdWrite(backend: WikiStorageBackend): boolean {
	return backend === "qmd" || backend === "dual_read_qmd_first";
}

function toTimestampMs(value: string | number | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber) && asNumber > 0) {
			return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
		}
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function buildBriefingSummaryText(
	entries: ParsedWikiMemoryEntry[],
	fallbackTimestamp: string,
): string {
	if (entries.length === 0) {
		return `${fallbackTimestamp} — no live entries available yet`;
	}
	return entries
		.slice(0, 5)
		.map(
			(entry) =>
				`- ${entry.timestamp || fallbackTimestamp} — ${entry.text.replace(/\s+/g, " ").slice(0, 280)}`,
		)
		.join("\n");
}

export function writeWikiMemoryCapture(
	input: WikiMemoryWriteInput,
): WikiMemoryWriteResult {
	const wikiRoot = resolveWikiRootPath({
		create: true,
		preferredRoot: input.wikiRoot,
	});
	if (!wikiRoot) {
		throw new Error("wiki memory root could not be resolved");
	}
	ensureWikiBootstrap(wikiRoot);
	const backend = resolveWikiStorageBackend();
	if (supportsQmdWrite(backend)) {
		ensureWikiQmdBootstrap(wikiRoot);
	}

	const id = computeWikiMemoryId(input.namespace, input.text);
	const nowIso = new Date().toISOString();
	const timestampIso = toIsoTimestamp(input.timestamp, nowIso);
	const updatedAtIso = toIsoTimestamp(input.updatedAt, nowIso);
	const paths = resolveWikiGroupingPaths(input);
	const liveAbsPath = join(wikiRoot, paths.liveRelPath);
	const briefingAbsPath = join(wikiRoot, paths.briefingRelPath);
	const rawAbsPath = join(wikiRoot, paths.rawRelPath);

	const draftAbsPath = join(wikiRoot, paths.draftRelPath);

	const isLive = ["distilled", "promoted"].includes(
		input.promotionState || "raw",
	);
	const isDraft = ["raw", "draft"].includes(input.promotionState || "raw");
	const entryBlock = buildWikiMemoryEntry(input, id, timestampIso);

	const outputPaths = {
		rawPath: paths.rawRelPath,
		draftPath: paths.draftRelPath,
		livePath: paths.liveRelPath,
		briefingPath: paths.briefingRelPath,
	};

	let actionUpsert = { updated: false, body: "" };

	if (supportsQmdWrite(backend)) {
		const rawWrite = writeQmdMemoryEntry({
			wikiRoot,
			layer: "raw",
			namespace: input.namespace,
			memoryScope: input.memoryScope,
			memoryType: input.memoryType,
			sourceAgent: input.sourceAgent,
			sessionId: input.sessionId,
			userId: input.userId,
			pageKey: paths.pageKey,
			title: `${paths.title} Raw Capture`,
			id,
			timestampIso,
			updatedAtIso,
			entryBlock,
			text: input.text,
			mode: "append",
		});
		outputPaths.rawPath = rawWrite.relPath;

		if (isLive) {
			const liveWrite = writeQmdMemoryEntry({
				wikiRoot,
				layer: "live",
				namespace: input.namespace,
				memoryScope: input.memoryScope,
				memoryType: input.memoryType,
				sourceAgent: input.sourceAgent,
				sessionId: input.sessionId,
				userId: input.userId,
				pageKey: paths.pageKey,
				title: paths.title,
				id,
				timestampIso,
				updatedAtIso,
				entryBlock,
				text: input.text,
				mode: "upsert",
			});
			actionUpsert.updated = liveWrite.updated;
			outputPaths.livePath = liveWrite.relPath;

			const refreshedEntries = loadQmdEntriesForPage({
				wikiRoot,
				layer: "live",
				namespace: input.namespace,
				pageKey: paths.pageKey,
			})
				.map((entry) => ({
					id: entry.id,
					timestamp: entry.timestamp,
					namespace: entry.namespace,
					text: entry.text,
					sourceType: entry.sourceType,
					memoryScope: entry.memoryScope,
					memoryType: entry.memoryType,
					promotionState: entry.promotionState,
					confidence: entry.confidence,
					sessionId: entry.sessionId,
					userId: entry.userId,
				}))
				.sort(compareEntriesDeterministically);
			const briefingSummaryText = buildBriefingSummaryText(
				refreshedEntries,
				timestampIso,
			);
			const briefingId = computeWikiMemoryId(
				input.namespace,
				`briefing:${paths.pageKey}`,
			);
			const briefingBlock = buildWikiMemoryEntry(
				{
					...input,
					text: briefingSummaryText,
					sourceType: "briefing",
					promotionState: "distilled",
				},
				briefingId,
				timestampIso,
			);
			const briefingWrite = writeQmdMemoryEntry({
				wikiRoot,
				layer: "briefings",
				namespace: input.namespace,
				memoryScope: input.memoryScope,
				memoryType: input.memoryType,
				sourceAgent: input.sourceAgent,
				sessionId: input.sessionId,
				userId: input.userId,
				pageKey: paths.pageKey,
				title: `${paths.title} Briefing`,
				id: briefingId,
				timestampIso,
				updatedAtIso,
				entryBlock: briefingBlock,
				text: briefingSummaryText,
				mode: "upsert",
			});
			outputPaths.briefingPath = briefingWrite.relPath;
		} else if (isDraft) {
			const draftWrite = writeQmdMemoryEntry({
				wikiRoot,
				layer: "drafts",
				namespace: input.namespace,
				memoryScope: input.memoryScope,
				memoryType: input.memoryType,
				sourceAgent: input.sourceAgent,
				sessionId: input.sessionId,
				userId: input.userId,
				pageKey: paths.pageKey,
				title: `${paths.title} Draft`,
				id,
				timestampIso,
				updatedAtIso,
				entryBlock,
				text: input.text,
				mode: "upsert",
			});
			actionUpsert.updated = draftWrite.updated;
			outputPaths.draftPath = draftWrite.relPath;
		}
	}

	if (backend === "md" && isLive) {
		const existingLiveRaw = existsSync(liveAbsPath)
			? readFileSync(liveAbsPath, "utf8")
			: "";
		const existingLive = parseWikiFrontmatter(existingLiveRaw);
		actionUpsert = upsertWikiMemoryEntry(existingLive.body, id, entryBlock);

		const liveFrontmatter: WikiFrontmatter = {
			title: paths.title,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: existingLive.frontmatter.timestamp || timestampIso,
			updatedAt: updatedAtIso,
		};
		writeMarkdownFile(
			liveAbsPath,
			liveFrontmatter,
			`# ${paths.title}\n\n${actionUpsert.body}`,
		);

		const refreshedEntries = parseWikiMemoryEntries(
			parseWikiFrontmatter(readFileSync(liveAbsPath, "utf8")).body,
		).sort(compareEntriesDeterministically);
		const briefingBody = [
			`# ${paths.title} Briefing`,
			"",
			...refreshedEntries
				.slice(0, 5)
				.map(
					(entry) =>
						`- ${entry.timestamp || timestampIso} — ${entry.text.replace(/\s+/g, " ").slice(0, 280)}`,
				),
		].join("\n");
		writeMarkdownFile(
			briefingAbsPath,
			{
				title: `${paths.title} Briefing`,
				namespace: input.namespace,
				sessionId: input.sessionId,
				userId: input.userId,
				source_agent: input.sourceAgent,
				timestamp: timestampIso,
				updatedAt: updatedAtIso,
			},
			briefingBody,
		);
	} else if (backend === "md" && isDraft) {
		const existingDraftRaw = existsSync(draftAbsPath)
			? readFileSync(draftAbsPath, "utf8")
			: "";
		const existingDraft = parseWikiFrontmatter(existingDraftRaw);
		actionUpsert = upsertWikiMemoryEntry(existingDraft.body, id, entryBlock);

		const draftFrontmatter: WikiFrontmatter = {
			title: `${paths.title} Draft`,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: existingDraft.frontmatter.timestamp || timestampIso,
			updatedAt: updatedAtIso,
		};
		writeMarkdownFile(
			draftAbsPath,
			draftFrontmatter,
			`# ${paths.title} Draft\n\n${actionUpsert.body}`,
		);
	}

	if (backend === "md") {
		const rawFrontmatter: WikiFrontmatter = {
			title: `${paths.title} Raw Capture`,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: timestampIso,
			updatedAt: updatedAtIso,
		};
		if (!existsSync(rawAbsPath)) {
			writeMarkdownFile(
				rawAbsPath,
				rawFrontmatter,
				`# ${paths.title} Raw Capture`,
			);
		}
		appendFileSync(rawAbsPath, `\n\n${entryBlock}\n`, "utf8");
	}

	if (isLive) {
		refreshWikiIndex(
			wikiRoot,
			paths.title,
			outputPaths.livePath,
			outputPaths.briefingPath,
		);
	}

	const targetRelPath = isLive ? outputPaths.livePath : outputPaths.draftPath;
	appendWikiLog(
		wikiRoot,
		`- ${timestampIso} | ${actionUpsert.updated ? "updated" : "created"} | ${input.namespace} | ${id} | ${targetRelPath}`,
	);

	return {
		id,
		created: !actionUpsert.updated,
		updated: actionUpsert.updated,
		namespace: input.namespace,
		wikiRoot,
		rawPath: outputPaths.rawPath,
		draftPath: outputPaths.draftPath,
		livePath: outputPaths.livePath,
		briefingPath: outputPaths.briefingPath,
	};
}

function walkMarkdownFiles(rootDir: string): string[] {
	if (!existsSync(rootDir)) return [];
	const files: string[] = [];
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const entries = readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const absPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(absPath);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				files.push(absPath);
			}
		}
	}

	return files;
}

function loadWikiDocuments(
	namespaces: MemoryNamespace[],
	sourceAgent: string,
	options?: {
		includeDrafts?: boolean;
		includeRaw?: boolean;
	},
): WikiPageDocument[] {
	const wikiRoot = resolveWikiRootPath();
	if (!wikiRoot) return [];

	const selected = new Set<string>();
	const indexPath = join(wikiRoot, "index.md");
	if (existsSync(indexPath)) selected.add(indexPath);

	const folders = ["briefings", "live"];
	if (options?.includeDrafts) folders.push("drafts");
	if (options?.includeRaw) folders.push("raw");

	for (const folder of folders) {
		for (const file of walkMarkdownFiles(join(wikiRoot, folder))) {
			selected.add(file);
		}
	}

	if (selected.size === 0) return [];

	const fallbackNamespace =
		namespaces[0] || (`agent.${sourceAgent}.working_memory` as MemoryNamespace);

	const docs: WikiPageDocument[] = [];
	for (const absPath of selected) {
		let content = "";
		try {
			content = readFileSync(absPath, "utf8");
		} catch {
			continue;
		}

		const relPath = relative(wikiRoot, absPath).replace(/\\/g, "/");
		const parsed = parseWikiFrontmatter(content);

		let namespace = inferNamespaceFromWikiPath(
			relPath,
			fallbackNamespace,
			sourceAgent,
		);
		if (parsed.frontmatter.namespace) {
			try {
				namespace = parseExplicitNamespace(
					parsed.frontmatter.namespace,
					sourceAgent,
				);
			} catch {
				// keep inferred namespace when frontmatter contains unknown namespace value
			}
		}

		docs.push({
			absPath,
			relPath,
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			namespace,
			timestamp: parseTimestamp(parsed.frontmatter, absPath),
		});
	}

	return docs;
}

function compareWikiSearchResultsDeterministically(
	a: WikiMemorySearchResultItem,
	b: WikiMemorySearchResultItem,
): number {
	const byScore = b.score - a.score;
	if (byScore !== 0) return byScore;
	const aTs = Number(a.timestamp || 0);
	const bTs = Number(b.timestamp || 0);
	const byTime = bTs - aTs;
	if (byTime !== 0) return byTime;
	return String(a.id || "").localeCompare(String(b.id || ""));
}

function searchQmdMemory(
	input: WikiMemorySearchInput,
	normalizedPreferredSession: string | undefined,
	normalizedUser: string | undefined,
	normalizedSourceAgentFilter: string | undefined,
): WikiMemorySearchResultItem[] {
	const wikiRoot = resolveWikiRootPath();
	if (!wikiRoot) return [];

	const layers: QmdLayer[] = ["briefings", "live"];
	if (input.includeDrafts) layers.push("drafts");
	if (input.includeRaw) layers.push("raw");

	const shards = loadQmdShards({
		wikiRoot,
		query: input.query,
		layers,
		namespaces: input.namespaces,
		limit: input.limit,
		userId: input.userId,
		preferredSessionId: normalizedPreferredSession,
		sessionMode: input.sessionMode,
	});
	if (shards.length === 0) return [];

	const ranked: WikiMemorySearchResultItem[] = [];

	for (const shard of shards) {
		const fallbackTimestamp =
			toTimestampMs(
				shard.frontmatter.updated_at ||
					shard.frontmatter.updatedAt ||
					shard.frontmatter.time_to ||
					shard.frontmatter.timestamp,
			) || 0;
		const frontmatterSourceAgent = normalizeOptionalToken(
			shard.frontmatter.source_agent,
		);

		const entries = shard.entries;
		if (entries.length === 0) {
			const title = String(shard.frontmatter.title || shard.title || "").trim();
			const bodyCompact = String(shard.entryBody || "")
				.replace(/\s+/g, " ")
				.trim();
			if (!bodyCompact) continue;
			const rawScore = lexicalWikiScore(
				input.query,
				`${shard.relPath} ${title} ${bodyCompact}`,
			);
			if (rawScore <= 0) continue;
			const pseudoNamespace =
				(shard.frontmatter.namespace as MemoryNamespace | undefined) ||
				(shard.namespace as MemoryNamespace);
			if (!input.namespaces.includes(pseudoNamespace)) continue;
			const scored = scoreSemanticCandidate({
				rawScore,
				agentId: input.sourceAgent,
				namespace: pseudoNamespace,
				sessionMode: input.sessionMode,
				preferredSessionId: normalizedPreferredSession,
				payloadSessionId: normalizeOptionalToken(
					shard.frontmatter.session_id || shard.frontmatter.sessionId,
				),
				promotionState:
					shard.layer === "raw" || shard.layer === "drafts"
						? "raw"
						: "distilled",
			});
			const briefingBoost = shard.layer === "briefings" ? 0.05 : 0;
			const finalScore = clampScore(scored.finalScore + briefingBoost);
			if (finalScore < input.minScore) continue;
			ranked.push({
				id: `wiki-qmd:${shard.layer}:${shard.relPath}`,
				rawScore,
				score: finalScore,
				text: title
					? `${title} — ${bodyCompact.slice(0, 500)}`
					: bodyCompact.slice(0, 500),
				namespace: pseudoNamespace,
				timestamp: fallbackTimestamp,
				metadata: {
					source_type: "wiki_qmd",
					wiki_layer: shard.layer,
					wiki_path: shard.relPath,
					source_agent: frontmatterSourceAgent,
					namespace: pseudoNamespace,
				},
			});
			continue;
		}

		for (const entry of entries) {
			let namespace = shard.namespace as MemoryNamespace;
			const namespaceRaw = String(
				entry.namespace || shard.frontmatter.namespace || shard.namespace,
			).trim();
			if (namespaceRaw.length > 0) {
				try {
					namespace = parseExplicitNamespace(namespaceRaw, input.sourceAgent);
				} catch {
					namespace = shard.namespace as MemoryNamespace;
				}
			}
			if (!input.namespaces.includes(namespace)) continue;

			const entrySession = normalizeOptionalToken(
				entry.sessionId ||
					shard.frontmatter.session_id ||
					shard.frontmatter.sessionId,
			);
			if (
				shouldApplyStrictSessionFilter(
					input.sessionMode,
					normalizedPreferredSession,
				) &&
				entrySession !== normalizedPreferredSession
			) {
				continue;
			}

			const entryUser = normalizeOptionalToken(
				entry.userId || shard.frontmatter.user_id || shard.frontmatter.userId,
			);
			if (normalizedUser && entryUser !== normalizedUser) {
				continue;
			}

			const entrySourceAgent =
				normalizeOptionalToken(shard.frontmatter.source_agent) ||
				normalizeOptionalToken(input.sourceAgent);
			if (
				normalizedSourceAgentFilter &&
				entrySourceAgent !== normalizedSourceAgentFilter
			) {
				continue;
			}

			const title = String(shard.frontmatter.title || shard.title || "").trim();
			const bodyCompact = String(entry.text || "")
				.replace(/\s+/g, " ")
				.trim();
			if (!bodyCompact) continue;
			const rawScore = lexicalWikiScore(
				input.query,
				`${shard.relPath} ${title} ${bodyCompact} ${namespace}`,
			);
			if (rawScore <= 0) continue;

			const promotionState =
				entry.promotionState ||
				(shard.layer === "raw" || shard.layer === "drafts"
					? "raw"
					: "distilled");
			const scored = scoreSemanticCandidate({
				rawScore,
				agentId: input.sourceAgent,
				namespace,
				sessionMode: input.sessionMode,
				preferredSessionId: normalizedPreferredSession,
				payloadSessionId: entrySession,
				promotionState,
			});
			const briefingBoost = shard.layer === "briefings" ? 0.05 : 0;
			const finalScore = clampScore(scored.finalScore + briefingBoost);
			if (finalScore < input.minScore) continue;

			ranked.push({
				id: `wiki-qmd:${shard.layer}:${entry.id}:${shard.relPath}`,
				rawScore,
				score: finalScore,
				text: title
					? `${title}${bodyCompact ? ` — ${bodyCompact.slice(0, 500)}` : ""}`
					: bodyCompact,
				namespace,
				timestamp: toTimestampMs(entry.timestamp) || fallbackTimestamp,
				metadata: {
					source_type: "wiki_qmd",
					wiki_layer: shard.layer,
					wiki_path: shard.relPath,
					sessionId: entry.sessionId || shard.frontmatter.session_id,
					userId: entry.userId || shard.frontmatter.user_id,
					source_agent: shard.frontmatter.source_agent,
					namespace,
				},
			});
		}
	}

	return ranked
		.sort(compareWikiSearchResultsDeterministically)
		.slice(0, Math.max(1, input.limit));
}

export function searchWikiMemory(
	input: WikiMemorySearchInput,
): WikiMemorySearchResultItem[] {
	const query = String(input.query || "").trim();
	if (!query) return [];

	const normalizedPreferredSession = normalizeOptionalToken(
		input.preferredSessionId,
	);
	const normalizedUser = normalizeOptionalToken(input.userId);
	const normalizedSourceAgentFilter = normalizeOptionalToken(
		input.sourceAgentFilter,
	);
	const includeDrafts = Boolean(input.includeDrafts);
	const includeRaw = Boolean(input.includeRaw);

	const backend = resolveWikiStorageBackend();
	if (backend !== "md") {
		const qmdResults = searchQmdMemory(
			{ ...input, includeDrafts, includeRaw },
			normalizedPreferredSession,
			normalizedUser,
			normalizedSourceAgentFilter,
		);
		if (qmdResults.length > 0 || backend === "qmd") {
			return qmdResults;
		}
	}

	const docs = loadWikiDocuments(input.namespaces, input.sourceAgent, {
		includeDrafts,
		includeRaw,
	});
	if (docs.length === 0) return [];

	const ranked: WikiMemorySearchResultItem[] = [];

	for (const doc of docs) {
		if (!input.namespaces.includes(doc.namespace)) {
			continue;
		}

		const docSession = normalizeOptionalToken(doc.frontmatter.sessionId);
		if (
			shouldApplyStrictSessionFilter(
				input.sessionMode,
				normalizedPreferredSession,
			) &&
			docSession !== normalizedPreferredSession
		) {
			continue;
		}

		const docUser = normalizeOptionalToken(doc.frontmatter.userId);
		if (normalizedUser && docUser !== normalizedUser) {
			continue;
		}

		const docSourceAgent = normalizeOptionalToken(doc.frontmatter.source_agent);
		if (
			normalizedSourceAgentFilter &&
			docSourceAgent !== normalizedSourceAgentFilter
		) {
			continue;
		}

		const title = String(doc.frontmatter.title || "").trim();
		const bodyCompact = doc.body.replace(/\s+/g, " ").trim();
		const haystack = `${doc.relPath} ${title} ${bodyCompact}`;
		const rawScore = lexicalWikiScore(query, haystack);
		if (rawScore <= 0) continue;

		const scored = scoreSemanticCandidate({
			rawScore,
			agentId: input.sourceAgent,
			namespace: doc.namespace,
			sessionMode: input.sessionMode,
			preferredSessionId: normalizedPreferredSession,
			payloadSessionId: docSession,
			promotionState: "distilled",
		});

		const briefingBoost = doc.relPath.startsWith("briefings/") ? 0.05 : 0;
		const finalScore = clampScore(scored.finalScore + briefingBoost);
		if (finalScore < input.minScore) {
			continue;
		}

		const excerpt = bodyCompact.slice(0, 500);
		const text = title
			? `${title}${excerpt ? ` — ${excerpt}` : ""}`
			: excerpt || `Wiki memory from ${doc.relPath}`;

		ranked.push({
			id: `wiki:${doc.relPath}`,
			rawScore,
			score: finalScore,
			text,
			namespace: doc.namespace,
			timestamp: doc.timestamp,
			metadata: {
				source_type: "wiki",
				wiki_path: doc.relPath,
				sessionId: doc.frontmatter.sessionId,
				userId: doc.frontmatter.userId,
				source_agent: doc.frontmatter.source_agent,
				namespace: doc.namespace,
			},
		});
	}

	return ranked
		.sort(compareWikiSearchResultsDeterministically)
		.slice(0, Math.max(1, input.limit));
}

export class SemanticMemoryUseCase {
	constructor(..._legacyDeps: unknown[]) {}

	async capture(
		payload: MemoryCapturePayload,
		context: MemoryContext,
	): Promise<MemoryCaptureResult> {
		if (
			!payload?.text ||
			typeof payload.text !== "string" ||
			payload.text.trim().length === 0
		) {
			throw new Error("memory.capture requires payload.text");
		}

		const text = payload.text.trim();
		const sourceAgent = toCoreAgent(context.agentId || "assistant");
		const namespace = this.resolveNamespace(payload.namespace, sourceAgent);
		const memoryScope = resolveMemoryScopeFromNamespace(namespace);
		const memoryType = resolveMemoryTypeFromNamespace(namespace);
		const promotionState = "raw" as const;
		const defaultConfidence = resolveDefaultConfidence("manual");

		const wikiWrite = writeWikiMemoryCapture({
			text,
			namespace,
			sourceAgent,
			sourceType: "manual",
			memoryScope,
			memoryType,
			confidence: defaultConfidence,
			timestamp: payload.timestamp,
			updatedAt: payload.updatedAt,
			sessionId: payload.sessionId || context.sessionId,
			userId: payload.userId || context.userId,
			metadata: {
				schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
				promotion_state: promotionState,
				...(payload.metadata || {}),
			},
		});

		return {
			id: wikiWrite.id,
			created: wikiWrite.created,
			updated: wikiWrite.updated,
			namespace: wikiWrite.namespace,
		};
	}

	async search(
		payload: MemorySearchPayload,
		context: MemoryContext,
	): Promise<MemorySearchResult> {
		if (
			!payload?.query ||
			typeof payload.query !== "string" ||
			payload.query.trim().length === 0
		) {
			throw new Error("memory.search requires payload.query");
		}

		const query = payload.query.trim();
		const sourceAgent = toCoreAgent(context.agentId || "assistant");
		const minScore =
			typeof payload.minScore === "number" ? payload.minScore : 0.7;
		const sessionMode = resolveSessionMode(payload.sessionMode);
		const preferredSessionId = normalizeSessionToken(
			payload.sessionId || context.sessionId,
		);
		const limit = Math.min(Math.max(payload.limit || 5, 1), 20);
		const namespaces = payload.namespace
			? [this.resolveNamespace(payload.namespace, sourceAgent)]
			: getAgentNamespaces(sourceAgent);

		const wikiResults = searchWikiMemory({
			query,
			limit,
			minScore,
			namespaces,
			sourceAgent,
			sessionMode,
			preferredSessionId,
			userId: payload.userId || context.userId,
			sourceAgentFilter: payload.sourceAgent,
			includeDrafts: Boolean(payload.includeDrafts),
			includeRaw: Boolean(payload.includeRaw),
		});
		if (wikiResults.length > 0) {
			return {
				query,
				count: wikiResults.length,
				results: wikiResults,
			};
		}

		return {
			query,
			count: 0,
			results: [],
		};
	}

	private resolveNamespace(
		namespace: string | undefined,
		sourceAgent: string,
	): MemoryNamespace {
		if (typeof namespace === "string" && namespace.trim().length > 0) {
			return parseExplicitNamespace(namespace, sourceAgent);
		}
		return `agent.${sourceAgent}.working_memory` as MemoryNamespace;
	}
}
