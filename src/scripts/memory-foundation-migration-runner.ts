import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	MEMORY_FOUNDATION_MIGRATION_ID,
	MEMORY_FOUNDATION_SCHEMA_VERSION,
	isMemoryFoundationMigrationNoop,
	planSemanticPayloadMigration,
	type SemanticPointRecord,
} from "../core/migrations/memory-foundation-migration.js";
import { GraphDB } from "../db/graph-db.js";
import { SlotDB } from "../db/slot-db.js";
import { QdrantClient } from "../services/qdrant.js";
import {
	resolveAsmAdapterLocalConfig,
	resolveAsmRuntimeConfig,
} from "../shared/asm-config.js";
import { resolveSlotDbDir } from "../shared/slotdb-path.js";

export type MemoryFoundationMigrationMode = "preflight" | "plan" | "apply" | "verify" | "rollback";

export interface RunMemoryFoundationMigrationInput {
	mode: MemoryFoundationMigrationMode;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	userId?: string;
	agentId?: string;
	snapshotDir?: string;
	rollbackSnapshotPath?: string;
	preflightLimit?: number;
}

interface PlaneStatus {
	version: string;
	needsMigration: boolean;
	details: Record<string, unknown>;
}

interface MemoryFoundationMigrationPlan {
	slotdb: PlaneStatus;
	graph: PlaneStatus;
	semantic: PlaneStatus;
}

interface SemanticSnapshotEntry {
	id: string | number | Record<string, unknown>;
	payload: Record<string, unknown>;
	keys: string[];
}

interface SemanticSnapshotFile {
	migration_id: string;
	collection: string;
	schema_target: string;
	created_at: string;
	entries: SemanticSnapshotEntry[];
}

interface LegacyQdrantRuntimeConfig {
	host: string;
	port: number;
	collection: string;
	vectorSize: number;
}

