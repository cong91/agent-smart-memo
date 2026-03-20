import {
	resolveInitialPromotionState,
	resolvePromotionMetadata,
	transitionPromotionState,
} from "../src/core/promotion/promotion-lifecycle.js";

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

test("raw -> distilled -> promoted transition", () => {
	const distilled = transitionPromotionState("raw", "distill");
	const promoted = transitionPromotionState(distilled, "promote");
	assertEqual(distilled, "distilled", "raw should transition to distilled");
	assertEqual(promoted, "promoted", "distilled should transition to promoted");
});

test("deprecated state is terminal", () => {
	const next = transitionPromotionState("deprecated", "promote");
	assertEqual(next, "deprecated", "deprecated must remain deprecated");
});

test("auto-capture lessons/runbooks start at distilled to avoid raw spam", () => {
	assertEqual(
		resolveInitialPromotionState({
			namespace: "agent.assistant.lessons",
			sourceType: "auto_capture",
		}),
		"distilled",
		"lessons from auto-capture should default distilled",
	);

	assertEqual(
		resolveInitialPromotionState({
			namespace: "shared.runbooks",
			sourceType: "auto_capture",
		}),
		"distilled",
		"runbooks from auto-capture should default distilled",
	);
});

test("promotion metadata derives memory_type and defaults", () => {
	const meta = resolvePromotionMetadata({
		namespace: "agent.assistant.lessons",
		sourceType: "auto_capture",
	});
	assertEqual(
		meta.memoryType,
		"lesson",
		"lessons namespace should infer memory_type=lesson",
	);
	assertEqual(
		meta.promotionState,
		"distilled",
		"auto-capture lessons should be distilled",
	);
	assert(typeof meta.confidence === "number", "confidence must be computed");
});

if (!process.exitCode) {
	console.log("\n🎉 promotion lifecycle tests passed");
}
