import {
	type MemoryFoundationMigrationMode,
	runMemoryFoundationMigration,
} from "../src/scripts/memory-foundation-migration-runner.js";

function parseArgs(argv: string[]) {
	const args = Array.isArray(argv) ? argv.map((x) => String(x)) : [];
	const mode = (args[0] || "preflight") as MemoryFoundationMigrationMode;
	const get = (flag: string): string | undefined => {
		const idx = args.indexOf(flag);
		if (idx < 0) return undefined;
		return args[idx + 1];
	};
	return {
		mode,
		userId: get("--user-id"),
		agentId: get("--agent-id"),
		snapshotDir: get("--snapshot-dir"),
		rollbackSnapshotPath: get("--rollback-snapshot"),
		preflightLimit: Number(get("--preflight-limit") || 200),
	};
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (
		!["preflight", "plan", "apply", "verify", "rollback"].includes(parsed.mode)
	) {
		console.error(
			"[ASM-115] Invalid mode. Use: preflight|plan|apply|verify|rollback",
		);
		process.exit(1);
	}

	try {
		const result = await runMemoryFoundationMigration(parsed);
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(
			`[ASM-115] failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

main();
