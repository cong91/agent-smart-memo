import fs from "node:fs/promises";
import path from "node:path";
import { writeWikiMemoryCapture } from "../core/usecases/semantic-memory-usecase.js";
import { QdrantClient } from "../services/qdrant.js";
import { resolveAsmRuntimeConfig, resolveAsmAdapterLocalConfig } from "../shared/asm-config.js";
import {
	type MemoryNamespace,
	normalizeNamespace,
	resolveDefaultConfidence,
	resolveMemoryScopeFromNamespace,
	resolveMemoryTypeFromNamespace,
	toCoreAgent,
} from "../shared/memory-config.js";

interface ExportRecord {
	id: string;
	text: string;
	vector?: number[];
	namespace?: string;
	timestamp?: number;
	updatedAt?: number;
	source_agent?: string;
	agent?: string;
	sessionId?: string | null;
	userId?: string | null;
	memory_scope?: string;
	memory_type?: string;
	promotion_state?: string;
	confidence?: number;
	metadata?: Record<string, unknown>;
}

interface ExportEnvelope {
	collection: string;
	count: number;
	deterministicOrder: string[];
	options: {
		batchSize: number;
		maxPoints: number | null;
		withVector: boolean;
	};
	records: ExportRecord[];
}

interface WikiWriteInput {
	records: ExportRecord[];
	sourceLabel: string;
	collection: string;
	wikiRoot: string;
}

type WikiMigrationWriteResult = ReturnType<typeof writeWikiMemoryCapture>;

interface LegacyQdrantRuntimeConfig {
	host: string;
	port: number;
	collection: string;
	vectorSize: number;
}

interface WikiWriteSummary {
	totalRecords: number;
	skippedEmptyText: number;
	processed: number;
	created: number;
	updated: number;
	namespaces: Record<string, number>;
	groupingPages: Record<string, number>;
	resultSamples: WikiMigrationWriteResult[];
}

function getArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return undefined;
	return process.argv[idx + 1];
}

function parsePositiveInt(flag: string): number | undefined {
	const raw = getArg(flag);
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
		throw new Error(
			`Invalid ${flag} value '${raw}': expected a positive integer`,
		);
	}
	return n;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

