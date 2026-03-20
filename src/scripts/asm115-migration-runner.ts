import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ASM115_MIGRATION_ID,
	ASM115_SCHEMA_VERSION,
	isAsm115Noop,
	planSemanticPayloadMigration,
	type SemanticPointRecord,
} from "../core/migrations/asm115-migration-core.js";
import { GraphDB } from "../db/graph-db.js";
import { SlotDB } from "../db/slot-db.js";
import { QdrantClient } from "../services/qdrant.js";
import { resolveAsmRuntimeConfig } from "../shared/asm-config.js";
import { resolveSlotDbDir } from "../shared/slotdb-path.js";

export type Asm115Mode = "preflight" | "plan" | "apply" | "verify" | "rollback";

export interface RunAsm115MigrationInput {
	mode: Asm115Mode;
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

interface Asm115Plan {
	slotdb: PlaneStatus;
	graph: PlaneStatus;
	semantic: PlaneStatus;
}

function nowIso(): string {
	return new Date().toISOString();
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

export async function runAsm115Migration(
	input: RunAsm115MigrationInput,
): Promise<Record<string, unknown>> {
	const env = input.env || process.env;
	const runtime = resolveAsmRuntimeConfig({
		env,
		homeDir: input.homeDir || env.HOME,
	});
	const slotDbDir = resolveSlotDbDir({
		env,
		homeDir: input.homeDir || env.HOME,
		slotDbDir: runtime.slotDbDir,
	});

	const userId = input.userId || "telegram:dm:5165741309";
	const agentId = input.agentId || "assistant";
	const slotDb = new SlotDB(slotDbDir, { slotDbDir });
	const qdrant = new QdrantClient({
		host: runtime.qdrantHost,
		port: runtime.qdrantPort,
		collection: runtime.qdrantCollection,
		vectorSize: runtime.qdrantVectorSize,
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
		ASM115_MIGRATION_ID,
	);

	const plan: Asm115Plan = {
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
			version: semanticPlan.changed === 0 ? ASM115_SCHEMA_VERSION : "mixed",
			needsMigration: semanticPlan.changed > 0,
			details: {
				collection: runtime.qdrantCollection,
				total_points: semanticCount,
				pending_points: semanticPlan.changed,
			},
		},
	};

	if (input.mode === "preflight" || input.mode === "plan") {
		const noop = isAsm115Noop({
			pendingSemanticChanges: semanticPlan.changed,
			migrationStatus: existingMigration?.status,
			migrationSchemaTo: existingMigration?.schema_to,
		});
		slotDb.close();
		return {
			mode: input.mode,
			migration_id: ASM115_MIGRATION_ID,
			schema_target: ASM115_SCHEMA_VERSION,
			no_op: noop,
			plan,
			existing_migration_state: existingMigration,
			semantic_patch_preview: semanticPlan.patches.slice(0, 20).map((p) => ({
				id: p.id,
				changed_fields: p.changedFields,
			})),
		};
	}

	if (input.mode === "verify") {
		const noop = isAsm115Noop({
			pendingSemanticChanges: semanticPlan.changed,
			migrationStatus: existingMigration?.status,
			migrationSchemaTo: existingMigration?.schema_to,
		});
		slotDb.close();
		return {
			mode: "verify",
			migration_id: ASM115_MIGRATION_ID,
			schema_target: ASM115_SCHEMA_VERSION,
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
		slotDb.recordMigrationState(userId, agentId, {
			migration_id: ASM115_MIGRATION_ID,
			schema_from: ASM115_SCHEMA_VERSION,
			schema_to: "rollback",
			applied_at: nowIso(),
			status: "rolled_back",
			notes: JSON.stringify({ rollback_snapshot: input.rollbackSnapshotPath }),
		});
		const state = slotDb.getMigrationState(
			userId,
			agentId,
			ASM115_MIGRATION_ID,
		);
		slotDb.close();
		return {
			mode: "rollback",
			migration_id: ASM115_MIGRATION_ID,
			rolled_back: true,
			migration_state: state,
		};
	}

	const snapshotDir =
		input.snapshotDir || join(slotDbDir, "migration-snapshots");
	const snapshotPath = createSlotDbSnapshot(slotDbDir, snapshotDir);

	if (semanticPlan.patches.length > 0) {
		await qdrant.setPayload(
			semanticPlan.patches.map((patch) => ({
				id: patch.id,
				payload: patch.payload,
			})),
		);
	}

	slotDb.recordMigrationState(userId, agentId, {
		migration_id: ASM115_MIGRATION_ID,
		schema_from: existingMigration?.schema_to || "legacy",
		schema_to: ASM115_SCHEMA_VERSION,
		applied_at: nowIso(),
		status: "migrated",
		notes: JSON.stringify({
			snapshot_path: snapshotPath,
			semantic_updates: semanticPlan.changed,
			total_semantic_points: semanticPlan.total,
		}),
	});
	const state = slotDb.getMigrationState(userId, agentId, ASM115_MIGRATION_ID);
	slotDb.close();

	return {
		mode: "apply",
		migration_id: ASM115_MIGRATION_ID,
		schema_target: ASM115_SCHEMA_VERSION,
		applied: true,
		snapshot_path: snapshotPath,
		semantic_updates: semanticPlan.changed,
		total_semantic_points: semanticPlan.total,
		migration_state: state,
		plan,
	};
}
