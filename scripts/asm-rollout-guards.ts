/**
 * ASM rollout guard verifier (Phase IV)
 *
 * Non-invasive checklist verifier used before broader rollout:
 * - build must pass
 * - contract-focused tests must pass
 */
import { spawnSync } from "node:child_process";

const commands: Array<[string, string[]]> = [
	["npm", ["run", "build"]],
	["npx", ["tsx", "tests/test-runtime-boundary.ts"]],
	["npx", ["tsx", "tests/test-openclaw-adapter-contract.ts"]],
];

for (const [bin, args] of commands) {
	const pretty = `${bin} ${args.join(" ")}`;
	console.log(`\n[asm-rollout-guards] running: ${pretty}`);
	const p = spawnSync(bin, args, { stdio: "inherit" });
	if (p.status !== 0) {
		console.error(`[asm-rollout-guards] FAILED: ${pretty}`);
		process.exit(p.status || 1);
	}
}

console.log("\n[asm-rollout-guards] PASS: build + contract guard suite\n");
