import type {
	MemoryNamespace,
	MemorySourceType,
	MemoryType,
	PromotionState,
} from "../../shared/memory-config.js";
import {
	resolveDefaultConfidence,
	resolveMemoryTypeFromNamespace,
} from "../../shared/memory-config.js";

export type PromotionAction = "distill" | "promote" | "deprecate";

export interface PromotionMetadata {
	memoryType: MemoryType;
	promotionState: PromotionState;
	confidence: number;
}

export function transitionPromotionState(
	current: PromotionState,
	action: PromotionAction,
): PromotionState {
	if (action === "deprecate") return "deprecated";
	if (current === "deprecated") return "deprecated";
	if (action === "distill") {
		if (current === "raw") return "distilled";
		return current;
	}
	if (action === "promote") {
		if (current === "raw" || current === "distilled") return "promoted";
	}
	return current;
}

export function resolveInitialPromotionState(input: {
	namespace: MemoryNamespace;
	sourceType: MemorySourceType;
}): PromotionState {
	if (input.sourceType === "promotion") return "promoted";

	// Avoid uncontrolled capture growth: auto-captured runbooks/lessons start at distilled.
	if (
		input.sourceType === "auto_capture" &&
		(input.namespace === "shared.runbooks" ||
			input.namespace.endsWith(".lessons"))
	) {
		return "distilled";
	}

	return "raw";
}

export function resolvePromotionMetadata(input: {
	namespace: MemoryNamespace;
	sourceType: MemorySourceType;
	memoryType?: MemoryType;
	promotionState?: PromotionState;
	confidence?: number;
}): PromotionMetadata {
	const memoryType =
		input.memoryType || resolveMemoryTypeFromNamespace(input.namespace);
	const promotionState =
		input.promotionState ||
		resolveInitialPromotionState({
			namespace: input.namespace,
			sourceType: input.sourceType,
		});
	const baseline = resolveDefaultConfidence(input.sourceType);
	const confidence =
		typeof input.confidence === "number" && Number.isFinite(input.confidence)
			? input.confidence
			: baseline;

	return {
		memoryType,
		promotionState,
		confidence,
	};
}
