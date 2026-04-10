import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySearchTool } from "../src/tools/memory_search.js";
import { createMemoryStoreTool } from "../src/tools/memory_store.js";

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
	if (a !== e) throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
}

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	return Promise.resolve()
		.then(fn)
		.then(() => console.log(`✅ ${name}`))
		.catch((err) => {
			console.error(`❌ ${name}`);
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		});
}

async function main() {
	const previousWikiRoot = process.env.ASM_WIKI_ROOT;
	const wikiRoot = mkdtempSync(join(tmpdir(), "asm-memory-tools-"));
	process.env.ASM_WIKI_ROOT = wikiRoot;

	const memoryStore = createMemoryStoreTool("shared.project_context");
	const memorySearch = createMemorySearchTool("shared.project_context");

	try {
		await test("store normalizes alias namespace 'assistant' -> canonical", async () => {
			const res = await memoryStore.execute("t1", {
				text: "ASM namespace alias assistant roundtrip",
				namespace: "assistant" as any,
				agentId: "assistant",
			});

			assert(res.isError !== true, "memory_store should succeed");
			const details = (res as any).details;
			assert(
				String(details?.wiki?.livePath || "").includes(
					"live/entities/assistant/",
				),
				"assistant alias should route to assistant wiki page",
			);
			assert(
				details?.toolResult?.text,
				"memory_store details.toolResult.text must exist",
			);

			const searchRes = await memorySearch.execute("t1-search", {
				query: "ASM namespace alias assistant roundtrip",
				namespace: "assistant" as any,
				agentId: "assistant",
				minScore: 0.1,
			});
			const first = ((searchRes as any).details?.results || [])[0];
			assert(first, "stored assistant memory should be searchable from wiki");
			assertEqual(
				first.namespace,
				"agent.assistant.working_memory",
				"alias assistant must map to canonical namespace",
			);
		});

		await test("search from scrum session honors explicit assistant alias instead of fallback agent", async () => {
			const res = await memorySearch.execute("t1b", {
				query: "namespace alias assistant",
				namespace: "assistant" as any,
				agentId: "scrum",
				minScore: 0.1,
			});

			assert(
				res.isError !== true,
				"memory_search should succeed from scrum context",
			);
			const results = ((res as any).details?.results || []) as Array<any>;
			assert(
				results.every((r) => r.namespace === "agent.assistant.working_memory"),
				"explicit assistant alias must stay assistant even when fallback agent is scrum",
			);
		});

		await test("search normalizes alias namespace 'assistant' -> canonical result namespace", async () => {
			const res = await memorySearch.execute("t2", {
				query: "namespace alias assistant",
				namespace: "assistant" as any,
				agentId: "assistant",
				minScore: 0.1,
			});

			assert(res.isError !== true, "memory_search should succeed");
			const results = ((res as any).details?.results || []) as Array<any>;
			assert(
				results.some((r) => r.namespace === "agent.assistant.working_memory"),
				"search results must use canonical namespace",
			);
			assert(
				String(res.content?.[0]?.text || "").includes("Found"),
				"search should return found message",
			);
		});

		await test("canonical namespace query still works", async () => {
			const res = await memorySearch.execute("t3", {
				query: "assistant roundtrip",
				namespace: "agent.assistant.working_memory",
				agentId: "assistant",
				minScore: 0.1,
			});

			assert(res.isError !== true, "canonical namespace search should succeed");
			assert(
				String(res.content?.[0]?.text || "").includes("Found"),
				"canonical search should find memory",
			);
		});

		await test("legacy/shared namespace project_context maps to shared.project_context (store->search roundtrip)", async () => {
			const text = "ASM legacy namespace project context roundtrip";

			const storeRes = await memoryStore.execute("t4", {
				text,
				namespace: "project_context" as any,
				agentId: "assistant",
			});
			assert(
				storeRes.isError !== true,
				"legacy namespace store should succeed",
			);

			const searchRes = await memorySearch.execute("t5", {
				query: "legacy namespace project context",
				namespace: "project_context" as any,
				agentId: "assistant",
				minScore: 0.1,
			});

			assert(
				searchRes.isError !== true,
				"legacy namespace search should succeed",
			);
			const results = ((searchRes as any).details?.results || []) as Array<any>;
			assert(
				results.some((r) => r.namespace === "shared.project_context"),
				"legacy namespace search results must map to shared.project_context",
			);
		});

		await test("unknown explicit namespace returns clear validation error instead of silent fallback", async () => {
			const searchRes = await memorySearch.execute("t6", {
				query: "unknown namespace",
				namespace: "totally_unknown_namespace" as any,
				agentId: "assistant",
				minScore: 0.1,
			});
			assert(
				searchRes.isError === true,
				"unknown explicit namespace search must fail clearly",
			);
			assert(
				String(searchRes.content?.[0]?.text || "").includes(
					"Unknown namespace",
				),
				"search error should mention unknown namespace",
			);

			const storeRes = await memoryStore.execute("t7", {
				text: "should not store",
				namespace: "totally_unknown_namespace" as any,
				agentId: "assistant",
			});
			assert(
				storeRes.isError === true,
				"unknown explicit namespace store must fail clearly",
			);
			assert(
				String(storeRes.content?.[0]?.text || "").includes("Unknown namespace"),
				"store error should mention unknown namespace",
			);
		});

		await test("sessionMode=soft keeps cross-session wiki results available", async () => {
			await memoryStore.execute("t8a", {
				text: "ASM cross session soft result",
				namespace: "assistant" as any,
				agentId: "assistant",
				sessionId: "other-session",
			});
			const res = await memorySearch.execute("t9", {
				query: "session",
				namespace: "assistant" as any,
				agentId: "assistant",
				sessionId: "session-soft-1",
				sessionMode: "soft" as any,
				minScore: 0.1,
			});

			assert(
				res.isError !== true,
				"memory_search soft session mode should succeed",
			);
			const results = ((res as any).details?.results || []) as Array<any>;
			assert(
				results.some((r) =>
					String(r.text).includes("cross session soft result"),
				),
				"soft mode must keep cross-session wiki results available",
			);
		});

		await test("sessionMode=strict keeps only requested session wiki results", async () => {
			await memoryStore.execute("t10a", {
				text: "ASM strict session wiki result",
				namespace: "assistant" as any,
				agentId: "assistant",
				sessionId: "session-strict-1",
			});
			const res = await memorySearch.execute("t10", {
				query: "strict session",
				namespace: "assistant" as any,
				agentId: "assistant",
				sessionId: "session-strict-1",
				sessionMode: "strict" as any,
				minScore: 0.1,
			});

			assert(
				res.isError !== true,
				"memory_search strict session mode should succeed",
			);
			const results = ((res as any).details?.results || []) as Array<any>;
			assert(
				results.every(
					(r) => (r.metadata?.sessionId || null) === "session-strict-1",
				),
				"strict mode must keep only the requested session",
			);
		});
	} finally {
		if (previousWikiRoot) process.env.ASM_WIKI_ROOT = previousWikiRoot;
		else delete process.env.ASM_WIKI_ROOT;
		rmSync(wikiRoot, { recursive: true, force: true });
	}

	if (!process.exitCode) {
		console.log("\n🎉 memory tools namespace roundtrip tests passed");
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
