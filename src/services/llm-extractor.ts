import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isLearningContent,
	type MemoryNamespace,
	toCoreAgent,
} from "../shared/memory-config.js";

export type DistillMode =
	| "principles"
	| "requirements"
	| "market_signal"
	| "general";

export interface ExtractionResult {
	slot_updates: Array<{
		key: string;
		value: any;
		confidence: number;
		category: string;
	}>;
	slot_removals: Array<{
		key: string;
		reason: string;
	}>;
	memories: Array<{
		text: string;
		namespace: MemoryNamespace;
		confidence: number;
	}>;
	draft_updates: Array<{
		text: string;
		namespace: MemoryNamespace;
		confidence: number;
		title?: string;
	}>;
	briefing_updates: Array<{
		text: string;
		namespace: MemoryNamespace;
		confidence: number;
		title?: string;
	}>;
	log_entries: Array<{
		text: string;
		level: "info" | "warn" | "error";
	}>;
	promotion_hints: Array<{
		text: string;
		namespace: MemoryNamespace;
		confidence: number;
		promotion_state?: string;
		memory_type?: string;
	}>;
}

export interface IsolatedContinuationInput {
	agentId: string;
	sourceSessionKey: string;
	continuationSessionKey?: string;
	timeoutMs?: number;
}

export interface DistillContextMessage {
	role: "user" | "assistant" | "system" | string;
	text: string;
}

export interface IsolatedContinuationRuntimeOptions {
	enableLlmExtraction?: boolean;
	bootstrapSafeRawFirst?: boolean;
	contextMessages?: DistillContextMessage[];
	structuredContract?: Partial<ExtractionResult>;
}

interface IsolatedContinuationContext {
	agentId: string;
	sourceSessionKey: string;
	continuationSessionKey: string;
}

interface ContinuationSessionExecutionInput {
	conversation: string;
	currentSlots: Record<string, Record<string, any>>;
	distillMode: DistillMode;
	continuation: IsolatedContinuationContext;
	runtimeOptions?: IsolatedContinuationRuntimeOptions;
}

export interface ContinuationSessionExecutionEnvelope {
	ok: boolean;
	result?: ExtractionResult;
	error?: string;
}

export const CONTINUATION_RUNNER_OUTPUT_MARKER = "__ASM_CONTINUATION_RESULT__";

function createEmptyResult(): ExtractionResult {
	return {
		slot_updates: [],
		slot_removals: [],
		memories: [],
		draft_updates: [],
		briefing_updates: [],
		log_entries: [],
		promotion_hints: [],
	};
}

type ActionableContextSignal =
	| "planning_approved"
	| "implementation_packet"
	| "handoff_or_next_step"
	| "decision_or_constraints"
	| "project_context_update";

