import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	ensureQmdCatalog,
	type QmdCatalogEntry,
	type QmdLayer,
	queryQmdCatalogEntries,
	readQmdCatalog,
	upsertQmdCatalogEntry,
} from "./qmd-catalog.js";

const DEFAULT_MAX_ENTRIES_PER_SHARD = 200;
const DEFAULT_MAX_BYTES_PER_SHARD = 256 * 1024;

export interface ParsedQmdMemoryEntry {
	id: string;
	timestamp: string;
	namespace: string;
	sourceType?: string;
	memoryScope?: string;
	memoryType?: string;
	promotionState?: string;
	confidence?: string;
	sessionId?: string;
	userId?: string;
	text: string;
}

export interface ParsedQmdDocument {
	frontmatter: Record<string, string>;
	body: string;
	title: string;
	entryBody: string;
	entries: ParsedQmdMemoryEntry[];
}

export interface QmdWriteInput {
	wikiRoot: string;
	layer: QmdLayer;
	namespace: string;
	memoryScope: string;
	memoryType: string;
	sourceAgent: string;
	sessionId?: string;
	userId?: string;
	pageKey: string;
	title: string;
	id: string;
	timestampIso: string;
	updatedAtIso: string;
	entryBlock: string;
	text: string;
	mode: "append" | "upsert";
	maxEntriesPerShard?: number;
	maxBytesPerShard?: number;
}

export interface QmdWriteResult {
	qmdRoot: string;
	relPath: string;
	layer: QmdLayer;
	shardKey: string;
	shardSeq: number;
	entryCount: number;
	updated: boolean;
	created: boolean;
	pageKey: string;
}

export interface LoadedQmdShard {
	layer: QmdLayer;
	namespace: string;
	pageKey: string;
	relPath: string;
	absPath: string;
	frontmatter: Record<string, string>;
	entries: ParsedQmdMemoryEntry[];
	entryBody: string;
	title: string;
}

function tokenizeHints(value: string): string[] {
	const dedup = new Set<string>();
	for (const token of String(value || "")
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/g)
		.map((part) => part.trim())) {
		if (token.length < 3) continue;
		dedup.add(token);
		if (dedup.size >= 64) break;
	}
	return Array.from(dedup);
}

function serializeFrontmatter(frontmatter: Record<string, string>): string {
	const lines = Object.entries(frontmatter)
		.filter(([, value]) => typeof value === "string" && value.trim().length > 0)
		.map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join("\n")}\n---\n`;
}

function parseFrontmatter(raw: string): {
	frontmatter: Record<string, string>;
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
	const frontmatter: Record<string, string> = {};

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

function extractEntryBody(
	body: string,
	title: string,
): { heading: string; entryBody: string } {
	const normalized = String(body || "").trim();
	if (!normalized) {
		return {
			heading: `# ${title}`,
			entryBody: "",
		};
	}

	const lines = normalized.split(/\r?\n/g);
	if (lines.length > 0 && lines[0].startsWith("# ")) {
		const heading = lines[0];
		const rest = lines.slice(1).join("\n").replace(/^\s+/, "");
		return { heading, entryBody: rest.trim() };
	}

	return {
		heading: `# ${title}`,
		entryBody: normalized,
	};
}

function parseEntryTimestamp(value: string | undefined): number {
	const parsed = Date.parse(String(value || ""));
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return 0;
}

export function parseQmdMemoryEntries(body: string): ParsedQmdMemoryEntry[] {
	const content = String(body || "");
	const entries: ParsedQmdMemoryEntry[] = [];
	const regex =
		/<!-- ASM-MEMORY-START:([^>]+) -->\n([\s\S]*?)\n<!-- ASM-MEMORY-END:\1 -->/g;
	for (const match of content.matchAll(regex)) {
		const id = String(match[1] || "").trim();
		if (!id) continue;
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
			namespace: fields.namespace || "",
			sourceType: fields.source_type,
			memoryScope: fields.memory_scope,
			memoryType: fields.memory_type,
			promotionState: fields.promotion_state,
			confidence: fields.confidence,
			sessionId: fields.sessionId,
			userId: fields.userId,
			text: textPart.trim(),
		});
	}
	return entries;
}

