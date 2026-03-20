import {
	type MemoryNamespace,
	type MemorySourceType,
	resolveDefaultConfidence,
	resolveMemoryScopeFromNamespace,
	resolveMemoryTypeFromNamespace,
} from "../../shared/memory-config.js";

export const MEMORY_FOUNDATION_SCHEMA_VERSION = "memory-foundation.v1";
export const MEMORY_FOUNDATION_MIGRATION_ID = "memory-foundation-v1";

export interface SemanticPointPayload {
	namespace?: string;
	source_type?: string;
	schema_version?: string;
	memory_scope?: string;
	memory_type?: string;
	promotion_state?: string;
	confidence?: unknown;
	[key: string]: unknown;
}

export interface SemanticPointRecord {
	id: string | number | Record<string, unknown>;
	payload: SemanticPointPayload;
}

export interface SemanticPointPatch {
	id: string | number | Record<string, unknown>;
	payload: SemanticPointPayload;
	changedFields: string[];
}

function asMemoryNamespace(value: string): MemoryNamespace {
	return value as MemoryNamespace;
}

function asSourceType(value: unknown): MemorySourceType {
	const normalized = String(value || "auto_capture")
		.trim()
		.toLowerCase();
	if (
		normalized === "auto_capture" ||
		normalized === "manual" ||
		normalized === "tool_call" ||
		normalized === "migration" ||
		normalized === "promotion"
	) {
		return normalized;
	}
	return "auto_capture";
}

export function buildSemanticPayloadPatch(
	input: SemanticPointRecord,
): SemanticPointPatch {
	const payload = { ...(input.payload || {}) };
	const changedFields: string[] = [];

	const namespace = String(
		payload.namespace || "agent.assistant.working_memory",
	).trim();
	const sourceType = asSourceType(payload.source_type);

	if (String(payload.schema_version || "") !== MEMORY_FOUNDATION_SCHEMA_VERSION) {
		payload.schema_version = MEMORY_FOUNDATION_SCHEMA_VERSION;
		changedFields.push("schema_version");
	}

	if (!payload.memory_scope) {
		payload.memory_scope = resolveMemoryScopeFromNamespace(
			asMemoryNamespace(namespace),
		);
		changedFields.push("memory_scope");
	}

	if (!payload.memory_type) {
		payload.memory_type = resolveMemoryTypeFromNamespace(
			asMemoryNamespace(namespace),
		);
		changedFields.push("memory_type");
	}

	if (!payload.promotion_state) {
		payload.promotion_state = "raw";
		changedFields.push("promotion_state");
	}

	const confidenceNumber = Number(payload.confidence);
	if (!Number.isFinite(confidenceNumber) || confidenceNumber <= 0) {
		payload.confidence = resolveDefaultConfidence(sourceType);
		changedFields.push("confidence");
	}

	return {
		id: input.id,
		payload,
		changedFields,
	};
}

export function planSemanticPayloadMigration(points: SemanticPointRecord[]): {
	total: number;
	changed: number;
	patches: SemanticPointPatch[];
} {
	const patches = points
		.map((point) => buildSemanticPayloadPatch(point))
		.filter((patch) => patch.changedFields.length > 0);

	return {
		total: points.length,
		changed: patches.length,
		patches,
	};
}

export function isMemoryFoundationMigrationNoop(input: {
	pendingSemanticChanges: number;
	migrationStatus?: string;
	migrationSchemaTo?: string;
}): boolean {
	return (
		input.pendingSemanticChanges === 0 &&
		input.migrationStatus === "migrated" &&
		input.migrationSchemaTo === MEMORY_FOUNDATION_SCHEMA_VERSION
	);
}