function truncateForLog(value: string, limit = 180): string {
	const compact = String(value || "")
		.replace(/\s+/g, " ")
		.trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, limit)}…`;
}

function detectActionableContextSignals(
	conversation: string,
): ActionableContextSignal[] {
	const text = String(conversation || "");
	const lower = text.toLowerCase();
	const signals = new Set<ActionableContextSignal>();

	const has = (pattern: RegExp): boolean => pattern.test(text);

	if (
		has(
			/\b(approved|approve|go ahead|proceed|ship it|đã duyệt|duyệt kế hoạch|đồng ý triển khai|chốt kế hoạch)\b/i,
		) &&
		has(
			/\b(plan|planning|execution plan|implementation|kế hoạch|triển khai|packet)\b/i,
		)
	) {
		signals.add("planning_approved");
	}

	if (
		has(
			/\b(implementation packet|execution plan|task-context|task context|todo list|checklist|wave|milestone|kế hoạch triển khai|gói triển khai|implementation details)\b/i,
		)
	) {
		signals.add("implementation_packet");
	}

	if (
		has(
			/\b(handoff|handover|next step|next steps|next-action|status update|blocked by|owner|bàn giao|bước tiếp theo|trạng thái|chuyển sang)\b/i,
		) &&
		has(/\b(task|bead|issue|ticket|project|phase|epic|công việc)\b/i)
	) {
		signals.add("handoff_or_next_step");
	}

	if (
		has(
			/\b(decision|decide|approved approach|constraint|non-negotiable|must|must not|do not|trade-off|quyết định|ràng buộc|không được|bắt buộc)\b/i,
		)
	) {
		signals.add("decision_or_constraints");
	}

	const hasProjectToken =
		/\b(project|bead|issue|ticket|phase|milestone|roadmap|epic|project context|task context)\b/i.test(
			text,
		);
	const hasUpdateToken =
		/\b(update|updated|changed|current|now|status|moved|next|cập nhật|đã chuyển|hiện tại|trạng thái)\b/i.test(
			text,
		);
	if (hasProjectToken && hasUpdateToken) {
		signals.add("project_context_update");
	}

	if (
		signals.size === 0 &&
		(lower.includes("approved") || lower.includes("duyệt")) &&
		(lower.includes("bead") ||
			lower.includes("task") ||
			lower.includes("phase"))
	) {
		signals.add("project_context_update");
	}

	return Array.from(signals);
}

function formatContextSignals(signals: ActionableContextSignal[]): string {
	return signals.length > 0 ? signals.join(",") : "none";
}

function countStructuredSignals(payload: {
	slot_updates?: any[];
	slot_removals?: any[];
	memories?: any[];
	draft_updates?: any[];
	briefing_updates?: any[];
	promotion_hints?: any[];
}): number {
	return (
		(payload.slot_updates?.length || 0) +
		(payload.slot_removals?.length || 0) +
		(payload.memories?.length || 0) +
		(payload.draft_updates?.length || 0) +
		(payload.briefing_updates?.length || 0) +
		(payload.promotion_hints?.length || 0)
	);
}

function buildContinuationContext(
	continuation?: IsolatedContinuationInput,
): IsolatedContinuationContext {
	return {
		agentId: continuation?.agentId || "assistant",
		sourceSessionKey:
			continuation?.sourceSessionKey || "agent:assistant:default",
		continuationSessionKey:
			continuation?.continuationSessionKey ||
			`agent:${continuation?.agentId || "assistant"}:distill:${Date.now()}`,
	};
}

function inferDistillModeFromContext(
	agentId: string,
	conversation: string,
): DistillMode {
	const coreAgent = toCoreAgent(agentId);
	if (coreAgent === "trader") return "market_signal";
	if (isLearningContent(conversation)) return "principles";
	if (["scrum", "fullstack", "creator"].includes(coreAgent)) {
		return "requirements";
	}
	return "general";
}

function appendContinuationLog(
	result: ExtractionResult,
	continuation: IsolatedContinuationContext,
	distillMode: DistillMode,
): ExtractionResult {
	return {
		...result,
		log_entries: [
			...(result.log_entries || []),
			{
				level: "info",
				text: `isolated continuation distill session=${continuation.continuationSessionKey} source=${continuation.sourceSessionKey} agent=${continuation.agentId} mode=${distillMode} engine=native_continuation`,
			},
		],
	};
}

function isolatedFailureResult(
	message: string,
	continuation: IsolatedContinuationContext,
	distillMode: DistillMode,
): ExtractionResult {
	return appendContinuationLog(
		{
			...createEmptyResult(),
			log_entries: [
				{
					level: "error",
					text: `isolated continuation native distill failed: ${message}`,
				},
				{
					level: "warn",
					text: "isolated continuation fallback disabled: no local heuristic slot_updates/memories applied",
				},
			],
		},
		continuation,
		distillMode,
	);
}

function normalizeExtractionResult(
	value: Partial<ExtractionResult> | null | undefined,
): ExtractionResult {
	return {
		slot_updates: Array.isArray(value?.slot_updates) ? value.slot_updates : [],
		slot_removals: Array.isArray(value?.slot_removals)
			? value.slot_removals
			: [],
		memories: Array.isArray(value?.memories) ? value.memories : [],
		draft_updates: Array.isArray(value?.draft_updates)
			? value.draft_updates
			: [],
		briefing_updates: Array.isArray(value?.briefing_updates)
			? value.briefing_updates
			: [],
		log_entries: Array.isArray(value?.log_entries) ? value.log_entries : [],
		promotion_hints: Array.isArray(value?.promotion_hints)
			? value.promotion_hints
			: [],
	};
}

export function resolveContinuationRunnerCommand(): {
	command: string;
	args: string[];
} {
	const currentFilePath = fileURLToPath(import.meta.url);
	const currentDir = dirname(currentFilePath);
	const isTsSourceRuntime = currentFilePath.endsWith(".ts");

	if (isTsSourceRuntime) {
		return {
			command: "npx",
			args: [
				"tsx",
				resolve(currentDir, "llm-extractor-continuation-runner.ts"),
			],
		};
	}

	return {
		command: process.execPath,
		args: [resolve(currentDir, "llm-extractor-continuation-runner.js")],
	};
}

export function parseContinuationEnvelope(
	rawStdout: string,
): ContinuationSessionExecutionEnvelope {
	const markerIndex = rawStdout.lastIndexOf(CONTINUATION_RUNNER_OUTPUT_MARKER);
	if (markerIndex < 0) {
		throw new Error("missing continuation runner envelope marker");
	}

	const payloadText = rawStdout
		.slice(markerIndex + CONTINUATION_RUNNER_OUTPUT_MARKER.length)
		.trim();
	if (!payloadText) {
		throw new Error("empty continuation runner envelope payload");
	}

	return JSON.parse(payloadText) as ContinuationSessionExecutionEnvelope;
}

export async function runContinuationNativeDistill(
	input: ContinuationSessionExecutionInput,
): Promise<ExtractionResult> {
	const continuationCtx = input.continuation;
	const resolvedDistillMode = input.distillMode;

	if (input.runtimeOptions?.enableLlmExtraction === false) {
		return isolatedFailureResult(
			"distill llm extraction disabled by runtime config",
			continuationCtx,
			resolvedDistillMode,
		);
	}

	const runtimeContract = input.runtimeOptions?.structuredContract;
	if (!runtimeContract) {
		return isolatedFailureResult(
			"missing continuation structured contract",
			continuationCtx,
			resolvedDistillMode,
		);
	}

	try {
		const normalized = appendContinuationLog(
			normalizeExtractionResult(runtimeContract),
			continuationCtx,
			resolvedDistillMode,
		);
		const contextSignals = detectActionableContextSignals(input.conversation);
		if (countStructuredSignals(normalized) > 0) {
			return normalized;
		}

		if (contextSignals.length > 0) {
			return isolatedFailureResult(
				`empty continuation structured contract for actionable context (signals=${formatContextSignals(contextSignals)}; source=continuation_structured_contract)`,
				continuationCtx,
				resolvedDistillMode,
			);
		}

		return {
			...normalized,
			log_entries: [
				...(normalized.log_entries || []),
				{
					level: "info",
					text: "isolated continuation empty_result accepted reason=no_actionable_context",
				},
			],
		};
	} catch (error: any) {
		return isolatedFailureResult(
			`native continuation extraction exception: ${String(error?.message || error)}`,
			continuationCtx,
			resolvedDistillMode,
		);
	}
}

export async function extractWithIsolatedContinuation(
	conversation: string,
	currentSlots: Record<string, Record<string, any>>,
	distillMode?: DistillMode,
	continuation?: IsolatedContinuationInput,
	runtimeOptions?: IsolatedContinuationRuntimeOptions,
): Promise<ExtractionResult> {
	const continuationCtx = buildContinuationContext(continuation);
	const resolvedDistillMode =
		distillMode ||
		inferDistillModeFromContext(continuationCtx.agentId, conversation);

	return runContinuationNativeDistill({
		conversation,
		currentSlots,
		distillMode: resolvedDistillMode,
		continuation: continuationCtx,
		runtimeOptions,
	});
}
