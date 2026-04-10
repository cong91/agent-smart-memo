/**
 * ASM Phase V integrated verifier
 *
 * Runs baseline + boundary/adapter contract + rollout guard checks.
 */
import { spawnSync } from "node:child_process";

const commands: Array<[string, string[]]> = [
	["npm", ["run", "build"]],
	["npm", ["test"]],
	["npx", ["tsx", "tests/test-runtime-boundary.ts"]],
	["npx", ["tsx", "tests/test-openclaw-adapter-contract.ts"]],
	["npx", ["tsx", "tests/test-semantic-memory-usecase.ts"]],
	["npx", ["tsx", "tests/test-openclaw-semantic-tools-integration.ts"]],
	["npx", ["tsx", "tests/test-openclaw-tools-usecase-integration.ts"]],
	["npx", ["tsx", "tests/test-graph-tools.ts"]],
	["npx", ["tsx", "tests/test-memory-tools-agent-context.ts"]],
	["npx", ["tsx", "scripts/asm-rollout-guards.ts"]],
];

for (const [bin, args] of commands) {
	const label = `${bin} ${args.join(" ")}`;
	console.log(`\n[asm-phase5-verify] running: ${label}`);
	const p = spawnSync(bin, args, { stdio: "inherit" });
	if (p.status !== 0) {
		console.error(`[asm-phase5-verify] FAILED: ${label}`);
		process.exit(p.status || 1);
	}
}

console.log("\n[asm-phase5-verify] PASS: all integrated checks\n");
