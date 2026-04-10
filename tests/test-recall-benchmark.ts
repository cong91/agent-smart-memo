import { selectSemanticMemories } from "../src/hooks/auto-recall.js";
import { recallBenchmarkFixtures } from "./fixtures/recall-benchmark-fixtures.js";

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

for (const fixture of recallBenchmarkFixtures) {
	test(`recall benchmark: ${fixture.id}`, () => {
		const selection = selectSemanticMemories(
			fixture.results,
			fixture.ctx,
			fixture.hints,
		);

		assert(
			selection.suppressed === fixture.expectations.recallSuppressed,
			`[${fixture.id}] suppressed mismatch: expected ${fixture.expectations.recallSuppressed}, got ${selection.suppressed}`,
		);

		if (fixture.expectations.recallConfidence) {
			assert(
				selection.recallConfidence === fixture.expectations.recallConfidence,
				`[${fixture.id}] recallConfidence mismatch: expected ${fixture.expectations.recallConfidence}, got ${selection.recallConfidence}`,
			);
		}

		if (typeof fixture.expectations.minMemories === "number") {
			assert(
				selection.memories.length >= fixture.expectations.minMemories,
				`[${fixture.id}] expected at least ${fixture.expectations.minMemories} memories, got ${selection.memories.length}`,
			);
		}

		if (typeof fixture.expectations.maxMemories === "number") {
			assert(
				selection.memories.length <= fixture.expectations.maxMemories,
				`[${fixture.id}] expected at most ${fixture.expectations.maxMemories} memories, got ${selection.memories.length}`,
			);
		}

		for (const fragment of fixture.expectations.mustIncludeTextFragments || []) {
			assert(
				selection.memories.some((memory) => memory.text.includes(fragment)),
				`[${fixture.id}] missing expected memory fragment: ${fragment}`,
			);
		}

		for (const prefix of fixture.expectations.mustExcludeNamespacePrefixes || []) {
			assert(
				selection.memories.every(
					(memory) => !(memory.namespace || "").startsWith(prefix),
				),
				`[${fixture.id}] found excluded namespace prefix: ${prefix}`,
			);
		}
	});
}

if (!process.exitCode) {
	console.log("\n🎉 recall benchmark fixture tests passed");
}
