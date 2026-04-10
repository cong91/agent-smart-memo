import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SlotDB } from "../src/db/slot-db.js";
import {
	captureLongTermPattern,
	captureMidTermSummary,
	captureShortTermState,
	classifyTraderTacticalContent,
	injectMemoryContext,
	registerAutoCapture,
	resolveAutoCaptureSuppressionMeta,
} from "../src/hooks/auto-capture.js";

const TEST_DIR = join(tmpdir(), `agent-memo-cognitive-memory-${Date.now()}`);
const USER = "telegram:dm:test-cognitive";
const AGENT = "scrum";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

class FakeEmbeddingClient {
	async embed(_text: string): Promise<number[]> {
		return Array.from({ length: 8 }, (_, i) => i / 10);
	}
}

class FakePluginApi {
	public tools: any[] = [];
	public hookHandler:
		| ((event: unknown, ctx: unknown) => Promise<void> | void)
		| null = null;

	registerTool(tool: any): void {
		this.tools.push(tool);
	}

	on(
		eventName: string,
		handler: (event: unknown, ctx: unknown) => Promise<void> | void,
	): void {
		if (eventName === "agent_end") {
			this.hookHandler = handler;
		}
	}
}

async function run() {
	console.log("\n🧪 Cognitive Memory Tests\n");

	const dbDir = join(TEST_DIR, "agent-memo");
	if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
	const dbPath = join(dbDir, "slots.db");
	const sqlite = new DatabaseSync(dbPath);
	sqlite.close();

	const slotDB = new SlotDB(TEST_DIR);
	const previousWikiRoot = process.env.ASM_WIKI_ROOT;
	const previousAsmConfig = process.env.ASM_CONFIG;
	const wikiRoot = mkdtempSync(join(tmpdir(), "agent-memo-cognitive-wiki-"));
	process.env.ASM_WIKI_ROOT = wikiRoot;

	let passed = 0;

	// 1) Short-term capture after 3 actions
	{
		const messages = [
			{ role: "user", content: "Action 1: receive request" },
			{ role: "assistant", content: "Action 2: analyze architecture" },
			{ role: "assistant", content: "Action 3: implement feature" },
		] as any;

		const stored = captureShortTermState(
			slotDB,
			USER,
			AGENT,
			messages,
			"Implementing memory tiers",
			3,
		);
		assert(stored, "Short-term should be captured after 3 actions");

		const slot = slotDB.get(USER, AGENT, {
			key: "project_living_state",
		}) as any;
		assert(slot && !Array.isArray(slot), "project_living_state must exist");
		assert(slot.value.ttl === 48 * 3600 * 1000, "Short-term TTL should be 48h");
		passed++;
		console.log("✅ Test 1: Short-term capture after 3 actions");
	}

	// 2) TTL expiration fallback: short-term expired -> mid-term
	{
		const expiredValue = {
			last_actions: ["old action"],
			current_focus: "old focus",
			next_steps: ["old step"],
			timestamp: Date.now() - 49 * 3600 * 1000,
			ttl: 48 * 3600 * 1000,
		};

		slotDB.set(USER, AGENT, {
			key: "project_living_state",
			value: expiredValue,
			category: "project",
			source: "auto_capture",
		});

		const dateKey = new Date(Date.now() - 24 * 3600 * 1000)
			.toISOString()
			.split("T")[0];
		slotDB.set(USER, AGENT, {
			key: `session.${dateKey}.summary`,
			value: {
				summary: "Yesterday summary",
				key_decisions: ["Use fallback"],
				outcomes: ["Recovered context"],
				ttl: 30 * 24 * 3600 * 1000,
				timestamp: Date.now(),
			},
			category: "custom",
			source: "auto_capture",
		});

		const context = await injectMemoryContext(AGENT, {
			db: slotDB,
			userId: USER,
			query: "recent context",
		});

		assert(
			context.includes("MID_TERM:"),
			"Should fallback to mid-term when short-term expired",
		);
		passed++;
		console.log("✅ Test 2: TTL expiration fallback short -> mid");
	}

	// 3) End-of-day summary creation
	{
		const msgs = [
			{ role: "user", content: "Quyết định chốt kiến trúc" },
			{
				role: "assistant",
				content: "completed implementation and deployed staging",
			},
		] as any;

		const result = await captureMidTermSummary(slotDB, {
			userId: USER,
			agentId: AGENT,
			sessionKey: "agent:scrum:test-cognitive",
			messages: msgs,
			sessionEnding: true,
			lastMidTermCaptureAt: Date.now(),
			now: Date.now(),
		});

		assert(result.stored, "Mid-term summary should store on session ending");

		const key = `session.${new Date().toISOString().split("T")[0]}.summary`;
		const slot = slotDB.get(USER, AGENT, { key }) as any;
		assert(slot && !Array.isArray(slot), "session summary slot must exist");
		assert(
			slot.value.ttl === 30 * 24 * 3600 * 1000,
			"Mid-term TTL should be 30d",
		);
		const sharedRunbookLivePath = join(
			wikiRoot,
			"live",
			"entities",
			"scrum",
			"telegram-dm-test-cognitive-agent-scrum-test-cognitive.md",
		);
		assert(
			existsSync(sharedRunbookLivePath),
			"Should write summary into wiki shared.runbooks namespace",
		);
		passed++;
		console.log("✅ Test 3: End-of-day mid-term summary creation");
	}

	// 4) Important pattern detection -> long-term store
	{
		const stored = await captureLongTermPattern({
			text: "Critical exploit detected with major drawdown and SEC regulation response",
			agentId: AGENT,
			userId: USER,
		});

		assert(stored, "Important pattern should be stored to long-term memory");
		const lessonsLivePath = join(
			wikiRoot,
			"live",
			"concepts",
			"scrum",
			"telegram-dm-test-cognitive-shared.md",
		);
		assert(
			existsSync(lessonsLivePath),
			"Long-term namespace must follow normalized agent lessons namespace",
		);
		const lessonsLiveContent = readFileSync(lessonsLivePath, "utf8");
		assert(
			lessonsLiveContent.includes("namespace: agent.scrum.lessons"),
			"Long-term lesson capture should persist canonical lessons namespace metadata",
		);
		passed++;
		console.log("✅ Test 4: Important pattern -> long-term memory store");
	}

	// 5) Agent wake -> memory context injection without legacy Qdrant long-term fallback
	{
		slotDB.delete(USER, AGENT, "project_living_state");
		const dateKey = new Date(Date.now() - 24 * 3600 * 1000)
			.toISOString()
			.split("T")[0];
		slotDB.delete(USER, AGENT, `session.${dateKey}.summary`);

		const context = await injectMemoryContext(AGENT, {
			db: slotDB,
			userId: USER,
			query: "recent context",
		});

		assert(
			context.length === 0,
			"Should not fallback to legacy long-term semantic memories when short/mid-term are missing",
		);
		passed++;
		console.log(
			"✅ Test 5: Agent wake memory context injection without legacy long-term fallback",
		);
	}

	// 6) Trader tactical classifier suppression metadata
	{
		const tactical = classifyTraderTacticalContent(
			"wake payload: decision packet -> HOLD rationale because risk execution case is unresolved",
			"trader",
		);
		assert(
			tactical.isTraderTactical,
			"Trader tactical content should be detected",
		);
		assert(tactical.suppressed, "Trader tactical content should be suppressed");
		assert(
			tactical.matchedClasses.includes("wake_payload"),
			"Should classify wake payload",
		);
		assert(
			tactical.matchedClasses.includes("decision_packet"),
			"Should classify decision packet",
		);

		const suppression = resolveAutoCaptureSuppressionMeta(
			"SKIP rationale vì invalidated assumption after post-close review",
			"trader",
		);
		assert(
			suppression !== null,
			"Suppression metadata should be returned for trader tactical payload",
		);
		assert(
			suppression?.reason ===
				"suppressed.trader_tactical_owned_by_trader_brain_plugin",
			"Suppression reason should be structured and deterministic",
		);

		const generic = resolveAutoCaptureSuppressionMeta(
			"Tôi đang sống ở Hà Nội và thích dark theme",
			"assistant",
		);
		assert(generic === null, "Generic/shared content should not be suppressed");

		passed++;
		console.log("✅ Test 6: Trader tactical classifier + suppression metadata");
	}

	// 7) Auto-capture hook suppresses trader tactical, preserves generic capture
	{
		const hookDb = new SlotDB(TEST_DIR);
		const api = new FakePluginApi() as any;
		registerAutoCapture(api, hookDb as any, {
			useLLM: false,
		});

		assert(
			typeof api.hookHandler === "function",
			"agent_end hook must be registered",
		);

		const tacticalEvent: any = {
			messages: [
				{
					role: "user",
					content:
						"wake payload + decision packet: HOLD rationale because risk execution case unresolved",
				},
			],
			metadata: {},
		};
		await api.hookHandler!(tacticalEvent, {
			sessionKey: "agent:trader:test-cognitive",
			messageProvider: "chat",
		});

		const suppressionMeta = tacticalEvent.metadata?.autoCaptureSuppression;
		assert(
			Boolean(suppressionMeta),
			"Suppression metadata should be attached to event metadata",
		);
		assert(
			suppressionMeta.reason ===
				"suppressed.trader_tactical_owned_by_trader_brain_plugin",
			"Suppression metadata reason should match expected structured reason",
		);

		const tacticalHash = hookDb.get(USER, "trader", {
			key: "_autocapture_hash",
		});
		assert(
			!tacticalHash || Array.isArray(tacticalHash),
			"Suppressed trader tactical event should not write generic auto-capture hash",
		);

		const genericEvent: any = {
			messages: [
				{ role: "user", content: "tên tôi là Trần B và tôi thích dark theme" },
			],
			metadata: {},
		};
		await api.hookHandler!(genericEvent, {
			sessionKey: "agent:assistant:test-cognitive",
			messageProvider: "chat",
		});

		const genericHash = hookDb.get("default", "assistant", {
			key: "_autocapture_hash",
		});
		assert(
			Boolean(genericHash && !Array.isArray(genericHash)),
			"Generic content should continue through auto-capture path",
		);

		hookDb.close();
		passed++;
		console.log(
			"✅ Test 7: Hook suppression for trader tactical + generic passthrough",
		);
	}

	// 8) Bootstrap-safe raw-first capture: no LLM still writes wiki raw/live/briefing
	{
		const hookDb = new SlotDB(TEST_DIR);
		const api = new FakePluginApi() as any;
		registerAutoCapture(api, hookDb as any, {
			useLLM: false,
			bootstrapSafeRawFirst: true,
		});

		assert(
			typeof api.hookHandler === "function",
			"agent_end hook must be registered for bootstrap-safe test",
		);

		await api.hookHandler!(
			{
				messages: [
					{
						role: "user",
						content:
							"Bootstrap run in fresh environment without distill capability",
					},
					{
						role: "assistant",
						content:
							"Acknowledged: preserve SlotDB state and write deterministic wiki briefing",
					},
				],
				metadata: {},
			},
			{
				sessionKey: "agent:assistant:test-cognitive-bootstrap-safe",
				messageProvider: "chat",
			},
		);

		const hasBootstrapRaw = existsSync(join(wikiRoot, "raw"));
		const hasBootstrapBriefing = existsSync(join(wikiRoot, "briefings"));
		const hasBootstrapLive = existsSync(join(wikiRoot, "live", "entities"));
		assert(
			hasBootstrapRaw && hasBootstrapBriefing && hasBootstrapLive,
			"bootstrap-safe mode should materialize raw/live/briefings folders without LLM distill",
		);

		const briefingDir = join(wikiRoot, "briefings");
		const briefingFiles = readdirSync(briefingDir).filter((name) =>
			name.endsWith(".md"),
		);
		assert(
			briefingFiles.length > 0,
			"bootstrap-safe mode should produce at least one briefing markdown",
		);

		const briefingContent = readFileSync(
			join(briefingDir, briefingFiles[0]),
			"utf8",
		);
		assert(
			briefingContent.includes("Briefing"),
			"bootstrap-safe briefing should include deterministic briefing header",
		);

		hookDb.close();
		passed++;
		console.log(
			"✅ Test 8: Bootstrap-safe raw-first capture without LLM distill",
		);
	}

	// 9) Isolated continuation fallback happens at execution boundary (no pre-health gate)
	{
		const hookDb = new SlotDB(TEST_DIR);
		const api = new FakePluginApi() as any;

		const missingConfigPath = join(
			TEST_DIR,
			`missing-asm-config-${Date.now()}.json`,
		);
		process.env.ASM_CONFIG = missingConfigPath;

		const capturedLogs: string[] = [];
		const capturedWarns: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		console.log = (...args: unknown[]) => {
			capturedLogs.push(args.map((arg) => String(arg)).join(" "));
			originalLog(...args);
		};
		console.warn = (...args: unknown[]) => {
			capturedWarns.push(args.map((arg) => String(arg)).join(" "));
			originalWarn(...args);
		};

		try {
			registerAutoCapture(api, hookDb as any, {
				useLLM: true,
				bootstrapSafeRawFirst: true,
			});

			assert(
				typeof api.hookHandler === "function",
				"agent_end hook must be registered for isolated-continuation fallback test",
			);

			await api.hookHandler!(
				{
					messages: [
						{
							role: "user",
							content:
								"Operator approved implementation packet for bead r4t.28. Next-step handoff is required with blockers and ETA.",
						},
					],
					metadata: {},
				},
				{
					sessionKey: "agent:assistant:test-cognitive-boundary-fallback",
					messageProvider: "chat",
				},
			);

			const allLogs = [...capturedLogs, ...capturedWarns].join("\n");
			assert(
				!allLogs.includes("LLM unavailable, using pattern fallback"),
				"Legacy LLM health-gated fallback log must not appear",
			);
			assert(
				!allLogs.includes(
					"Isolated continuation distill unavailable, using pattern fallback",
				),
				"Host runtime must not perform fallback translation after continuation call",
			);
			assert(
				allLogs.includes("engine=native_continuation"),
				"Continuation boundary should log native continuation execution path",
			);
			assert(
				capturedLogs.concat(capturedWarns).some((line) => {
					const normalized = String(line || "").toLowerCase();
					return (
						normalized.includes("missing continuation structured contract") ||
						normalized.includes(
							"empty continuation structured contract for actionable context",
						) ||
						normalized.includes(
							"continuation structured contract produced by real continuation session owner",
						)
					);
				}),
				"Continuation boundary should rely on continuation-owned contract instead of translating through host-side fallback logic",
			);

			assert(
				existsSync(join(wikiRoot, "raw")) &&
					existsSync(join(wikiRoot, "briefings")),
				"Boundary fallback should still preserve bootstrap-safe raw/briefing writes",
			);

			passed++;
			console.log(
				"✅ Test 9: Isolated continuation boundary fallback without legacy health gate",
			);
		} finally {
			console.log = originalLog;
			console.warn = originalWarn;
			hookDb.close();
		}
	}

	slotDB.close();
	if (previousWikiRoot) process.env.ASM_WIKI_ROOT = previousWikiRoot;
	else delete process.env.ASM_WIKI_ROOT;
	if (previousAsmConfig) process.env.ASM_CONFIG = previousAsmConfig;
	else delete process.env.ASM_CONFIG;
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {}
	try {
		rmSync(wikiRoot, { recursive: true, force: true });
	} catch {}

	console.log(`\n🎉 Cognitive memory tests passed: ${passed}/9\n`);
}

run().catch((err) => {
	console.error("❌ Cognitive memory tests failed:", err);
	process.exit(1);
});
