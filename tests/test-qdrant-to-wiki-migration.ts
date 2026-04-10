import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	searchWikiMemory,
	writeWikiMemoryCapture,
} from "../src/core/usecases/semantic-memory-usecase.js";
import type { MemoryNamespace } from "../src/shared/memory-config.js";

function assert(condition: boolean, message: string): void {
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

function test(name: string, fn: () => void | Promise<void>): void {
	Promise.resolve()
		.then(fn)
		.then(() => console.log(`✅ ${name}`))
		.catch((error) => {
			console.error(`❌ ${name}`);
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}

const ROOT = mkdtempSync(join(tmpdir(), "asm-qdrant-wiki-migration-"));
process.env.ASM_WIKI_ROOT = ROOT;

function read(relPath: string): string {
	return readFileSync(join(ROOT, relPath), "utf8");
}

function writeMigrated(args: {
	text: string;
	namespace: MemoryNamespace;
	sourceAgent?: string;
	sessionId?: string;
	userId?: string;
	timestamp?: number;
	updatedAt?: number;
}) {
	return writeWikiMemoryCapture({
		text: args.text,
		namespace: args.namespace,
		sourceAgent: args.sourceAgent || "assistant",
		sourceType: "migration",
		memoryScope:
			args.namespace === "shared.project_context" ? "project" : "agent",
		memoryType: args.namespace.endsWith(".lessons") ? "lesson" : "task_context",
		promotionState: "promoted",
		confidence: 0.8,
		sessionId: args.sessionId,
		userId: args.userId,
		timestamp: args.timestamp,
		updatedAt: args.updatedAt,
		metadata: {
			migration_source: "test.qdrant",
			qdrant_id: `q-${Math.random().toString(36).slice(2, 8)}`,
		},
	});
}

test("deterministic grouping maps shared.project_context to live/projects", () => {
	const out = writeMigrated({
		text: "Project context from old qdrant record",
		namespace: "shared.project_context",
		sourceAgent: "assistant",
		sessionId: "sess-01",
		userId: "user-01",
		timestamp: 1712505600,
		updatedAt: 1712509200,
	});

	assertEqual(
		out.livePath,
		"live/projects/user-01/sess-01.md",
		"project context should map to live/projects/{user}/{session}.md",
	);
	assert(existsSync(join(ROOT, out.livePath)), "live page should exist");
});

test("deterministic grouping maps lessons to live/concepts", () => {
	const out = writeMigrated({
		text: "A migration lesson from vector memory",
		namespace: "agent.assistant.lessons",
		sourceAgent: "assistant",
		sessionId: "sess-02",
		userId: "user-02",
		timestamp: 1712510000,
		updatedAt: 1712510300,
	});

	assertEqual(
		out.livePath,
		"live/concepts/assistant/user-02-sess-02.md",
		"lessons should map to live/concepts/{agent}/{user-session}.md",
	);
	assert(
		existsSync(join(ROOT, out.briefingPath)),
		"briefing page should exist",
	);
});

test("duplicate namespace+text upserts instead of creating duplicate live entries", () => {
	const first = writeMigrated({
		text: "Same content dedupe candidate",
		namespace: "agent.assistant.working_memory",
		sourceAgent: "assistant",
		sessionId: "sess-03",
		userId: "user-03",
		timestamp: 1712520000,
		updatedAt: 1712520300,
	});

	const second = writeMigrated({
		text: "Same content dedupe candidate",
		namespace: "agent.assistant.working_memory",
		sourceAgent: "assistant",
		sessionId: "sess-03",
		userId: "user-03",
		timestamp: 1712520600,
		updatedAt: 1712520900,
	});

	assertEqual(
		first.id,
		second.id,
		"same namespace+text should have same deterministic id",
	);
	assertEqual(
		second.updated,
		true,
		"second write should update existing live entry",
	);
});

test("index/log are maintained and migrated docs are searchable", () => {
	const results = searchWikiMemory({
		query: "vector memory migration lesson",
		limit: 5,
		minScore: 0,
		namespaces: [
			"agent.assistant.lessons",
			"agent.assistant.working_memory",
			"shared.project_context",
		],
		sourceAgent: "assistant",
		sessionMode: "soft",
		preferredSessionId: "sess-02",
		userId: "user-02",
	});

	assert(results.length >= 1, "searchWikiMemory should find migrated page");

	const index = read("index.md");
	const log = read("log.md");
	assert(index.includes("## Pages"), "index should contain Pages section");
	assert(
		log.includes("created") || log.includes("updated"),
		"log should contain write entries",
	);
	assert(
		existsSync(join(ROOT, "schema.md")),
		"schema.md should be bootstrapped",
	);
});

test("bootstrap folders exist for raw/live/briefings", () => {
	const expected = ["raw", "live", "briefings"];
	for (const folder of expected) {
		assert(existsSync(join(ROOT, folder)), `${folder} folder should exist`);
	}

	const liveChildren = readdirSync(join(ROOT, "live"));
	assert(
		liveChildren.includes("projects") &&
			liveChildren.includes("concepts") &&
			liveChildren.includes("entities"),
		"live should include projects/concepts/entities",
	);
});

test("writeWikiMemoryCapture honors explicit wikiRoot over workspace-root env", () => {
	const forcedRoot = mkdtempSync(join(tmpdir(), "asm-qdrant-wiki-explicit-"));
	const wrongWorkspace = mkdtempSync(
		join(tmpdir(), "asm-qdrant-wiki-workspace-"),
	);
	const prevWorkspace = process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT;
	process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT = wrongWorkspace;

	try {
		const out = writeWikiMemoryCapture({
			text: "explicit root write",
			namespace: "agent.assistant.working_memory",
			sourceAgent: "assistant",
			sourceType: "migration",
			memoryScope: "agent",
			memoryType: "task_context",
			promotionState: "promoted",
			confidence: 0.8,
			wikiRoot: forcedRoot,
		});

		assertEqual(
			out.wikiRoot,
			forcedRoot,
			"explicit wikiRoot should override workspace-root env candidate",
		);
		assert(
			existsSync(join(forcedRoot, out.livePath)),
			"live page should be created under explicit wikiRoot",
		);
	} finally {
		if (typeof prevWorkspace === "string") {
			process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT = prevWorkspace;
		} else {
			delete process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT;
		}
		try {
			rmSync(forcedRoot, { recursive: true, force: true });
		} catch {
			// no-op
		}
		try {
			rmSync(wrongWorkspace, { recursive: true, force: true });
		} catch {
			// no-op
		}
	}
});

setTimeout(() => {
	try {
		rmSync(ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
	if (!process.exitCode) {
		console.log("\n🎉 qdrant->wiki migration tests passed");
	}
}, 0);
