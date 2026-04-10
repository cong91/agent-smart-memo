import { selectSemanticMemories } from "../src/hooks/auto-recall.js";

function assert(condition: boolean, message: string): void {
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

const ctx = {
	sessionKey: "agent:assistant:taa-thread-1",
	stateDir: "/tmp",
	userId: "u1",
	agentId: "assistant",
};

test("same-thread beats cross-thread", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.9,
				payload: {
					text: "Facebook planning milestone",
					namespace: "shared.project_context",
					sessionId: "fb-thread-9",
					project_tag: "facebook",
					timestamp: now - 4 * 24 * 60 * 60 * 1000,
				},
			},
			{
				score: 0.82,
				payload: {
					text: "TAA trade guardrail decision",
					namespace: "shared.project_context",
					sessionId: "taa-thread-1",
					project_tag: "taa",
					timestamp: now - 10 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(),
		},
	);

	assert(selected.memories.length > 0, "expected at least one recalled memory");
	assert(
		selected.memories[0].text.includes("TAA trade guardrail"),
		"same-thread memory should rank first",
	);
});

test("same-project beats cross-project", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.88,
				payload: {
					text: "Facebook roadmap checkpoint",
					namespace: "shared.project_context",
					project_tag: "facebook",
					timestamp: now - 20 * 60 * 1000,
				},
			},
			{
				score: 0.78,
				payload: {
					text: "TAA bypass tuning note",
					namespace: "shared.project_context",
					project_tag: "taa",
					timestamp: now - 20 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(),
		},
	);

	assert(selected.memories.length > 0, "expected at least one recalled memory");
	assert(
		selected.memories[0].text.includes("TAA bypass tuning"),
		"same-project memory should rank first",
	);
});

test("graph-aligned support can break close ties without replacing scope anchors", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.79,
				payload: {
					text: "TAA bypass tuning note with order graph alignment",
					namespace: "shared.project_context",
					project_tag: "taa",
					tags: ["order-router", "risk-engine"],
					timestamp: now - 20 * 60 * 1000,
				},
			},
			{
				score: 0.81,
				payload: {
					text: "TAA backlog checkpoint without graph hints",
					namespace: "shared.project_context",
					project_tag: "taa",
					timestamp: now - 20 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(["order-router", "risk-engine"]),
		},
	);

	assert(selected.memories.length > 0, "expected at least one recalled memory");
	assert(
		selected.memories[0].text.includes("graph alignment"),
		"graph-aligned supporting recall should win close ties when scope is already anchored",
	);
});

test("supporting recall is suppressed when no wiki/session/project anchor exists", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.95,
				payload: {
					text: "Order router snippet matched only by graph hints",
					namespace: "shared.project_context",
					tags: ["order-router", "risk-engine"],
					timestamp: now - 5 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(["order-router", "risk-engine"]),
		},
	);

	assert(
		selected.suppressed,
		"graph-only supporting recall should be suppressed",
	);
	assert(
		selected.suppressionReason === "missing_scope_anchor",
		"graph-only supporting recall must not replace wiki/session/project anchors",
	);
	assert(
		selected.memories.length === 0,
		"graph-only support should not inject semantic memories",
	);
});

test("mixed-topic top hits are suppressed with low confidence", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.89,
				payload: {
					text: "Facebook sprint planning",
					namespace: "shared.project_context",
					project_tag: "facebook",
					timestamp: now - 30 * 60 * 1000,
				},
			},
			{
				score: 0.86,
				payload: {
					text: "Instagram ad experiment",
					namespace: "shared.project_context",
					project_tag: "instagram",
					timestamp: now - 45 * 60 * 1000,
				},
			},
			{
				score: 0.82,
				payload: {
					text: "Meta quarterly OKR",
					namespace: "shared.project_context",
					project_tag: "meta",
					timestamp: now - 50 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(),
		},
	);

	assert(
		selected.recallConfidence === "low",
		"recall confidence should be low",
	);
	assert(
		selected.suppressed,
		"recall should be suppressed for mixed/cross-topic results",
	);
	assert(
		selected.memories.length === 0,
		"suppressed recall should return zero semantic memories",
	);
});

test("trader tactical memories are excluded from generic assistant recall", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.92,
				payload: {
					text: "Trader tactical entry timing for BTC scalp",
					namespace: "agent.trader.decisions",
					domain: "trader_tactical",
					suppressionReason:
						"suppressed.trader_tactical_owned_by_trader_brain_plugin",
					matchedClasses: ["entry_timing_reasoning"],
					source_agent: "trader",
					sessionId: "taa-thread-1",
					project_tag: "taa",
					timestamp: now - 5 * 60 * 1000,
				},
			},
			{
				score: 0.8,
				payload: {
					text: "TAA project runbook checklist",
					namespace: "shared.runbooks",
					project_tag: "taa",
					sessionId: "taa-thread-1",
					timestamp: now - 5 * 60 * 1000,
				},
			},
		],
		ctx,
		{
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(),
		},
	);

	assert(selected.memories.length > 0, "expected at least one recalled memory");
	assert(
		selected.memories.every((m) => !m.namespace?.startsWith("agent.trader.")),
		"trader tactical memory must be excluded from generic assistant recall",
	);
	assert(
		selected.memories.some((m) => m.namespace === "shared.runbooks"),
		"shared runbooks should remain available when relevant",
	);
});

test("trader owner path allows trader tactical memories", () => {
	const now = Date.now();
	const selected = selectSemanticMemories(
		[
			{
				score: 0.86,
				payload: {
					text: "Trader tactical exit rationale after volatility expansion",
					namespace: "agent.trader.decisions",
					domain: "trader_tactical",
					suppressionReason:
						"suppressed.trader_tactical_owned_by_trader_brain_plugin",
					matchedClasses: ["hold_skip_rationale"],
					source_agent: "trader",
					sessionId: "trader-thread-42",
					project_tag: "taa",
					timestamp: now - 3 * 60 * 1000,
				},
			},
		],
		{
			sessionKey: "agent:trader:trader-thread-42",
			stateDir: "/tmp",
			userId: "u1",
			agentId: "trader",
		},
		{
			sessionKeys: new Set([
				"agent:trader:trader-thread-42",
				"trader-thread-42",
			]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(),
		},
	);

	assert(
		selected.memories.length > 0,
		"trader owner path should allow tactical recall",
	);
	assert(
		selected.memories.some((m) => m.namespace === "agent.trader.decisions"),
		"trader tactical memory should remain available in trader-owned path",
	);
});

if (!process.exitCode) {
	console.log("\n🎉 auto-recall ranking tests passed");
}