function normalizeId(id: unknown): string {
	if (
		typeof id === "string" ||
		typeof id === "number" ||
		typeof id === "boolean"
	) {
		return String(id);
	}
	return stableJson(id);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function numberOrUndefined(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function parseStringWithDefault(flag: string, fallback: string): string {
	const raw = getArg(flag);
	if (!raw) return fallback;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function parseNumberWithDefault(flag: string, fallback: number): number {
	const raw = getArg(flag);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid ${flag} value '${raw}': expected a number`);
	}
	return parsed;
}

function toMemoryNamespace(record: ExportRecord): MemoryNamespace {
	const sourceAgent = toCoreAgent(
		record.source_agent || record.agent || "assistant",
	);
	return normalizeNamespace(record.namespace, sourceAgent);
}

function toWikiWriteInput(
	record: ExportRecord,
	sourceLabel: string,
	collection: string,
) {
	const sourceAgent = toCoreAgent(
		record.source_agent || record.agent || "assistant",
	);
	const namespace = toMemoryNamespace(record);
	const memoryScope =
		typeof record.memory_scope === "string" &&
		record.memory_scope.trim().length > 0
			? record.memory_scope.trim()
			: resolveMemoryScopeFromNamespace(namespace);
	const memoryType =
		typeof record.memory_type === "string" &&
		record.memory_type.trim().length > 0
			? record.memory_type.trim()
			: resolveMemoryTypeFromNamespace(namespace);
	const confidence =
		typeof record.confidence === "number" && Number.isFinite(record.confidence)
			? Math.max(0, Math.min(1, record.confidence))
			: resolveDefaultConfidence("migration");

	return {
		text: String(record.text || "").trim(),
		namespace,
		sourceAgent,
		sourceType: "migration",
		memoryScope,
		memoryType,
		promotionState:
			typeof record.promotion_state === "string" &&
			record.promotion_state.trim().length > 0
				? record.promotion_state.trim()
				: "promoted",
		confidence,
		timestamp: record.timestamp,
		updatedAt: record.updatedAt,
		sessionId:
			typeof record.sessionId === "string" && record.sessionId.trim().length > 0
				? record.sessionId
				: undefined,
		userId:
			typeof record.userId === "string" && record.userId.trim().length > 0
				? record.userId
				: undefined,
		metadata: {
			schema_version: "asm.v2.wiki",
			migration_source: sourceLabel,
			qdrant_id: record.id,
			qdrant_namespace:
				typeof record.namespace === "string" ? record.namespace : undefined,
			qdrant_collection_hint: collection,
			...(record.metadata || {}),
		},
	};
}

async function writeExportedRecordsToWiki(
	input: WikiWriteInput,
): Promise<WikiWriteSummary> {
	const namespaces: Record<string, number> = {};
	const groupingPages: Record<string, number> = {};
	const results: WikiMigrationWriteResult[] = [];
	let skippedEmptyText = 0;

	for (const record of input.records) {
		const text = String(record.text || "").trim();
		if (!text) {
			skippedEmptyText += 1;
			continue;
		}
		const prepared = toWikiWriteInput(
			record,
			input.sourceLabel,
			input.collection,
		);
		const result = writeWikiMemoryCapture({
			...prepared,
			wikiRoot: input.wikiRoot,
		});
		results.push(result);
		namespaces[result.namespace] = (namespaces[result.namespace] || 0) + 1;
		groupingPages[result.livePath] = (groupingPages[result.livePath] || 0) + 1;
	}

	const created = results.filter((r) => r.created).length;
	const updated = results.filter((r) => r.updated).length;

	return {
		totalRecords: input.records.length,
		skippedEmptyText,
		processed: results.length,
		created,
		updated,
		namespaces,
		groupingPages,
		resultSamples: results.slice(0, 20),
	};
}

function getLegacyQdrantRuntimeConfig(env: NodeJS.ProcessEnv): LegacyQdrantRuntimeConfig {
	const adapterConfig = resolveAsmAdapterLocalConfig("qdrant", { env });
	const host =
		typeof adapterConfig?.host === "string" && adapterConfig.host.trim().length > 0
			? adapterConfig.host.trim()
			: env.QDRANT_HOST?.trim() || "127.0.0.1";
	const portRaw =
		typeof adapterConfig?.port === "number" || typeof adapterConfig?.port === "string"
			? Number(adapterConfig.port)
			: Number(env.QDRANT_PORT || 6333);
	const collection =
		typeof adapterConfig?.collection === "string" &&
		adapterConfig.collection.trim().length > 0
			? adapterConfig.collection.trim()
			: env.QDRANT_COLLECTION?.trim() || "memories";
	const vectorSizeRaw =
		typeof adapterConfig?.vectorSize === "number" ||
		typeof adapterConfig?.vectorSize === "string"
			? Number(adapterConfig.vectorSize)
			: Number(env.QDRANT_VECTOR_SIZE || 1536);

	if (!Number.isFinite(portRaw) || portRaw <= 0) {
		throw new Error("Legacy Qdrant config invalid: port must be a positive number");
	}
	if (!Number.isFinite(vectorSizeRaw) || vectorSizeRaw <= 0) {
		throw new Error(
			"Legacy Qdrant config invalid: vectorSize must be a positive number",
		);
	}

	return {
		host,
		port: portRaw,
		collection,
		vectorSize: vectorSizeRaw,
	};
}

function buildParityNotes(summary: WikiWriteSummary): string[] {
	return [
		`records_total=${summary.totalRecords}`,
		`records_processed=${summary.processed}`,
		`records_skipped_empty_text=${summary.skippedEmptyText}`,
		`created=${summary.created}`,
		`updated=${summary.updated}`,
		`parity_delta_total_minus_processed=${summary.totalRecords - summary.processed}`,
	];
}

async function main() {
	resolveAsmRuntimeConfig({
		env: process.env,
		homeDir: process.env.HOME,
	});
	const qdrantRuntime = getLegacyQdrantRuntimeConfig(process.env);
	const outPath =
		getArg("--out") ||
		path.resolve(process.cwd(), "artifacts/qdrant-export.json");
	const collection = getArg("--collection") || qdrantRuntime.collection;
	const batchSize = parsePositiveInt("--batch-size") || 256;
	const maxPoints = parsePositiveInt("--max-points");
	const includeVectors = process.argv.includes("--with-vector");
	const writeWiki = process.argv.includes("--write-wiki");
	const sourceLabel = parseStringWithDefault(
		"--source-label",
		"qdrant.migration",
	);
	const wikiRoot = parseStringWithDefault(
		"--wiki-root",
		path.resolve(process.cwd(), "memory/wiki"),
	);
	const summaryOutPath =
		getArg("--summary-out") ||
		path.resolve(process.cwd(), "artifacts/qdrant-wiki-migration-summary.json");
	const minConfidenceForWiki = parseNumberWithDefault("--min-confidence", 0);

	const client = new QdrantClient({
		host: qdrantRuntime.host,
		port: qdrantRuntime.port,
		collection,
		vectorSize: qdrantRuntime.vectorSize,
	});

	const points = await client.scrollAll({
		batchSize,
		withVector: includeVectors,
		maxPoints,
	});

	const exported: ExportRecord[] = points.map((p) => ({
		id: normalizeId(p.id),
		text: String(p.payload?.text || ""),
		vector: includeVectors && Array.isArray(p.vector) ? p.vector : undefined,
		namespace:
			typeof p.payload?.namespace === "string"
				? p.payload.namespace
				: undefined,
		timestamp: numberOrUndefined(p.payload?.timestamp),
		updatedAt: numberOrUndefined(p.payload?.updatedAt),
		source_agent:
			typeof p.payload?.source_agent === "string"
				? p.payload.source_agent
				: undefined,
		agent: typeof p.payload?.agent === "string" ? p.payload.agent : undefined,
		sessionId:
			typeof p.payload?.sessionId === "string" ? p.payload.sessionId : null,
		userId: typeof p.payload?.userId === "string" ? p.payload.userId : null,
		memory_scope:
			typeof p.payload?.memory_scope === "string"
				? p.payload.memory_scope
				: undefined,
		memory_type:
			typeof p.payload?.memory_type === "string"
				? p.payload.memory_type
				: undefined,
		promotion_state:
			typeof p.payload?.promotion_state === "string"
				? p.payload.promotion_state
				: undefined,
		confidence: numberOrUndefined(p.payload?.confidence),
		metadata: normalizeMetadata(p.payload?.metadata),
	}));

	exported.sort((a, b) => {
		const at = a.timestamp ?? 0;
		const bt = b.timestamp ?? 0;
		if (at !== bt) return at - bt;

		const au = a.updatedAt ?? 0;
		const bu = b.updatedAt ?? 0;
		if (au !== bu) return au - bu;

		return a.id.localeCompare(b.id);
	});

	await fs.mkdir(path.dirname(outPath), { recursive: true });

	const filteredForWiki = writeWiki
		? exported.filter((record) => {
				if (
					typeof record.confidence === "number" &&
					Number.isFinite(record.confidence)
				) {
					return record.confidence >= minConfidenceForWiki;
				}
				return true;
			})
		: [];

	const envelope: ExportEnvelope = {
		collection,
		count: exported.length,
		deterministicOrder: ["timestamp", "updatedAt", "id"],
		options: {
			batchSize,
			maxPoints: maxPoints ?? null,
			withVector: includeVectors,
		},
		records: exported,
	};

	await fs.writeFile(outPath, JSON.stringify(envelope, null, 2), "utf8");

	let wikiSummary: WikiWriteSummary | null = null;
	if (writeWiki) {
		wikiSummary = await writeExportedRecordsToWiki({
			records: filteredForWiki,
			sourceLabel,
			collection,
			wikiRoot,
		});
		const payload = {
			source: {
				collection,
				exported: exported.length,
				filteredForWiki: filteredForWiki.length,
				minConfidenceForWiki,
				sourceLabel,
				wikiRootRequested: wikiRoot,
			},
			wiki: wikiSummary,
			parityNotes: buildParityNotes(wikiSummary),
		};
		await fs.mkdir(path.dirname(summaryOutPath), { recursive: true });
		await fs.writeFile(
			summaryOutPath,
			JSON.stringify(payload, null, 2),
			"utf8",
		);
		console.log(
			`Wrote wiki migration summary (${wikiSummary.processed} processed) to ${summaryOutPath}`,
		);
	}

	console.log(
		`Exported ${exported.length} records from collection '${collection}' to ${outPath}`,
	);
	if (writeWiki && wikiSummary) {
		console.log(
			`Wiki write complete: processed=${wikiSummary.processed}, created=${wikiSummary.created}, updated=${wikiSummary.updated}, skipped_empty=${wikiSummary.skippedEmptyText}`,
		);
	}
}

main().catch((error) => {
	console.error(
		"[ASM-130] export-qdrant-to-json failed:",
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
});
