import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAsmRunMode } from "../src/core/usecases/run-mode-resolver.js";
import { buildStatePack } from "../src/core/usecases/state-pack-builder.js";
import { SlotDB } from "../src/db/slot-db.js";

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
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

test("run mode resolver classifies trivial chatter as light", () => {
	const resolved = resolveAsmRunMode({
		sessionKey: "agent:assistant:hello-thread",
		messages: [{ role: "user", content: "hello there" }],
		userQuery: "hello there",
	});

	assert(resolved.runMode === "light", "expected light mode for trivial chat");
});

test("run mode resolver classifies implementation work as wiki-first", () => {
	const resolved = resolveAsmRunMode({
		sessionKey: "agent:assistant:repo-thread",
		messages: [
			{ role: "user", content: "implement the SlotDB state pack builder" },
		],
		userQuery: "implement the SlotDB state pack builder",
	});

	assert(
		resolved.runMode === "wiki-first",
		"expected wiki-first mode for implementation work",
	);
});

test("run mode resolver classifies continuation distill lanes as write-back", () => {
	const resolved = resolveAsmRunMode({
		sessionKey: "agent:assistant:repo-thread:distill:12345",
		userQuery: "summarize latest updates",
	});

	assert(
		resolved.runMode === "write-back",
		"expected write-back mode for distill continuation lane",
	);
});

test("state pack merges current state by freshness while preserving living-state precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "asm-wiki-foundation-"));
	const db = new SlotDB(root);

	try {
		db.set("u1", "assistant", {
			key: "project.current_task",
			value: "private-older-task",
			category: "project",
			source: "manual",
		});
		db.set("u1", "__team__", {
			key: "project.current_task",
			value: "team-newer-task",
			category: "project",
			source: "manual",
		});
		db.set("__public__", "__public__", {
			key: "project.current_task",
			value: "public-newest-task",
			category: "project",
			source: "manual",
		});

		db.set("__public__", "__public__", {
			key: "project_living_state",
			value: {
				current_focus: "public focus",
				next_steps: ["public next"],
			},
			category: "project",
			source: "manual",
		});
		db.set("u1", "__team__", {
			key: "project_living_state",
			value: {
				current_focus: "team focus",
				next_steps: ["team next"],
			},
			category: "project",
			source: "manual",
		});
		db.set("u1", "assistant", {
			key: "project_living_state",
			value: {
				current_focus: "private focus",
				next_steps: ["private next"],
			},
			category: "project",
			source: "manual",
		});

		const pack = buildStatePack(db, { userId: "u1", agentId: "assistant" });
		const living = pack.projectLivingState as Record<string, unknown>;

		assert(
			pack.currentState.project?.["project.current_task"] ===
				"public-newest-task",
			"freshest current-state value should win across private/team/public",
		);
		assert(
			living.current_focus === "private focus",
			"project_living_state should keep private/team/public precedence",
		);
		assert(
			pack.recentUpdates.length > 0 &&
				pack.recentUpdates[0]?.key === "project_living_state",
			"recent updates should expose newest slot updates cleanly",
		);
		assert(
			pack.activeTaskHints.includes("private focus") &&
				pack.activeTaskHints.includes("private next"),
			"active task hints should include current focus and next steps",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

if (!process.exitCode) {
	console.log("\n🎉 wiki-first foundation tests passed");
}
