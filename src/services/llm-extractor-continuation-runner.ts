import {
	type DistillMode,
	type IsolatedContinuationRuntimeOptions,
	runContinuationNativeDistill,
} from "./llm-extractor.js";

interface ContinuationRunnerInput {
	conversation: string;
	currentSlots: Record<string, Record<string, any>>;
	distillMode: DistillMode;
	continuation: {
		agentId: string;
		sourceSessionKey: string;
		continuationSessionKey: string;
	};
	runtimeOptions?: IsolatedContinuationRuntimeOptions;
}

const CONTINUATION_RUNNER_OUTPUT_MARKER = "__ASM_CONTINUATION_RESULT__";

function emitResult(payload: {
	ok: boolean;
	result?: unknown;
	error?: string;
}): void {
	process.stdout.write(
		`${CONTINUATION_RUNNER_OUTPUT_MARKER}${JSON.stringify(payload)}`,
	);
}

async function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data);
		});
		process.stdin.on("error", (error) => {
			reject(error);
		});
	});
}

async function main(): Promise<void> {
	// Keep stdout clean for machine-readable envelope parsing in parent process.
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		console.error(...args);
	};

	try {
		const rawInput = (await readStdin()).trim();
		if (!rawInput) {
			emitResult({
				ok: false,
				error: "continuation runner received empty input payload",
			});
			return;
		}

		const parsed = JSON.parse(rawInput) as ContinuationRunnerInput;
		if (!parsed?.conversation || !parsed?.continuation) {
			emitResult({
				ok: false,
				error:
					"continuation runner missing required fields (conversation, continuation)",
			});
			return;
		}

		const result = await runContinuationNativeDistill({
			conversation: parsed.conversation,
			currentSlots: parsed.currentSlots || {},
			distillMode: parsed.distillMode || "general",
			continuation: parsed.continuation,
			runtimeOptions: parsed.runtimeOptions,
		});

		emitResult({ ok: true, result });
	} catch (error: any) {
		emitResult({
			ok: false,
			error: String(error?.message || error),
		});
	} finally {
		console.log = originalLog;
	}
}

void main();
