import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";
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

class MockQdrant {
	public points: any[] = [];

	async upsert(points: any[]): Promise<void> {
		for (const p of points) {
			const idx = this.points.findIndex((x) => x.id === p.id);
			if (idx >= 0) this.points[idx] = p;
			else this.points.push(p);
		}
	}

	async search(_vector: number[], limit = 5, filter?: any): Promise<any[]> {
		const filtered = this.points.filter((p) => {
			const must = filter?.must || [];
			return must.every((m: any) => {
				if (Array.isArray(m.should)) {
					return m.should.some((s: any) => this.matchLeaf(p.payload, s));
				}
				return this.matchLeaf(p.payload, m);
			});
		});

		return filtered.slice(0, limit).map((p) => ({
			id: p.id,
			score:
				typeof p.payload?.mockScore === "number" ? p.payload.mockScore : 0.9,
			payload: p.payload,
		}));
	}

	private matchLeaf(payload: any, cond: any): boolean {
		const key = cond?.key;
		const val = cond?.match?.value;
		if (!key) return true;
		return payload?.[key] === val;
	}
}

async function main() {
	const qdrant = new MockQdrant();
	const embedding = new MockEmbedding();
	const dedupe = new DeduplicationService(0.95, console);
	const memorySearch = createMemorySearchTool(
		qdrant as any,
		embedding as any,
		"shared.project_context",
	);
	const usecase = new SemanticMemoryUseCase(
		qdrant as any,
		embedding as any,
		dedupe,
	);

	await qdrant.upsert([
		{
			id: "p-same-session",
			vector: [0.1, 0.2, 0.3, 0.4],
			payload: {
				text: "Parity same session memory",
				namespace: "agent.assistant.working_memory",
				sessionId: "strict-session",
				source_agent: "assistant",
				userId: "u1",
				mockScore: 0.84,
				timestamp: Date.now(),
			},
		},
		{
			id: "p-cross-session",
			vector: [0.2, 0.2, 0.3, 0.5],
			payload: {
				text: "Parity cross session memory",
				namespace: "agent.assistant.working_memory",
				sessionId: "other-session",
				source_agent: "assistant",
				userId: "u1",
				mockScore: 0.86,
				timestamp: Date.now(),
			},
		},
	]);

	await test("strict mode parity: tool + usecase both hard-filter session", async () => {
		const toolRes = await memorySearch.execute("p1", {
			query: "parity strict",
			namespace: "assistant" as any,
			agentId: "assistant",
			userId: "u1",
			sessionMode: "strict",
			sessionId: "strict-session",
			minScore: 0.1,
		});
		assert(toolRes.isError !== true, "tool strict search must succeed");
		const toolIds = ((toolRes as any).details?.results || []).map((r: any) =>
			String(r.id),
		);

		const usecaseRes = await usecase.search(
			{
				query: "parity strict",
				namespace: "assistant",
				userId: "u1",
				sessionMode: "strict",
				sessionId: "strict-session",
				minScore: 0.1,
			},
			{ userId: "u1", agentId: "assistant", sessionId: "strict-session" },
		);
		const usecaseIds = usecaseRes.results.map((r) => String(r.id));

		assertEqual(
			toolIds,
			["p-same-session"],
			"tool strict must return only same session",
		);
		assertEqual(
			usecaseIds,
			["p-same-session"],
			"usecase strict must return only same session",
		);
	});

	await test("soft mode parity: tool + usecase return identical ordering/signature", async () => {
		const toolRes = await memorySearch.execute("p2", {
			query: "parity soft",
			namespace: "assistant" as any,
			agentId: "assistant",
			userId: "u1",
			sessionMode: "soft",
			sessionId: "strict-session",
			minScore: 0.1,
		});
		assert(toolRes.isError !== true, "tool soft search must succeed");
		const toolResults = (toolRes as any).details?.results || [];

		const usecaseRes = await usecase.search(
			{
				query: "parity soft",
				namespace: "assistant",
				userId: "u1",
				sessionMode: "soft",
				sessionId: "strict-session",
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

		const toolScores = toolResults.map((r: any) => Number(r.score.toFixed(6)));
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
					payload: qdrant.points.find((p) => p.id === "p-same-session")
						?.payload,
				},
				{
					score: 0.86,
					payload: qdrant.points.find((p) => p.id === "p-cross-session")
						?.payload,
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
		const semanticPos = injected.indexOf("<semantic-memories>");
		assert(
			slotPos >= 0 && semanticPos >= 0,
			"injected prompt must include both slot and semantic blocks",
		);
		assert(
			slotPos < semanticPos,
			"slot/current-state block should appear before semantic memories block",
		);
		assert(
			injected.includes('<slotdb-truth precedence="highest">') &&
				injected.includes('<semantic-evidence precedence="medium">'),
			"injected prompt should expose explicit precedence wrappers for slot truth and semantic evidence",
		);
	});

	await test("precedence check (asm-117): semantic evidence appears before graph routing support", () => {
		const injected = injectRecallContext("<system>base</system>", {
			currentState:
				"<current-state><project><task>slot-truth</task></project></current-state>",
			projectLivingState: "",
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
			'<semantic-evidence precedence="medium">',
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
			"semantic evidence must be injected before graph routing support",
		);
	});

	if (!process.exitCode) {
		console.log("\n🎉 ASM-121 parity gate tests passed");
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