function nowIso(): string {
	return new Date().toISOString();
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

function detectSlotDbVersion(slotDbDir: string): string {
	const dbPath = join(slotDbDir, "slots.db");
	if (!existsSync(dbPath)) return "missing";
	const db = new DatabaseSync(dbPath);
	try {
		const table = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='migration_state'`,
			)
			.get() as { name: string } | undefined;
		if (!table) return "legacy";
		return "has_migration_state";
	} finally {
		db.close();
	}
}

function detectGraphVersion(slotDbDir: string): {
	version: string;
	entities: number;
	relationships: number;
} {
	const dbPath = join(slotDbDir, "slots.db");
	if (!existsSync(dbPath)) {
		return { version: "missing", entities: 0, relationships: 0 };
	}
	const db = new DatabaseSync(dbPath);
	try {
		const entitiesTable = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`,
			)
			.get() as { name: string } | undefined;
		const relTable = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='relationships'`,
			)
			.get() as { name: string } | undefined;
		if (!entitiesTable || !relTable) {
			return { version: "legacy", entities: 0, relationships: 0 };
		}
		const e =
			(
				db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as
					| { c: number }
					| undefined
			)?.c || 0;
		const r =
			(
				db.prepare(`SELECT COUNT(*) as c FROM relationships`).get() as
					| { c: number }
					| undefined
			)?.c || 0;
		return { version: "graph_v1", entities: e, relationships: r };
	} finally {
		db.close();
	}
}

async function collectSemanticPoints(
	qdrant: QdrantClient,
	limit: number,
): Promise<SemanticPointRecord[]> {
	const points: SemanticPointRecord[] = [];
	let offset: any;
	do {
		const page = await qdrant.scroll(limit, offset, false);
		for (const point of page.points) {
			points.push({
				id: point.id,
				payload: point.payload || {},
			});
		}
		offset = page.nextOffset;
	} while (offset !== undefined && offset !== null);
	return points;
}

function ensureSnapshotDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function createSemanticSnapshot(
	entries: SemanticPointRecord[],
	collection: string,
	snapshotDir: string,
): string {
	ensureSnapshotDir(snapshotDir);
	const target = join(snapshotDir, `semantic-payload.${Date.now()}.json`);
	const snapshot: SemanticSnapshotFile = {
		migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
		collection,
		schema_target: MEMORY_FOUNDATION_SCHEMA_VERSION,
		created_at: nowIso(),
		entries: entries.map((entry) => ({
			id: entry.id,
			payload: JSON.parse(JSON.stringify(entry.payload || {})),
			keys: Object.keys(entry.payload || {}),
		})),
	};
	writeFileSync(target, JSON.stringify(snapshot, null, 2));
	return target;
}

async function restoreSemanticSnapshot(
	qdrant: QdrantClient,
	snapshotPath: string,
): Promise<void> {
	if (!existsSync(snapshotPath)) {
		throw new Error(`semantic rollback snapshot not found: ${snapshotPath}`);
	}
	const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as SemanticSnapshotFile;
	if (!Array.isArray(snapshot.entries)) {
		throw new Error("semantic rollback snapshot invalid: entries missing");
	}

	const managedKeys = Array.from(
		new Set(
			snapshot.entries.flatMap((entry) =>
				Array.isArray(entry.keys) ? entry.keys : Object.keys(entry.payload || {}),
			),
		),
	);

	if (managedKeys.length > 0) {
		await qdrant.deletePayloadKeys(
			snapshot.entries.map((entry) => entry.id),
			managedKeys,
		);
	}

	const entriesWithCurrentPayload = await collectSemanticPoints(qdrant, 500);
	const currentById = new Map(
		entriesWithCurrentPayload.map((entry) => [JSON.stringify(entry.id), entry]),
	);

	const restoreEntries = snapshot.entries.map((entry) => {
		const key = JSON.stringify(entry.id);
		const current = currentById.get(key);
		const restoredPayload = { ...(current?.payload || {}), ...(entry.payload || {}) };
		return {
			id: entry.id,
			payload: restoredPayload,
		};
	});

	await qdrant.setPayload(restoreEntries);
}

function createSlotDbSnapshot(slotDbDir: string, snapshotDir: string): string {
	ensureSnapshotDir(snapshotDir);
	const source = join(slotDbDir, "slots.db");
	const target = join(snapshotDir, `slots.db.${Date.now()}.bak`);
	if (existsSync(source)) {
		cpSync(source, target, { force: true });
	}
	return target;
}

function restoreSlotDbSnapshot(snapshotPath: string, slotDbDir: string): void {
	if (!existsSync(snapshotPath)) {
		throw new Error(`rollback snapshot not found: ${snapshotPath}`);
	}
	const target = join(slotDbDir, "slots.db");
	cpSync(snapshotPath, target, { force: true });
}

export async function runMemoryFoundationMigration(
	input: RunMemoryFoundationMigrationInput,
): Promise<Record<string, unknown>> {
	const env = input.env || process.env;
	const runtime = resolveAsmRuntimeConfig({
		env,
		homeDir: input.homeDir || env.HOME,
	});
	const qdrantRuntime = getLegacyQdrantRuntimeConfig(env);
	const slotDbDir = resolveSlotDbDir({
		env,
		homeDir: input.homeDir || env.HOME,
		slotDbDir: runtime.slotDbDir,
	});

	const userId = input.userId || "telegram:dm:5165741309";
	const agentId = input.agentId || "assistant";
	const slotDb = new SlotDB(slotDbDir, { slotDbDir });
	const qdrant = new QdrantClient({
		host: qdrantRuntime.host,
		port: qdrantRuntime.port,
		collection: qdrantRuntime.collection,
		vectorSize: qdrantRuntime.vectorSize,
	});

	const slotVersion = detectSlotDbVersion(slotDbDir);
	const graph = detectGraphVersion(slotDbDir);
	const semanticCount = await qdrant.countPoints(true);
	const points = await collectSemanticPoints(
		qdrant,
		Math.max(10, input.preflightLimit || 200),
	);
	const semanticPlan = planSemanticPayloadMigration(points);
	const existingMigration = slotDb.getMigrationState(
		userId,
		agentId,
		MEMORY_FOUNDATION_MIGRATION_ID,
	);
	let effectiveMigrationStatus = existingMigration?.status;
	let effectiveMigrationSchemaTo = existingMigration?.schema_to;
	if (existingMigration?.status === "rolled_back" && existingMigration?.notes) {
		try {
			const rollbackNotes = JSON.parse(existingMigration.notes) as Record<string, unknown>;
			if (typeof rollbackNotes.previous_status === "string") {
				effectiveMigrationStatus = rollbackNotes.previous_status;
			}
			if (typeof rollbackNotes.previous_schema_to === "string") {
				effectiveMigrationSchemaTo = rollbackNotes.previous_schema_to;
			}
		} catch {
			effectiveMigrationStatus = undefined;
			effectiveMigrationSchemaTo = undefined;
		}
	}

	const plan: MemoryFoundationMigrationPlan = {
		slotdb: {
			version: slotVersion,
			needsMigration: slotVersion !== "missing",
			details: {
				slot_db_dir: slotDbDir,
			},
		},
		graph: {
			version: graph.version,
			needsMigration: graph.version !== "missing",
			details: {
				entities: graph.entities,
				relationships: graph.relationships,
			},
		},
		semantic: {
			version: semanticPlan.changed === 0 ? MEMORY_FOUNDATION_SCHEMA_VERSION : "mixed",
			needsMigration: semanticPlan.changed > 0,
			details: {
				collection: qdrantRuntime.collection,
				total_points: semanticCount,
				pending_points: semanticPlan.changed,
			},
		},
	};

	if (input.mode === "preflight" || input.mode === "plan") {
		const noop = isMemoryFoundationMigrationNoop({
			pendingSemanticChanges: semanticPlan.changed,
			migrationStatus: effectiveMigrationStatus,
			migrationSchemaTo: effectiveMigrationSchemaTo,
		});
		slotDb.close();
		return {
			mode: input.mode,
			migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
			schema_target: MEMORY_FOUNDATION_SCHEMA_VERSION,
			no_op: noop,
			plan,
			existing_migration_state: existingMigration,
			semantic_patch_preview: semanticPlan.patches.slice(0, 20).map((p: { id: string | number | Record<string, unknown>; changedFields: string[] }) => ({
				id: p.id,
				changed_fields: p.changedFields,
			})),
		};
	}

	if (input.mode === "verify") {
		const noop = isMemoryFoundationMigrationNoop({
			pendingSemanticChanges: semanticPlan.changed,
			migrationStatus: effectiveMigrationStatus,
			migrationSchemaTo: effectiveMigrationSchemaTo,
		});
		slotDb.close();
		return {
			mode: "verify",
			migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
			schema_target: MEMORY_FOUNDATION_SCHEMA_VERSION,
			verified: noop,
			remaining_semantic_points: semanticPlan.changed,
			migration_state: existingMigration,
			plan,
		};
	}

	if (input.mode === "rollback") {
		if (!input.rollbackSnapshotPath) {
			slotDb.close();
			throw new Error("rollback requires --rollback-snapshot <path>");
		}
		restoreSlotDbSnapshot(input.rollbackSnapshotPath, slotDbDir);
		let semanticRollbackSnapshot: string | null = null;
		const existingNotes = existingMigration?.notes ? JSON.parse(existingMigration.notes) : {};
		semanticRollbackSnapshot = typeof existingNotes.semantic_snapshot_path === "string" ? existingNotes.semantic_snapshot_path : null;
		if (semanticRollbackSnapshot) {
			await restoreSemanticSnapshot(qdrant, semanticRollbackSnapshot);
		}
		slotDb.recordMigrationState(userId, agentId, {
			migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
			schema_from: MEMORY_FOUNDATION_SCHEMA_VERSION,
			schema_to: "rollback",
			applied_at: nowIso(),
			status: "rolled_back",
			notes: JSON.stringify({
				rollback_snapshot: input.rollbackSnapshotPath,
				semantic_snapshot_path: semanticRollbackSnapshot,
				previous_status: existingMigration?.status || null,
				previous_schema_to: existingMigration?.schema_to || null,
			}),
		});
		const state = slotDb.getMigrationState(
			userId,
			agentId,
			MEMORY_FOUNDATION_MIGRATION_ID,
		);
		slotDb.close();
		return {
			mode: "rollback",
			migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
			rolled_back: true,
			migration_state: state,
		};
	}

	const snapshotDir =
		input.snapshotDir || join(slotDbDir, "migration-snapshots");
	const snapshotPath = createSlotDbSnapshot(slotDbDir, snapshotDir);
	const semanticSnapshotPath = createSemanticSnapshot(
		points,
		qdrantRuntime.collection,
		snapshotDir,
	);

	if (semanticPlan.patches.length > 0) {
		await qdrant.setPayload(
			semanticPlan.patches.map((patch: { id: string | number | Record<string, unknown>; payload: Record<string, any> }) => ({
				id: patch.id,
				payload: patch.payload,
			})),
		);
	}

	slotDb.recordMigrationState(userId, agentId, {
		migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
		schema_from: existingMigration?.schema_to || "legacy",
		schema_to: MEMORY_FOUNDATION_SCHEMA_VERSION,
		applied_at: nowIso(),
		status: "migrated",
		notes: JSON.stringify({
			snapshot_path: snapshotPath,
			semantic_snapshot_path: semanticSnapshotPath,
			semantic_updates: semanticPlan.changed,
			total_semantic_points: semanticPlan.total,
		}),
	});
	const state = slotDb.getMigrationState(userId, agentId, MEMORY_FOUNDATION_MIGRATION_ID);
	slotDb.close();

	return {
		mode: "apply",
		migration_id: MEMORY_FOUNDATION_MIGRATION_ID,
		schema_target: MEMORY_FOUNDATION_SCHEMA_VERSION,
		applied: true,
		snapshot_path: snapshotPath,
		semantic_snapshot_path: semanticSnapshotPath,
		semantic_updates: semanticPlan.changed,
		total_semantic_points: semanticPlan.total,
		migration_state: state,
		plan,
	};
}
