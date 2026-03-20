export interface RecallInjectionContext {
	currentState: string;
	projectLivingState: string;
	graphContext: string;
	recentUpdates: string;
	semanticMemories: string;
	recallMeta?: {
		recall_confidence: "high" | "medium" | "low";
		recall_suppressed: boolean;
		suppression_reason?: string;
	};
}

export interface RecallPrecedencePolicy {
	slotdbTruth: "highest";
	semanticEvidence: "medium";
	graphRoutingSupport: "support";
}

export const DEFAULT_RECALL_PRECEDENCE_POLICY: RecallPrecedencePolicy = {
	slotdbTruth: "highest",
	semanticEvidence: "medium",
	graphRoutingSupport: "support",
};

function formatRecallMeta(
	recallMeta: RecallInjectionContext["recallMeta"],
): string {
	if (!recallMeta) return "";
	return `<recall-meta>\n  <recall_confidence>${recallMeta.recall_confidence}</recall_confidence>\n  <recall_suppressed>${String(recallMeta.recall_suppressed)}</recall_suppressed>${recallMeta.suppression_reason ? `\n  <suppression_reason>${recallMeta.suppression_reason}</suppression_reason>` : ""}\n</recall-meta>`;
}

export function buildRecallInjectionParts(
	context: RecallInjectionContext,
): string[] {
	const parts: string[] = [];

	// Precedence 1: SlotDB current truth.
	const slotTruthBlocks = [
		context.currentState,
		context.projectLivingState,
		context.recentUpdates,
	].filter(Boolean);

	if (slotTruthBlocks.length > 0) {
		parts.push(
			`<slotdb-truth precedence="highest">\n${slotTruthBlocks.join("\n\n")}\n</slotdb-truth>`,
		);
	}

	// Precedence 2: semantic memories are evidence/history/lessons.
	if (context.semanticMemories) {
		parts.push(
			`<semantic-evidence precedence="medium">\n${context.semanticMemories}\n</semantic-evidence>`,
		);
	}

	// Precedence 3: graph context is routing/ranking support only.
	if (context.graphContext) {
		parts.push(
			`<graph-routing-support precedence="support">\n${context.graphContext}\n</graph-routing-support>`,
		);
	}

	const recallMetaBlock = formatRecallMeta(context.recallMeta);
	if (recallMetaBlock) {
		parts.push(recallMetaBlock);
	}

	return parts;
}
