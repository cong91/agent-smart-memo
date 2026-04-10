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

test("precedence order: slotdb truth > wiki working set > supporting recall > graph routing support", () => {
	const parts = buildRecallInjectionParts({
		asmRuntime:
			"<asm-runtime><run-mode>wiki-first</run-mode><contract>working-surface</contract></asm-runtime>",
		currentState: "<current-state><x>1</x></current-state>",
		projectLivingState: "<project-living-state><x>2</x></project-living-state>",
		recentUpdates: "<recent-updates><x>3</x></recent-updates>",
		wikiWorkingSet:
			"<wiki-working-set><wiki-root>/tmp/wiki</wiki-root><entrypoint>index.md</entrypoint></wiki-working-set>",
		semanticMemories:
			"<semantic-memories><memory>evidence</memory></semantic-memories>",
		graphContext: "<knowledge-graph><x>route</x></knowledge-graph>",
		recallMeta: {
			recall_confidence: "high",
			recall_suppressed: false,
		},
	});

	assert(
		parts.length >= 5,
		"expected runtime + precedence parts to be present",
	);
	assert(
		parts[0].startsWith("<asm-runtime>"),
		"asm runtime should be injected before precedence-wrapped blocks",
	);
	assert(
		parts[1].startsWith('<slotdb-truth precedence="highest">'),
		"slotdb truth should be injected first",
	);
	assert(
		parts[2].startsWith('<wiki-working-surface precedence="primary">'),
		"wiki working set should be injected second",
	);
	assert(
		parts[3].startsWith('<supporting-recall precedence="support">'),
		"supporting recall should be injected third",
	);
	assert(
		parts[4].startsWith('<graph-routing-support precedence="support">'),
		"graph routing support should be injected fourth",
	);
});

test("asm runtime contract exposes wiki-first working-surface guidance", () => {
	const parts = buildRecallInjectionParts({
		asmRuntime: `<asm-runtime>
  <run-mode>wiki-first</run-mode>
  <contract>working-surface</contract>
  <guidance>
    <instruction index="1">treat wiki pages as the primary working surface for this run</instruction>
    <instruction index="2">inspect wiki root, entrypoint, and canonical pages before leaning on supporting recall</instruction>
  </guidance>
</asm-runtime>`,
		currentState: "<current-state><task>truth</task></current-state>",
		projectLivingState: "",
		recentUpdates: "",
		wikiWorkingSet:
			'<wiki-working-set><wiki-root>/tmp/wiki</wiki-root><entrypoint>index.md</entrypoint><section name="canonical-pages"><page index="1" kind="entrypoint" layer="canonical" path="index.md"><title>Index</title><reason>entrypoint</reason></page></section></wiki-working-set>',
		semanticMemories:
			"<semantic-memories><memory>support only</memory></semantic-memories>",
		graphContext: "",
	});

	const runtime = parts[0] || "";
	assert(
		runtime.includes("<contract>working-surface</contract>"),
		"asm runtime should declare the working-surface contract",
	);
	assert(
		runtime.includes("primary working surface") &&
			runtime.includes("before leaning on supporting recall"),
		"asm runtime should guide wiki-first inspection before supporting recall",
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
