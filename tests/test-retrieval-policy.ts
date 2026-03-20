import {
	normalizeSessionToken,
	resolveSessionMode,
	scoreSemanticCandidate,
	shouldApplyStrictSessionFilter,
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

if (!process.exitCode) {
	console.log("\n🎉 retrieval policy tests passed");
}