export function parseQmdDocument(
	raw: string,
	fallbackTitle: string,
): ParsedQmdDocument {
	const parsed = parseFrontmatter(raw);
	const normalizedBody = String(parsed.body || "").trim();
	const split = extractEntryBody(normalizedBody, fallbackTitle);
	const title =
		String(parsed.frontmatter.title || "").trim() ||
		split.heading.replace(/^#\s+/, "").trim() ||
		fallbackTitle;
	const entries = parseQmdMemoryEntries(split.entryBody);
	return {
		frontmatter: parsed.frontmatter,
		body: normalizedBody,
		title,
		entryBody: split.entryBody,
		entries,
	};
}

function upsertEntryBlock(
	body: string,
	id: string,
	entryBlock: string,
): { body: string; updated: boolean } {
	const trimmed = String(body || "").trim();
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

function buildQmdBody(heading: string, entryBody: string): string {
	const entries = String(entryBody || "").trim();
	if (!entries) return `${heading}\n`;
	return `${heading}\n\n${entries}\n`;
}

function getBucket(layer: QmdLayer, timestampIso: string): string {
	if (layer === "raw" || layer === "drafts") {
		return String(timestampIso || "").slice(0, 7) || "unknown";
	}
	return "stable";
}

function toSafePathSegment(value: string): string {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "unknown";
}

function buildShardRelPath(input: {
	layer: QmdLayer;
	namespace: string;
	pageKey: string;
	bucket: string;
	shardSeq: number;
}): string {
	const namespaceSegment = toSafePathSegment(input.namespace);
	const pageSegments = String(input.pageKey || "")
		.split("/")
		.map((segment) => toSafePathSegment(segment))
		.filter((segment) => segment.length > 0);
	const filename = `${toSafePathSegment(input.bucket)}--${Math.max(0, Math.floor(input.shardSeq))}.qmd`;
	return join(input.layer, namespaceSegment, ...pageSegments, filename).replace(
		/\\/g,
		"/",
	);
}

function parseShardSeqFromPath(relPath: string): number {
	const base = basename(relPath, ".qmd");
	const parts = base.split("--");
	if (parts.length < 2) return 0;
	const seq = Number(parts[parts.length - 1]);
	if (!Number.isFinite(seq) || seq < 0) return 0;
	return Math.floor(seq);
}

function computeTimeRange(entries: ParsedQmdMemoryEntry[]): {
	timeFrom?: string;
	timeTo?: string;
} {
	if (entries.length === 0) return {};
	const sorted = entries
		.slice()
		.sort(
			(a, b) =>
				parseEntryTimestamp(a.timestamp) - parseEntryTimestamp(b.timestamp),
		);
	return {
		timeFrom: sorted[0]?.timestamp,
		timeTo: sorted[sorted.length - 1]?.timestamp,
	};
}

export function resolveWikiQmdRoot(wikiRoot: string): string {
	if (basename(wikiRoot) === "wiki") {
		return join(dirname(wikiRoot), "wiki-qmd");
	}
	return join(wikiRoot, "wiki-qmd");
}

export function ensureWikiQmdBootstrap(wikiRoot: string): string {
	const qmdRoot = resolveWikiQmdRoot(wikiRoot);
	mkdirSync(qmdRoot, { recursive: true });
	for (const layer of ["raw", "drafts", "live", "briefings"] as QmdLayer[]) {
		mkdirSync(join(qmdRoot, layer), { recursive: true });
	}
	ensureQmdCatalog(qmdRoot);
	return qmdRoot;
}

export function writeQmdMemoryEntry(input: QmdWriteInput): QmdWriteResult {
	const qmdRoot = ensureWikiQmdBootstrap(input.wikiRoot);
	const maxEntries =
		typeof input.maxEntriesPerShard === "number" && input.maxEntriesPerShard > 0
			? Math.floor(input.maxEntriesPerShard)
			: DEFAULT_MAX_ENTRIES_PER_SHARD;
	const maxBytes =
		typeof input.maxBytesPerShard === "number" && input.maxBytesPerShard > 0
			? Math.floor(input.maxBytesPerShard)
			: DEFAULT_MAX_BYTES_PER_SHARD;

	const bucket = getBucket(input.layer, input.timestampIso);
	const shardKey = `${input.layer}:${input.namespace}:${input.pageKey}:${bucket}`;

	const catalog = readQmdCatalog(qmdRoot);
	const sameShardEntries = catalog.shards
		.filter((entry) => entry.shard_key === shardKey)
		.sort((a, b) => b.shard_seq - a.shard_seq);

	const latestShard = sameShardEntries[0];
	const latestSeq = latestShard?.shard_seq ?? 0;
	let shardSeq = latestSeq;
	let relPath = latestShard?.path
		? latestShard.path
		: buildShardRelPath({
				layer: input.layer,
				namespace: input.namespace,
				pageKey: input.pageKey,
				bucket,
				shardSeq,
			});
	let absPath = join(qmdRoot, relPath);

	let title = input.title;
	let entryBody = "";
	let existingFrontmatter: Record<string, string> = {};
	if (existsSync(absPath)) {
		const parsed = parseQmdDocument(readFileSync(absPath, "utf8"), input.title);
		title = parsed.title || input.title;
		entryBody = parsed.entryBody;
		existingFrontmatter = parsed.frontmatter;
	}

	let updateResult: { body: string; updated: boolean };
	if (input.mode === "upsert") {
		updateResult = upsertEntryBlock(entryBody, input.id, input.entryBlock);
	} else {
		const prefix = entryBody.trim().length > 0 ? `${entryBody.trim()}\n\n` : "";
		updateResult = {
			body: `${prefix}${input.entryBlock}`,
			updated: false,
		};
	}

	let nextEntryBody = updateResult.body;
	let nextEntries = parseQmdMemoryEntries(nextEntryBody);

	const provisionalFrontmatter: Record<string, string> = {
		qmd_version: "1",
		schema_version: String(
			existingFrontmatter.schema_version || "memory_foundation_v1",
		),
		layer: input.layer,
		namespace: input.namespace,
		memory_scope: input.memoryScope,
		memory_type: input.memoryType,
		source_agent: input.sourceAgent,
		session_id: input.sessionId || "",
		user_id: input.userId || "",
		page_key: input.pageKey,
		shard_key: shardKey,
		shard_seq: String(shardSeq),
		entry_count: String(nextEntries.length),
		time_from: "",
		time_to: "",
		updated_at: input.updatedAtIso,
		title,
	};

	const provisionalContent = `${serializeFrontmatter(provisionalFrontmatter)}\n${buildQmdBody(`# ${title}`, nextEntryBody)}`;
	const exceedsLimits =
		!updateResult.updated &&
		(nextEntries.length > maxEntries ||
			Buffer.byteLength(provisionalContent, "utf8") > maxBytes);

	if (exceedsLimits) {
		shardSeq = latestSeq + 1;
		relPath = buildShardRelPath({
			layer: input.layer,
			namespace: input.namespace,
			pageKey: input.pageKey,
			bucket,
			shardSeq,
		});
		absPath = join(qmdRoot, relPath);
		title = input.title;
		nextEntryBody = input.entryBlock;
		nextEntries = parseQmdMemoryEntries(nextEntryBody);
		existingFrontmatter = {};
	}

	const range = computeTimeRange(nextEntries);
	const frontmatter: Record<string, string> = {
		qmd_version: "1",
		schema_version: String(
			existingFrontmatter.schema_version || "memory_foundation_v1",
		),
		layer: input.layer,
		namespace: input.namespace,
		memory_scope: input.memoryScope,
		memory_type: input.memoryType,
		source_agent: input.sourceAgent,
		session_id: input.sessionId || "",
		user_id: input.userId || "",
		page_key: input.pageKey,
		shard_key: shardKey,
		shard_seq: String(shardSeq),
		entry_count: String(nextEntries.length),
		time_from:
			range.timeFrom || existingFrontmatter.time_from || input.timestampIso,
		time_to: range.timeTo || input.timestampIso,
		updated_at: input.updatedAtIso,
		title,
	};

	const fileContent = `${serializeFrontmatter(frontmatter)}\n${buildQmdBody(`# ${title}`, nextEntryBody)}`;
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(absPath, fileContent, "utf8");

	let fileBytes = 0;
	try {
		fileBytes = statSync(absPath).size;
	} catch {
		fileBytes = Buffer.byteLength(fileContent, "utf8");
	}
	if (fileBytes > maxBytes && !updateResult.updated && nextEntries.length > 1) {
		// safety: if single-shard write still violated due to inherited content, keep written state
		// and rely on next write rollover. This avoids destructive truncation.
	}

	const tokenHints = tokenizeHints(
		`${input.text} ${title} ${input.namespace} ${input.pageKey}`,
	);
	const catalogEntry: QmdCatalogEntry = {
		shard_key: shardKey,
		path: relPath,
		layer: input.layer,
		namespace: input.namespace,
		session_id: input.sessionId,
		user_id: input.userId,
		entry_count: nextEntries.length,
		time_from: frontmatter.time_from,
		time_to: frontmatter.time_to,
		updated_at: frontmatter.updated_at,
		token_hints: tokenHints,
		page_key: input.pageKey,
		shard_seq: shardSeq,
	};
	upsertQmdCatalogEntry(qmdRoot, catalogEntry);

	return {
		qmdRoot,
		relPath,
		layer: input.layer,
		shardKey,
		shardSeq,
		entryCount: nextEntries.length,
		updated: updateResult.updated,
		created: !updateResult.updated,
		pageKey: input.pageKey,
	};
}

export function loadQmdShards(input: {
	wikiRoot: string;
	query: string;
	layers: QmdLayer[];
	namespaces: string[];
	limit: number;
	userId?: string;
	preferredSessionId?: string;
	sessionMode: "strict" | "soft";
}): LoadedQmdShard[] {
	const qmdRoot = ensureWikiQmdBootstrap(input.wikiRoot);
	const candidates = queryQmdCatalogEntries({
		qmdRoot,
		query: input.query,
		layers: input.layers,
		namespaces: input.namespaces,
		limit: Math.max(input.limit * 4, 24),
		userId: input.userId,
		preferredSessionId: input.preferredSessionId,
		sessionMode: input.sessionMode,
	});

	const shards: LoadedQmdShard[] = [];
	for (const candidate of candidates) {
		const absPath = join(qmdRoot, candidate.path);
		if (!existsSync(absPath)) continue;
		let raw = "";
		try {
			raw = readFileSync(absPath, "utf8");
		} catch {
			continue;
		}
		const parsed = parseQmdDocument(raw, `${candidate.layer} memory`);
		shards.push({
			layer: candidate.layer,
			namespace: candidate.namespace,
			pageKey: candidate.page_key,
			relPath: candidate.path,
			absPath,
			frontmatter: parsed.frontmatter,
			entries: parsed.entries,
			entryBody: parsed.entryBody,
			title: parsed.title,
		});
		if (shards.length >= Math.max(input.limit * 4, 24)) break;
	}

	return shards;
}

export function loadQmdEntriesForPage(input: {
	wikiRoot: string;
	layer: QmdLayer;
	namespace: string;
	pageKey: string;
}): ParsedQmdMemoryEntry[] {
	const qmdRoot = ensureWikiQmdBootstrap(input.wikiRoot);
	const catalog = readQmdCatalog(qmdRoot);
	const shards = catalog.shards
		.filter(
			(entry) =>
				entry.layer === input.layer &&
				entry.namespace === input.namespace &&
				entry.page_key === input.pageKey,
		)
		.sort((a, b) => {
			const aTime = Date.parse(a.updated_at || "") || 0;
			const bTime = Date.parse(b.updated_at || "") || 0;
			if (bTime !== aTime) return bTime - aTime;
			return a.shard_seq - b.shard_seq;
		});

	const entries: ParsedQmdMemoryEntry[] = [];
	for (const shard of shards) {
		const absPath = join(qmdRoot, shard.path);
		if (!existsSync(absPath)) continue;
		let raw = "";
		try {
			raw = readFileSync(absPath, "utf8");
		} catch {
			continue;
		}
		const parsed = parseQmdDocument(raw, `${input.layer} memory`);
		entries.push(...parsed.entries);
	}

	return entries;
}

export function countQmdFiles(wikiRoot: string): number {
	const qmdRoot = resolveWikiQmdRoot(wikiRoot);
	if (!existsSync(qmdRoot)) return 0;
	const catalog = readQmdCatalog(qmdRoot);
	return catalog.shards.filter((entry) =>
		entry.path.toLowerCase().endsWith(".qmd"),
	).length;
}
