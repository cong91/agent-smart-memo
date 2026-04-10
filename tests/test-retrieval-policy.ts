import {
	applyDomainGraphRerank,
	isTraderOwnerPath,
	isTraderTacticalCandidate,
	normalizeSessionToken,
	resolveRecallDomainRoute,
	resolveSessionMode,
	resolveTraderRecallGate,
	scoreSemanticCandidate,
	shouldApplyStrictSessionFilter,
	TRADER_TACTICAL_SUPPRESSION_PENALTY,
} from "../src/core/retrieval-policy.js";

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

test("normalizeSessionToken lowercases and trims", () => {
	assertEqual(
		normalizeSessionToken("  AbC-123  "),
		"abc-123",
		"session token normalization mismatch",
	);
});

test("resolveSessionMode defaults to soft", () => {
	assertEqual(
		resolveSessionMode(undefined),
		"soft",
		"default session mode should be soft",
	);
	assertEqual(
		resolveSessionMode("strict"),
		"strict",
		"strict mode should be preserved",
	);
});

test("recall domain router is deterministic by owner path", () => {
	assertEqual(
		resolveRecallDomainRoute({
			currentAgentId: "assistant",
			sessionKey: "agent:assistant:thread-1",
		}),
		"generic_shared",
		"generic assistant path should map to generic_shared route",
	);
	assertEqual(
		resolveRecallDomainRoute({
			currentAgentId: "assistant",
			sessionKey: "agent:trader:thread-1",
		}),
		"trader_owner",
		"trader session owner path should map to trader_owner route",
	);
});

test("strict filter gate follows strict mode with non-empty session", () => {
	assert(
		shouldApplyStrictSessionFilter("strict", "s1"),
		"strict mode with session must apply filter",
	);
	assert(
		!shouldApplyStrictSessionFilter("soft", "s1"),
		"soft mode must not apply strict filter",
	);
	assert(
		!shouldApplyStrictSessionFilter("strict", ""),
		"empty session should not apply strict filter",
	);
});

test("soft mode same-session gets boost", () => {
	const scored = scoreSemanticCandidate({
		rawScore: 0.8,
		agentId: "assistant",
		namespace: "agent.assistant.working_memory",
		sessionMode: "soft",
		preferredSessionId: "session-1",
		payloadSessionId: "session-1",
	});
	assert(
		scored.sessionBoost > 0,
		"same-session in soft mode must receive boost",
	);
	assert(
		scored.finalScore > scored.weightedBase,
		"final score should include session boost",
	);
});

test("strict mode does not add session boost", () => {
	const scored = scoreSemanticCandidate({
		rawScore: 0.8,
		agentId: "assistant",
		namespace: "agent.assistant.working_memory",
		sessionMode: "strict",
		preferredSessionId: "session-1",
		payloadSessionId: "session-1",
	});
	assertEqual(scored.sessionBoost, 0, "strict mode should not use soft boost");
});

test("promoted memories should rank above raw when base score is equal", () => {
	const baseInput = {
		rawScore: 0.8,
		agentId: "assistant",
		namespace: "agent.assistant.working_memory",
		sessionMode: "soft" as const,
		preferredSessionId: "session-1",
		payloadSessionId: "other-session",
	};

	const raw = scoreSemanticCandidate({
		...baseInput,
		promotionState: "raw",
	});
	const distilled = scoreSemanticCandidate({
		...baseInput,
		promotionState: "distilled",
	});
	const promoted = scoreSemanticCandidate({
		...baseInput,
		promotionState: "promoted",
	});

	assert(distilled.finalScore > raw.finalScore, "distilled should outrank raw");
	assert(
		promoted.finalScore > distilled.finalScore,
		"promoted should outrank distilled",
	);
});

test("trader owner path detection uses agent and session tokens", () => {
	assert(
		isTraderOwnerPath("trader", "agent:assistant:foo"),
		"trader agent should be recognized as owner path",
	);
	assert(
		isTraderOwnerPath("assistant", "agent:trader:thread-1"),
		"trader session path should be recognized as owner path",
	);
	assert(
		!isTraderOwnerPath("assistant", "agent:assistant:thread-1"),
		"generic assistant path must not be treated as trader owner path",
	);
});

