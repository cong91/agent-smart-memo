import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type QmdLayer = "raw" | "drafts" | "live" | "briefings";

export interface QmdCatalogEntry {
	shard_key: string;
	path: string;
	layer: QmdLayer;
	namespace: string;
	session_id?: string;
	user_id?: string;
	entry_count: number;
	time_from?: string;
	time_to?: string;
	updated_at: string;
	token_hints: string[];
	page_key: string;
	shard_seq: number;
}

interface QmdCatalog {
	version: number;
	shards: QmdCatalogEntry[];
}

const DEFAULT_CATALOG: QmdCatalog = {
	version: 1,
	shards: [],
};

function normalizeTokenHints(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const dedup = new Set<string>();
	for (const token of value) {
		const normalized = String(token || "")
			.trim()
			.toLowerCase();
		if (normalized.length < 3) continue;
		dedup.add(normalized);
		if (dedup.size >= 64) break;
	}
	return Array.from(dedup);
}

function sanitizeCatalogEntry(raw: unknown): QmdCatalogEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const shardKey = String(item.shard_key || "").trim();
	const path = String(item.path || "").trim();
	const layer = String(item.layer || "").trim() as QmdLayer;
	const namespace = String(item.namespace || "").trim();
	const pageKey = String(item.page_key || "").trim();
	const shardSeq = Number(item.shard_seq);
	const entryCount = Number(item.entry_count);
	const updatedAt = String(item.updated_at || "").trim();
	if (!shardKey || !path || !namespace || !pageKey || !updatedAt) return null;
	if (!["raw", "drafts", "live", "briefings"].includes(layer)) return null;
	if (!Number.isFinite(shardSeq) || shardSeq < 0) return null;
	if (!Number.isFinite(entryCount) || entryCount < 0) return null;

	const sessionId = String(item.session_id || "").trim() || undefined;
	const userId = String(item.user_id || "").trim() || undefined;
	const timeFrom = String(item.time_from || "").trim() || undefined;
	const timeTo = String(item.time_to || "").trim() || undefined;

	return {
		shard_key: shardKey,
		path,
		layer,
		namespace,
		session_id: sessionId,
		user_id: userId,
		entry_count: Math.floor(entryCount),
		time_from: timeFrom,
		time_to: timeTo,
		updated_at: updatedAt,
		token_hints: normalizeTokenHints(item.token_hints),
		page_key: pageKey,
		shard_seq: Math.floor(shardSeq),
	};
}

export function qmdCatalogPath(qmdRoot: string): string {
	return join(qmdRoot, "catalog.json");
}

export function ensureQmdCatalog(qmdRoot: string): void {
	mkdirSync(qmdRoot, { recursive: true });
	const catalogPath = qmdCatalogPath(qmdRoot);
	if (!existsSync(catalogPath)) {
		writeFileSync(
			catalogPath,
			`${JSON.stringify(DEFAULT_CATALOG, null, 2)}\n`,
			"utf8",
		);
	}
}

export function readQmdCatalog(qmdRoot: string): QmdCatalog {
	ensureQmdCatalog(qmdRoot);
	const catalogPath = qmdCatalogPath(qmdRoot);
	try {
		const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
			version?: unknown;
			shards?: unknown;
		};
		const version = Number(parsed?.version);
		const shardsRaw = Array.isArray(parsed?.shards) ? parsed.shards : [];
		const shards: QmdCatalogEntry[] = [];
		for (const item of shardsRaw) {
			const sanitized = sanitizeCatalogEntry(item);
			if (sanitized) shards.push(sanitized);
		}
		return {
			version:
				Number.isFinite(version) && version > 0 ? Math.floor(version) : 1,
			shards,
		};
	} catch {
		return { ...DEFAULT_CATALOG, shards: [] };
	}
}

export function writeQmdCatalog(
	qmdRoot: string,
	nextCatalog: QmdCatalog,
): void {
	ensureQmdCatalog(qmdRoot);
	const catalogPath = qmdCatalogPath(qmdRoot);
	const tempPath = `${catalogPath}.tmp`;
	mkdirSync(dirname(catalogPath), { recursive: true });
	writeFileSync(tempPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, "utf8");
	renameSync(tempPath, catalogPath);
}

export function upsertQmdCatalogEntry(
	qmdRoot: string,
	entry: QmdCatalogEntry,
): void {
	const current = readQmdCatalog(qmdRoot);
	const nextShards = current.shards.slice();
	const index = nextShards.findIndex(
		(candidate) =>
			candidate.path === entry.path ||
			(candidate.shard_key === entry.shard_key &&
				candidate.shard_seq === entry.shard_seq &&
				candidate.layer === entry.layer),
	);
	if (index >= 0) {
		nextShards[index] = entry;
	} else {
		nextShards.push(entry);
	}
	writeQmdCatalog(qmdRoot, {
		version: current.version || 1,
		shards: nextShards,
	});
}

function tokenizeForCatalog(query: string): string[] {
	return String(query || "")
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3)
		.slice(0, 24);
}

export function queryQmdCatalogEntries(input: {
	qmdRoot: string;
	layers: QmdLayer[];
	namespaces: string[];
	query: string;
	userId?: string;
	preferredSessionId?: string;
	sessionMode: "strict" | "soft";
	limit: number;
}): QmdCatalogEntry[] {
	const catalog = readQmdCatalog(input.qmdRoot);
	const namespaceSet = new Set(input.namespaces);
	const layerSet = new Set(input.layers);
	const queryTokens = tokenizeForCatalog(input.query);
	const normalizedUser = String(input.userId || "").trim();
	const normalizedSession = String(input.preferredSessionId || "").trim();

	const matched = catalog.shards.filter((entry) => {
		if (!layerSet.has(entry.layer)) return false;
		if (!namespaceSet.has(entry.namespace)) return false;
		if (
			normalizedUser &&
			String(entry.user_id || "").trim() !== normalizedUser
		) {
			return false;
		}
		if (
			input.sessionMode === "strict" &&
			normalizedSession &&
			String(entry.session_id || "").trim() !== normalizedSession
		) {
			return false;
		}
		if (queryTokens.length === 0) return true;
		const hints = new Set(entry.token_hints || []);
		if (hints.size === 0) return true;
		return queryTokens.some((token) => hints.has(token));
	});

	return matched
		.sort((a, b) => {
			const aTime = Date.parse(a.updated_at || "") || 0;
			const bTime = Date.parse(b.updated_at || "") || 0;
			if (bTime !== aTime) return bTime - aTime;
			if (a.layer !== b.layer) {
				const order: Record<QmdLayer, number> = {
					briefings: 0,
					live: 1,
					drafts: 2,
					raw: 3,
				};
				return order[a.layer] - order[b.layer];
			}
			if (a.shard_key !== b.shard_key) {
				return a.shard_key.localeCompare(b.shard_key);
			}
			return a.shard_seq - b.shard_seq;
		})
		.slice(0, Math.max(input.limit, 1));
}
