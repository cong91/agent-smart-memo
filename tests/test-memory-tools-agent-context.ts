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

async function run() {
	const previousWikiRoot = process.env.ASM_WIKI_ROOT;
	const wikiRoot = mkdtempSync(join(tmpdir(), "asm-agent-context-"));
	process.env.ASM_WIKI_ROOT = wikiRoot;

	const memoryStore = createMemoryStoreTool("shared.project_context");
	const memorySearch = createMemorySearchTool("shared.project_context");

	try {
		const agents = ["assistant", "scrum", "fullstack"] as const;

		for (const agent of agents) {
			const sessionId = `agent:${agent}:runtime-test`;

			const storeRes = await memoryStore.execute(`store-${agent}`, {
				text: `runtime-agent-context-${agent}`,
				sessionId,
				// intentionally omit agentId to verify fallback from session identity
			} as any);

			assert(
				storeRes.isError !== true,
				`memory_store must succeed for ${agent}`,
			);
			const storeDetails = (storeRes as any).details;
			assert(
				String(storeDetails?.wiki?.livePath || "").includes(
					`live/entities/${agent}/`,
				),
				`store must route to ${agent} namespace when only sessionId is present`,
			);
			assertEqual(
				String(storeDetails?.toolResult?.text || "").includes("Memory"),
				true,
				`store response should mention memory persistence for ${agent}`,
			);

			const searchRes = await memorySearch.execute(`search-${agent}`, {
				query: `runtime-agent-context-${agent}`,
				sessionId,
				minScore: 0.1,
				// intentionally omit agentId
			} as any);

			assert(
				searchRes.isError !== true,
				`memory_search must succeed for ${agent}`,
			);
			const results = ((searchRes as any).details?.results || []) as Array<any>;
			assert(results.length >= 1, `search must return results for ${agent}`);
			assert(
				results.some(
					(result) => result.namespace === `agent.${agent}.working_memory`,
				),
				`search namespaces must include ${agent}.working_memory`,
			);
			assert(
				!results.some(
					(result) =>
						result.namespace === "agent.assistant.working_memory" &&
						agent !== "assistant",
				),
				`search must not leak to assistant namespace for ${agent}`,
			);
		}
	} finally {
		if (previousWikiRoot) process.env.ASM_WIKI_ROOT = previousWikiRoot;
		else delete process.env.ASM_WIKI_ROOT;
		rmSync(wikiRoot, { recursive: true, force: true });
	}

	console.log(
		"✅ memory tools runtime-context assistant/scrum/fullstack tests passed",
	);
}

run().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
