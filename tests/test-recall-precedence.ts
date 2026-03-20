import { buildRecallInjectionParts } from "../src/core/precedence/recall-precedence.js";

function assert(condition: unknown, message: string): void {
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

test("precedence order: slotdb truth > semantic evidence > graph routing support", () => {
	const parts = buildRecallInjectionParts({
		currentState: "<current-state><x>1</x></current-state>",
		projectLivingState: "<project-living-state><x>2</x></project-living-state>",
		recentUpdates: "<recent-updates><x>3</x></recent-updates>",
		semanticMemories:
			"<semantic-memories><memory>evidence</memory></semantic-memories>",
		graphContext: "<knowledge-graph><x>route</x></knowledge-graph>",
		recallMeta: {
			recall_confidence: "high",
			recall_suppressed: false,
		},
	});

	assert(parts.length >= 4, "expected all precedence parts to be present");
	assert(
		parts[0].startsWith('<slotdb-truth precedence="highest">'),
		"slotdb truth should be injected first",
	);
	assert(
		parts[1].startsWith('<semantic-evidence precedence="medium">'),
		"semantic evidence should be injected second",
	);
	assert(
		parts[2].startsWith('<graph-routing-support precedence="support">'),
		"graph routing support should be injected third",
	);
});

test("slotdb wrapper contains current + living + recent blocks", () => {
	const parts = buildRecallInjectionParts({
		currentState: "<current-state><task>truth</task></current-state>",
		projectLivingState:
			"<project-living-state><focus>f</focus></project-living-state>",
		recentUpdates: '<recent-updates><update key="k"/></recent-updates>',
		semanticMemories: "",
		graphContext: "",
	});

	const slotPart = parts[0] || "";
	assert(
		slotPart.includes("<current-state>"),
		"slot wrapper must include current-state",
	);
	assert(
		slotPart.includes("<project-living-state>"),
		"slot wrapper must include project-living-state",
	);
	assert(
		slotPart.includes("<recent-updates>"),
		"slot wrapper must include recent-updates",
	);
});

if (!process.exitCode) {
	console.log("\n🎉 recall precedence tests passed");
}
