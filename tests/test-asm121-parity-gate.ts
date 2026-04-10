import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWikiWorkingSet,
	SemanticMemoryUseCase,
} from "../src/core/usecases/semantic-memory-usecase.js";
import {
	injectRecallContext,
	selectSemanticMemories,
} from "../src/hooks/auto-recall.js";
import { DeduplicationService } from "../src/services/dedupe.js";
import { createMemorySearchTool } from "../src/tools/memory_search.js";

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

class MockEmbedding {
	async embed(text: string): Promise<number[]> {
		const seed = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
		return [seed % 101, seed % 97, seed % 89, seed % 83].map((n) =>
			Number((n / 100).toFixed(3)),
		);
	}

	async embedDetailed(
		text: string,
	): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
		return {
			vector: await this.embed(text),
			metadata: {
				embedding_chunked: false,
				embedding_chunks_count: 1,
				embedding_chunking_strategy: "array_batch_weighted_avg",
				embedding_model: "mock",
				embedding_provider: "mock",
			},
		};
	}
}

class MockQdrant {}

async function main() {
	const previousWikiRoot = process.env.ASM_WIKI_ROOT;
	const wikiRoot = mkdtempSync(join(tmpdir(), "asm121-parity-"));
	process.env.ASM_WIKI_ROOT = wikiRoot;

	const qdrant = new MockQdrant();
	const embedding = new MockEmbedding();
	const dedupe = new DeduplicationService(0.95, console);
	const memorySearch = createMemorySearchTool("shared.project_context");
	const usecase = new SemanticMemoryUseCase(
		qdrant as any,
		embedding as any,
		dedupe,
	);

	try {
		await usecase.capture(
			{
				text: "Parity same session memory",
				namespace: "assistant",
				sessionId: "strict-session",
				userId: "u1",
			},
			{ userId: "u1", agentId: "assistant", sessionId: "strict-session" },
		);
		await usecase.capture(
			{
				text: "Parity cross session memory",
				namespace: "assistant",
				sessionId: "other-session",
				userId: "u1",
			},
			{ userId: "u1", agentId: "assistant", sessionId: "other-session" },
		);

		await test("strict mode parity: tool + usecase both hard-filter session", async () => {
			const toolRes = await memorySearch.execute("p1", {
				query: "Parity same session memory",
				namespace: "assistant" as any,
				agentId: "assistant",
				userId: "u1",
				sessionMode: "strict",
				sessionId: "strict-session",
				includeDrafts: true,
				minScore: 0.1,
			});
			assert(toolRes.isError !== true, "tool strict search must succeed");
			const toolIds = ((toolRes as any).details?.results || []).map((r: any) =>
				String(r.id),
			);

			const usecaseRes = await usecase.search(
				{
					query: "Parity same session memory",
					namespace: "assistant",
					userId: "u1",
					sessionMode: "strict",
					sessionId: "strict-session",
					includeDrafts: true,
					minScore: 0.1,
				},
				{ userId: "u1", agentId: "assistant", sessionId: "strict-session" },
			);
			const usecaseIds = usecaseRes.results.map((r) => String(r.id));

			assert(
				toolIds.length >= 1,
				"tool strict should return at least one wiki hit",
			);
			assertEqual(
				toolIds,
				usecaseIds,
				"tool strict and usecase strict must stay in parity",
			);
			assert(
				usecaseRes.results.every(
					(r) => (r.metadata?.sessionId || null) === "strict-session",
				),
				"strict mode must keep only the requested session",
			);
		});

		await test("soft mode parity: tool + usecase return identical ordering/signature", async () => {
			const toolRes = await memorySearch.execute("p2", {
				query: "Parity memory",
				namespace: "assistant" as any,
				agentId: "assistant",
				userId: "u1",
				sessionMode: "soft",
				sessionId: "strict-session",
				includeDrafts: true,
				minScore: 0.1,
			});
			assert(toolRes.isError !== true, "tool soft search must succeed");
			const toolResults = (toolRes as any).details?.results || [];

			const usecaseRes = await usecase.search(
				{
					query: "Parity memory",
					namespace: "assistant",
					userId: "u1",
					sessionMode: "soft",
					sessionId: "strict-session",
					includeDrafts: true,
					minScore: 0.1,
				},
				{ userId: "u1", agentId: "assistant", sessionId: "strict-session" },
			);

			const toolIds = toolResults.map((r: any) => String(r.id));
			const usecaseIds = usecaseRes.results.map((r) => String(r.id));
			assertEqual(
				toolIds,
				usecaseIds,
				"tool/usecase ordering must stay parity in soft mode",
			);

			const toolScores = toolResults.map((r: any) =>
				Number(r.score.toFixed(6)),
			);
			const usecaseScores = usecaseRes.results.map((r) =>
				Number(r.score.toFixed(6)),
			);
			assertEqual(
				toolScores,
				usecaseScores,
				"tool/usecase scoring must stay parity in soft mode",
			);
		});

		await test("drift detection: auto-recall keeps same-session anchor preference", () => {
			const selection = selectSemanticMemories(
				[
					{
						score: 0.84,
						payload: {
							text: "Parity same session memory",
							namespace: "agent.assistant.working_memory",
							sessionId: "strict-session",
							source_agent: "assistant",
							userId: "u1",
						},
					},
					{
						score: 0.86,
						payload: {
							text: "Parity cross session memory",
							namespace: "agent.assistant.working_memory",
							sessionId: "other-session",
							source_agent: "assistant",
							userId: "u1",
						},
					},
				],
				{
					sessionKey: "agent:assistant:strict-session",
					stateDir: "/tmp",
					userId: "u1",
					agentId: "assistant",
				},
				{
					sessionKeys: new Set([
						"agent:assistant:strict-session",
						"strict-session",
					]),
					topicTags: new Set(["parity", "assistant"]),
					graphTags: new Set(),
				},
			);

			assert(
				selection.memories.length > 0,
				"auto-recall should keep at least one memory",
			);
			assert(
				String(selection.memories[0]?.text || "").includes("same session"),
				"auto-recall top memory should preserve same-session anchor preference",
			);
		});

		await test("precedence check (foundation): injected current-state appears before semantic memories", () => {
			const injected = injectRecallContext("<system>base</system>", {
				currentState:
					"<current-state><project><task>slot-truth</task></project></current-state>",
				projectLivingState: "",
				wikiWorkingSet:
					"<wiki-working-set><wiki-root>/tmp/wiki</wiki-root><entrypoint>index.md</entrypoint></wiki-working-set>",
				graphContext: "",
				recentUpdates: "",
				semanticMemories:
					'<semantic-memories><memory index="1">supporting-evidence</memory></semantic-memories>',
				recallMeta: {
					recall_confidence: "high",
					recall_suppressed: false,
				},
			});

			const slotPos = injected.indexOf("<current-state>");
			const wikiPos = injected.indexOf(
				'<wiki-working-surface precedence="primary">',
			);
			const semanticPos = injected.indexOf(
				'<supporting-recall precedence="support">',
			);
			assert(
				slotPos >= 0 && wikiPos >= 0 && semanticPos >= 0,
				"injected prompt must include slot, wiki, and supporting recall blocks",
			);
			assert(
				slotPos < wikiPos && wikiPos < semanticPos,
				"slot/current-state block should appear before wiki working surface, which should appear before supporting recall",
			);
			assert(
				injected.includes('<slotdb-truth precedence="highest">') &&
					injected.includes('<wiki-working-surface precedence="primary">') &&
					injected.includes('<supporting-recall precedence="support">'),
				"injected prompt should expose explicit precedence wrappers for slot truth, wiki working surface, and supporting recall",
			);
		});

		await test("precedence check (asm-117): semantic evidence appears before graph routing support", () => {
			const injected = injectRecallContext("<system>base</system>", {
				currentState:
					"<current-state><project><task>slot-truth</task></project></current-state>",
				projectLivingState: "",
				wikiWorkingSet:
					"<wiki-working-set><wiki-root>/tmp/wiki</wiki-root><entrypoint>index.md</entrypoint></wiki-working-set>",
				graphContext:
					'<knowledge-graph><entities><entity name="router" type="service"/></entities></knowledge-graph>',
				recentUpdates: "",
				semanticMemories:
					'<semantic-memories><memory index="1">history-evidence</memory></semantic-memories>',
				recallMeta: {
					recall_confidence: "high",
					recall_suppressed: false,
				},
			});

			const semanticPos = injected.indexOf(
				'<supporting-recall precedence="support">',
			);
			const graphPos = injected.indexOf(
				'<graph-routing-support precedence="support">',
			);
			assert(
				semanticPos >= 0 && graphPos >= 0,
				"injected prompt must include semantic and graph precedence wrappers",
			);
			assert(
				semanticPos < graphPos,
				"supporting recall must be injected before graph routing support",
			);
		});

		await test("wiki-first working set selects deterministic page-level surfaces", () => {
			const workingSet = buildWikiWorkingSet({
				namespaces: ["shared.project_context" as any],
				sourceAgent: "assistant",
				query: "Parity same session memory",
				currentProject: "strict-session",
				currentTask: "Parity same session memory",
				activeTaskHints: ["Parity same session memory", "strict-session"],
				graphSignals: ["parity", "strict-session", "memory"],
				includeDrafts: false,
				includeRaw: false,
			});

			assert(
				workingSet !== null,
				"working set should resolve when wiki exists",
			);
			assertEqual(
				workingSet?.entrypoint,
				"index.md",
				"entrypoint should be index.md",
			);
			assert(
				(workingSet?.canonicalPages || []).length > 0,
				"working set should include canonical pages",
			);
			assert(
				(workingSet?.canonicalPages || []).some(
					(page) => page.path === "index.md",
				),
				"working set should include wiki entrypoint as an inspectable page",
			);
			assert(
				(workingSet?.supportingPages || []).every((page, index, pages) => {
					if (index === 0) return true;
					const prev = pages[index - 1];
					return (
						Number(prev.updatedAt || 0) >= Number(page.updatedAt || 0) ||
						prev.path.localeCompare(page.path) <= 0
					);
				}),
				"supporting pages should be deterministically ordered",
			);
			assert(
				(workingSet?.graphAssist.expandedPages || []).length <= 2,
				"graph assist should contribute bounded expansion hints only",
			);
			assert(
				(workingSet?.graphAssist.expandedPages || []).every(
					(page) => page.reason === "graph-assisted expansion hint",
				),
				"graph-expanded pages should remain marked as assistive hints",
			);
		});
	} finally {
		if (previousWikiRoot) process.env.ASM_WIKI_ROOT = previousWikiRoot;
		else delete process.env.ASM_WIKI_ROOT;
		rmSync(wikiRoot, { recursive: true, force: true });
	}

	if (!process.exitCode) {
		console.log("\n🎉 ASM-121 parity gate tests passed");
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
