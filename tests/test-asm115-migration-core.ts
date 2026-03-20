import {
	ASM115_SCHEMA_VERSION,
	buildSemanticPayloadPatch,
	isAsm115Noop,
	planSemanticPayloadMigration,
} from "../src/core/migrations/asm115-migration-core.js";

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

function assertEqual(
	actual: unknown,
	expected: unknown,
	message: string,
): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
	}
}

function test(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`✅ ${name}`);
	} catch (error) {
		console.error(`❌ ${name}`);
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

test("buildSemanticPayloadPatch adds missing ASM-115 fields", () => {
	const patch = buildSemanticPayloadPatch({
		id: "p1",
		payload: {
			namespace: "agent.assistant.working_memory",
			source_type: "manual",
		},
	});

	assertEqual(
		patch.payload.schema_version,
		ASM115_SCHEMA_VERSION,
		"must set schema version",
	);
	assertEqual(patch.payload.memory_scope, "agent", "must infer memory_scope");
	assertEqual(
		patch.payload.memory_type,
		"episodic_trace",
		"must infer memory_type",
	);
	assertEqual(
		patch.payload.promotion_state,
		"raw",
		"must default promotion_state",
	);
	assert(
		typeof patch.payload.confidence === "number",
		"must default confidence",
	);
	assert(patch.changedFields.length >= 5, "must report changed fields");
});

test("planSemanticPayloadMigration reports changed patches only", () => {
	const result = planSemanticPayloadMigration([
		{
			id: "legacy",
			payload: {
				namespace: "agent.assistant.working_memory",
			},
		},
		{
			id: "already",
			payload: {
				namespace: "agent.assistant.working_memory",
				schema_version: ASM115_SCHEMA_VERSION,
				memory_scope: "agent",
				memory_type: "episodic_trace",
				promotion_state: "raw",
				confidence: 0.7,
			},
		},
	]);

	assertEqual(result.total, 2, "total mismatch");
	assertEqual(result.changed, 1, "changed mismatch");
	assertEqual(result.patches.length, 1, "patch list mismatch");
	assertEqual(result.patches[0]?.id, "legacy", "should only patch legacy row");
});

test("isAsm115Noop only true when migration already applied and no pending semantic updates", () => {
	assert(
		isAsm115Noop({
			pendingSemanticChanges: 0,
			migrationStatus: "migrated",
			migrationSchemaTo: ASM115_SCHEMA_VERSION,
		}),
		"should be noop when already migrated and no pending changes",
	);

	assert(
		!isAsm115Noop({
			pendingSemanticChanges: 1,
			migrationStatus: "migrated",
			migrationSchemaTo: ASM115_SCHEMA_VERSION,
		}),
		"pending changes must disable noop",
	);
});

if (!process.exitCode) {
	console.log("\n🎉 ASM-115 migration core tests passed");
}
