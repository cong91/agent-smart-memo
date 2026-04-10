import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SemanticMemoryUseCase,
	searchWikiMemory,
	writeWikiMemoryCapture,
} from "../src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "../src/services/dedupe.js";
import { extractWithIsolatedContinuation } from "../src/services/llm-extractor.js";

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

class MockEmbedding {
	async embed(text: string): Promise<number[]> {
		const seed = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0);
		return [seed % 97, seed % 89, seed % 83].map((n) =>
			Number((n / 100).toFixed(3)),
		);
	}

	async embedDetailed(
		text: string,
	): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
		return {
			vector: await this.embed(text),
			metadata: {
				embedding_model: "mock",
				embedding_provider: "mock",
			},
		};
	}
}

class MockQdrant {}

async function run() {
	console.log("\n🧪 Semantic Memory UseCase Tests\n");

	const qdrant = new MockQdrant();
	const embedding = new MockEmbedding();
	const dedupe = new DeduplicationService(0.95, console);
	const usecase = new SemanticMemoryUseCase(
		qdrant as any,
		embedding as any,
		dedupe,
	);

	const context = { userId: "u1", agentId: "assistant", sessionId: "s1" };
	const previousWikiRoot = process.env.ASM_WIKI_ROOT;
	const previousBackend = process.env.ASM_WIKI_STORAGE_BACKEND;
	const wikiRoot = mkdtempSync(join(tmpdir(), "asm-wiki-write-"));
	process.env.ASM_WIKI_ROOT = wikiRoot;
	let qmdWikiRoot: string | null = null;

	try {
		const hostLogs: string[] = [];
		const originalLog = console.log;
		let isolatedContractResult: Awaited<
			ReturnType<typeof extractWithIsolatedContinuation>
		>;
		console.log = (...args: unknown[]) => {
			hostLogs.push(args.map((arg) => String(arg)).join(" "));
			originalLog(...args);
		};
		try {
			isolatedContractResult = await extractWithIsolatedContinuation(
				"user: tên tôi là Trần B, tôi sống ở Hà Nội và đang làm asm boundary cleanup",
				{
					project: {
						"project.current": "phase-2-distill",
					},
				},
				"general",
				{
					agentId: "assistant",
					sourceSessionKey: "agent:assistant:test-session",
					timeoutMs: 8000,
				},
			);
		} finally {
			console.log = originalLog;
		}

		assert(
			!hostLogs.some((line) => line.includes("[LLMExtractor] Distilled")),
			"host orchestration path must not run local distill core",
		);

		assert(
			isolatedContractResult.log_entries.some((entry: any) =>
				String(entry?.text || "").includes(
					"missing continuation structured contract",
				),
			),
			"without continuation-owned structured contract, isolated continuation should fail closed instead of using local extractor fallback",
		);

		assert(
			Array.isArray(isolatedContractResult.slot_updates),
			"isolated continuation result should include slot_updates array",
		);
		assert(
			Array.isArray(isolatedContractResult.slot_removals),
			"isolated continuation result should include slot_removals array",
		);
		assert(
			Array.isArray(isolatedContractResult.memories),
			"isolated continuation result should include memories array",
		);
		assert(
			Array.isArray(isolatedContractResult.draft_updates),
			"isolated continuation result should include draft_updates array",
		);
		assert(
			Array.isArray(isolatedContractResult.briefing_updates),
			"isolated continuation result should include briefing_updates array",
		);
		assert(
			Array.isArray(isolatedContractResult.log_entries),
			"isolated continuation result should include log_entries array",
		);
		assert(
			Array.isArray(isolatedContractResult.promotion_hints),
			"isolated continuation result should include promotion_hints array",
		);
		assert(
			isolatedContractResult.log_entries.some((entry: any) =>
				String(entry?.text || "").includes(
					"isolated continuation distill session=",
				),
			),
			"isolated continuation result should include session lineage log entry",
		);
		assert(
			isolatedContractResult.log_entries.some((entry: any) =>
				String(entry?.text || "").includes("engine=native_continuation"),
			),
			"isolated continuation result should include native continuation execution marker",
		);

		const planningConversation = [
			"user: Operator approved the implementation plan for bead agent-smart-memo-r4t.25.",
			"assistant: Next step is implementation packet prep, then handoff with blockers and ETA.",
			"user: Non-negotiable constraint: preserve safe fallback semantics and Extractor/Distill/Apply boundary.",
		].join("\n");

		const planningResult = await extractWithIsolatedContinuation(
			planningConversation,
			{
				project: {
					"project.current_task": "triage prompt issue",
				},
			},
			"general",
			{
				agentId: "assistant",
				sourceSessionKey: "agent:assistant:planning-session",
				timeoutMs: 12000,
			},
			{
				bootstrapSafeRawFirst: true,
				contextMessages: [
					{
						role: "user",
						text: "Operator approved plan for r4t.25. Prepare implementation packet and next-step handoff.",
					},
					{
						role: "assistant",
						text: "Will execute prompt/extraction policy changes while preserving fallback guarantees.",
					},
				],
			},
		);

		assert(
			planningResult.log_entries.some((entry: any) =>
				String(entry?.text || "").includes(
					"missing continuation structured contract",
				),
			),
			"planning/task-context case should fail closed when continuation session does not own a structured contract",
		);
		assert(
			planningResult.log_entries.some((entry: any) =>
				String(entry?.text || "").includes("engine=native_continuation"),
			),
			"planning/task-context case should record native continuation execution marker",
		);

		const neutralResult = await extractWithIsolatedContinuation(
			"user: chào bạn\nassistant: chào bạn, mình sẵn sàng hỗ trợ.",
			{},
			"general",
			{
				agentId: "assistant",
				sourceSessionKey: "agent:assistant:neutral-session",
				timeoutMs: 12000,
			},
			{
				bootstrapSafeRawFirst: true,
				contextMessages: [
					{ role: "user", text: "chào bạn" },
					{ role: "assistant", text: "chào bạn" },
				],
			},
		);

		const neutralStructuredCount =
			neutralResult.slot_updates.length +
			neutralResult.slot_removals.length +
			neutralResult.memories.length +
			neutralResult.draft_updates.length +
			neutralResult.briefing_updates.length +
			neutralResult.promotion_hints.length;

		assert(
			neutralStructuredCount === 0,
			"non-actionable generic chatter may remain all-empty",
		);
		assert(
			neutralResult.log_entries.some((entry: any) =>
				String(entry?.text || "")
					.toLowerCase()
					.includes("missing continuation structured contract"),
			),
			"non-actionable case should also fail closed when no continuation-owned structured contract is available",
		);

		const captureRes = await usecase.capture(
			{
				text: "ASM-43 semantic usecase path is wired",
				namespace: "assistant",
				metadata: { source: "test" },
			},
			context,
		);

		assert(captureRes.created === true, "capture should create point");
		assert(
			captureRes.namespace === "agent.assistant.working_memory",
			"alias namespace must be canonicalized",
		);
		assert(
			existsSync(join(wikiRoot, "raw")),
			"capture should bootstrap wiki raw directory",
		);
		assert(
			existsSync(join(wikiRoot, "drafts", "entities", "assistant", "u1-s1.md")),
			"capture should materialize grouped draft page for raw",
		);
		assert(
			existsSync(join(wikiRoot, "index.md")) &&
				existsSync(join(wikiRoot, "log.md")) &&
				existsSync(join(wikiRoot, "schema.md")),
			"capture should bootstrap index/log/schema files",
		);

		const draftPage = readFileSync(
			join(wikiRoot, "drafts", "entities", "assistant", "u1-s1.md"),
			"utf8",
		);
		assert(
			draftPage.includes("memory_scope: agent"),
			"capture draft page should include memory_scope=agent",
		);
		assert(
			draftPage.includes("memory_type: episodic_trace"),
			"capture draft page should include memory_type=episodic_trace",
		);
		assert(
			draftPage.includes("promotion_state: raw"),
			"capture draft page should include promotion_state=raw",
		);
		assert(
			draftPage.includes("confidence:"),
			"capture draft page should include confidence",
		);

		const searchRes = await usecase.search(
			{
				query: "semantic usecase path",
				namespace: "assistant",
				minScore: 0.1,
				includeDrafts: true,
			},
			context,
		);

		assert(searchRes.count >= 1, "search should return result");
		assert(
			searchRes.results[0].namespace === "agent.assistant.working_memory",
			"search namespace should match canonical",
		);
		assert(
			String(searchRes.results[0]?.id || "").startsWith("wiki:"),
			"search should now resolve from wiki artifacts",
		);

		const duplicate = await usecase.capture(
			{
				text: "ASM-43 semantic usecase path is wired",
				namespace: "assistant",
			},
			context,
		);
		assert(
			duplicate.updated === true,
			"duplicate capture should update existing wiki entry",
		);

		const deterministicTimestamp = "2026-04-07T00:00:00.000Z";
		const deterministicCaptureB = writeWikiMemoryCapture({
			text: "ASM deterministic tie-break item B",
			namespace: "agent.assistant.working_memory",
			sourceAgent: "assistant",
			sourceType: "auto_capture",
			memoryScope: "agent",
			memoryType: "episodic_trace",
			promotionState: "distilled",
			confidence: 0.9,
			timestamp: deterministicTimestamp,
			updatedAt: deterministicTimestamp,
			sessionId: "s1",
			userId: "u1",
		});
		const deterministicCaptureA = writeWikiMemoryCapture({
			text: "ASM deterministic tie-break item A",
			namespace: "agent.assistant.working_memory",
			sourceAgent: "assistant",
			sourceType: "auto_capture",
			memoryScope: "agent",
			memoryType: "episodic_trace",
			promotionState: "distilled",
			confidence: 0.9,
			timestamp: deterministicTimestamp,
			updatedAt: deterministicTimestamp,
			sessionId: "s1",
			userId: "u1",
		});

		const deterministicBriefing = readFileSync(
			join(wikiRoot, "briefings", "entities-assistant-u1-s1.md"),
			"utf8",
		);
		const idxA = deterministicBriefing.indexOf(
			"ASM deterministic tie-break item A",
		);
		const idxB = deterministicBriefing.indexOf(
			"ASM deterministic tie-break item B",
		);
		assert(
			idxA >= 0 && idxB >= 0,
			"briefing should include deterministic tie-break entries",
		);
		const tieBreakerById =
			deterministicCaptureA.id.localeCompare(deterministicCaptureB.id) < 0
				? idxA < idxB
				: idxB < idxA;
		assert(
			tieBreakerById,
			"briefing order should be deterministic for same timestamp entries via id tie-break",
		);

		await usecase.capture(
			{
				text: "ASM-43 strict session only",
				namespace: "assistant",
				sessionId: "strict-session",
			},
			{ ...context, sessionId: "strict-session" },
		);
		await usecase.capture(
			{
				text: "ASM-43 cross session note",
				namespace: "assistant",
				sessionId: "other-session",
			},
			{ ...context, sessionId: "other-session" },
		);

		const strictSearch = await usecase.search(
			{
				query: "session",
				namespace: "assistant",
				minScore: 0.1,
				sessionMode: "strict",
				sessionId: "strict-session",
				includeDrafts: true,
			},
			context,
		);
		assert(
			strictSearch.results.every(
				(r) =>
					String(r.text).includes("strict session") ||
					String(r.text).includes("semantic usecase"),
			),
			"strict mode should constrain to the requested session results",
		);

		const softSearch = await usecase.search(
			{
				query: "session",
				namespace: "assistant",
				minScore: 0.1,
				sessionMode: "soft",
				sessionId: "strict-session",
				includeDrafts: true,
			},
			context,
		);
		assert(
			softSearch.results.some((r) => String(r.text).includes("cross session")),
			"soft mode should still allow cross-session results",
		);

		const projectCapture = await usecase.capture(
			{
				text: "ASM-43 project scoped capture",
				namespace: "project_context",
			},
			context,
		);
		const projectLivePage = readFileSync(
			join(wikiRoot, "drafts", "projects", "u1", "s1.md"),
			"utf8",
		);
		assert(
			projectCapture.namespace === "shared.project_context",
			"project_context capture should keep shared.project_context namespace",
		);
		assert(
			projectLivePage.includes("memory_scope: project"),
			"project_context should map to memory_scope=project",
		);
		assert(
			projectLivePage.includes("memory_type: task_context"),
			"project_context should map to memory_type=task_context",
		);

		mkdirSync(join(wikiRoot, "briefings"), { recursive: true });
		writeFileSync(
			join(wikiRoot, "briefings", "assistant.md"),
			[
				"---",
				"namespace: agent.assistant.working_memory",
				"sessionId: strict-session",
				"userId: u1",
				"source_agent: assistant",
				"title: Wiki Semantic Briefing",
				"---",
				"ASM wiki retrieval lane semantic usecase evidence from wiki briefing.",
			].join("\n"),
			"utf8",
		);

		const wikiSearch = await usecase.search(
			{
				query: "wiki retrieval lane semantic usecase evidence",
				namespace: "assistant",
				minScore: 0.1,
				sessionMode: "strict",
				sessionId: "strict-session",
			},
			context,
		);

		assert(
			wikiSearch.count >= 1,
			"wiki-first search should return at least one hit",
		);
		assert(
			String(wikiSearch.results[0]?.id || "").startsWith("wiki:"),
			"wiki-first search should return wiki-scoped ids",
		);
		assert(
			String(wikiSearch.results[0]?.metadata?.source_type || "") === "wiki",
			"wiki-first search should label source_type=wiki",
		);

		qmdWikiRoot = mkdtempSync(join(tmpdir(), "asm-qmd-write-"));
		process.env.ASM_WIKI_ROOT = qmdWikiRoot;
		process.env.ASM_WIKI_STORAGE_BACKEND = "qmd";

		writeWikiMemoryCapture({
			text: "QMD draft-only zephyr-quartz sentinel",
			namespace: "agent.assistant.working_memory",
			sourceAgent: "assistant",
			sourceType: "auto_capture",
			memoryScope: "agent",
			memoryType: "episodic_trace",
			promotionState: "raw",
			confidence: 0.8,
			sessionId: "qmd-session",
			userId: "u1",
		});
		writeWikiMemoryCapture({
			text: "QMD live canonical retrieval signal",
			namespace: "agent.assistant.working_memory",
			sourceAgent: "assistant",
			sourceType: "auto_capture",
			memoryScope: "agent",
			memoryType: "episodic_trace",
			promotionState: "distilled",
			confidence: 0.92,
			sessionId: "qmd-session",
			userId: "u1",
		});

		const qmdDefaultDraftExcluded = searchWikiMemory({
			query: "zephyr-quartz sentinel",
			limit: 5,
			minScore: 0.1,
			namespaces: ["agent.assistant.working_memory"],
			sourceAgent: "assistant",
			sessionMode: "soft",
			preferredSessionId: "qmd-session",
			userId: "u1",
		});
		assert(
			qmdDefaultDraftExcluded.length === 0,
			"QMD default search must exclude drafts unless includeDrafts=true",
		);

		const qmdDraftIncluded = searchWikiMemory({
			query: "zephyr-quartz sentinel",
			limit: 5,
			minScore: 0.1,
			namespaces: ["agent.assistant.working_memory"],
			sourceAgent: "assistant",
			sessionMode: "soft",
			preferredSessionId: "qmd-session",
			userId: "u1",
			includeDrafts: true,
		});
		assert(
			qmdDraftIncluded.length >= 1,
			"QMD search should return draft content when includeDrafts=true",
		);

		const qmdLiveResults = searchWikiMemory({
			query: "live canonical retrieval signal",
			limit: 5,
			minScore: 0.1,
			namespaces: ["agent.assistant.working_memory"],
			sourceAgent: "assistant",
			sessionMode: "soft",
			preferredSessionId: "qmd-session",
			userId: "u1",
		});
		assert(
			qmdLiveResults.length >= 1,
			"QMD default search should retrieve live canonical entries",
		);
		assert(
			String(qmdLiveResults[0]?.id || "").startsWith("wiki-qmd:"),
			"QMD search ids should be wiki-qmd scoped",
		);

		const qmdRootPath = join(qmdWikiRoot, "wiki-qmd");
		const countQmdFiles = (root: string): number => {
			if (!existsSync(root)) return 0;
			let total = 0;
			for (const name of readdirSync(root)) {
				const abs = join(root, name);
				const st = statSync(abs);
				if (st.isDirectory()) {
					total += countQmdFiles(abs);
				} else if (name.endsWith(".qmd")) {
					total += 1;
				}
			}
			return total;
		};
		assert(
			countQmdFiles(qmdRootPath) > 0,
			"QMD flow should materialize non-zero .qmd files",
		);
	} finally {
		if (previousWikiRoot) process.env.ASM_WIKI_ROOT = previousWikiRoot;
		else delete process.env.ASM_WIKI_ROOT;
		if (previousBackend) process.env.ASM_WIKI_STORAGE_BACKEND = previousBackend;
		else delete process.env.ASM_WIKI_STORAGE_BACKEND;
		rmSync(wikiRoot, { recursive: true, force: true });
		if (qmdWikiRoot) rmSync(qmdWikiRoot, { recursive: true, force: true });
	}

	console.log("✅ semantic memory usecase tests passed\n");
}

run().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
