const fs = require('fs');
let code = fs.readFileSync('tests/test-semantic-memory-usecase.ts', 'utf8');

code = code.replace(
`		const deterministicTimestamp = "2026-04-07T00:00:00.000Z";
		const deterministicCaptureB = await usecase.capture(
			{
				text: "ASM deterministic tie-break item B",
				namespace: "assistant",
				timestamp: deterministicTimestamp,
				updatedAt: deterministicTimestamp,
			},
			context,
		);
		const deterministicCaptureA = await usecase.capture(
			{
				text: "ASM deterministic tie-break item A",
				namespace: "assistant",
				timestamp: deterministicTimestamp,
				updatedAt: deterministicTimestamp,
			},
			context,
		);`,
`		const { writeWikiMemoryCapture } = require("../src/core/usecases/semantic-memory-usecase.js");
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
				userId: "u1"
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
				userId: "u1"
		});`
);

fs.writeFileSync('tests/test-semantic-memory-usecase.ts', code);
console.log('patched');