test("trader tactical candidate detection is deterministic", () => {
	assert(
		isTraderTacticalCandidate({
			namespace: "agent.trader.decisions",
		}) === true,
		"trader namespace should be classified as tactical candidate",
	);
	assert(
		isTraderTacticalCandidate({
			payloadDomain: "trader_tactical",
		}) === true,
		"trader_tactical domain should be classified as tactical candidate",
	);
	assert(
		isTraderTacticalCandidate({
			namespace: "shared.project_context",
			payloadDomain: "generic",
		}) === false,
		"shared generic memory must not be classified as trader tactical",
	);
});

test("generic path suppresses trader tactical gate", () => {
	const gate = resolveTraderRecallGate({
		currentAgentId: "assistant",
		sessionKey: "agent:assistant:taa-thread-1",
		namespace: "agent.trader.decisions",
		payloadDomain: "trader_tactical",
	});

	assertEqual(
		gate.allowInRecall,
		false,
		"generic path should suppress tactical recall",
	);
	assertEqual(
		gate.suppressionPenalty,
		TRADER_TACTICAL_SUPPRESSION_PENALTY,
		"gate should apply configured suppression penalty",
	);
	assertEqual(
		gate.reason,
		"generic_owner_path_suppressed",
		"suppression reason mismatch",
	);
});

test("trader path allows tactical gate without suppression", () => {
	const gate = resolveTraderRecallGate({
		currentAgentId: "trader",
		sessionKey: "agent:trader:thread-1",
		namespace: "agent.trader.decisions",
		payloadDomain: "trader_tactical",
	});

	assertEqual(
		gate.allowInRecall,
		true,
		"trader path should allow tactical recall",
	);
	assertEqual(
		gate.suppressionPenalty,
		0,
		"trader path should not be penalized",
	);
	assertEqual(gate.reason, "trader_owner_path", "owner-path reason mismatch");
});

test("scoreSemanticCandidate applies suppression penalty deterministically", () => {
	const base = scoreSemanticCandidate({
		rawScore: 0.85,
		agentId: "assistant",
		namespace: "shared.project_context",
		sessionMode: "soft",
		preferredSessionId: "s1",
		payloadSessionId: "s1",
		suppressionPenalty: 0,
	});

	const suppressed = scoreSemanticCandidate({
		rawScore: 0.85,
		agentId: "assistant",
		namespace: "shared.project_context",
		sessionMode: "soft",
		preferredSessionId: "s1",
		payloadSessionId: "s1",
		suppressionPenalty: 0.4,
	});

	assert(
		suppressed.finalScore < base.finalScore,
		"suppression penalty must reduce final score",
	);
});

test("domain+graph rerank boosts shared memories and penalizes cross-project", () => {
	const boosted = applyDomainGraphRerank({
		route: "generic_shared",
		namespace: "shared.project_context",
		graphSignalHits: 2,
		sameProject: true,
		crossProject: false,
	});
	assert(
		boosted.totalDelta > 0,
		"shared same-project with graph hits should receive positive rerank delta",
	);

	const penalized = applyDomainGraphRerank({
		route: "generic_shared",
		namespace: "shared.project_context",
		graphSignalHits: 0,
		sameProject: false,
		crossProject: true,
	});
	assert(penalized.totalDelta < 0, "cross-project memory should be penalized");
});

test("graph rerank stays supporting-only beneath wiki working set", () => {
	const graphOnly = applyDomainGraphRerank({
		route: "generic_shared",
		namespace: "shared.project_context",
		graphSignalHits: 6,
		sameProject: false,
		crossProject: false,
	});
	assert(
		graphOnly.totalDelta > 0,
		"graph hints should contribute positive support",
	);
	assert(
		graphOnly.totalDelta <= 0.24,
		"graph rerank should stay capped so it remains supporting-only",
	);
});

test("domain+graph rerank suppresses trader tactical only on generic route", () => {
	const generic = applyDomainGraphRerank({
		route: "generic_shared",
		namespace: "agent.trader.decisions",
		payloadDomain: "trader_tactical",
		graphSignalHits: 3,
	});
	assert(
		generic.totalDelta < 0,
		"generic route should down-rank trader tactical candidates",
	);

	const traderOwner = applyDomainGraphRerank({
		route: "trader_owner",
		namespace: "agent.trader.decisions",
		payloadDomain: "trader_tactical",
		graphSignalHits: 3,
	});
	assert(
		traderOwner.totalDelta > generic.totalDelta,
		"trader owner route must not apply generic tactical down-rank",
	);
});

if (!process.exitCode) {
	console.log("\n🎉 retrieval policy tests passed");
}
