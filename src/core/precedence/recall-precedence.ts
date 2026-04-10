export interface RecallInjectionContext {
	asmRuntime?: string;
	currentState: string;
	projectLivingState: string;
	wikiWorkingSet?: string;
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
	wikiWorkingSet: "primary";
	semanticEvidence: "support";
	graphRoutingSupport: "support";
	canonicalPersistence: "qmd-backend" | "md-files";
}

export const DEFAULT_RECALL_PRECEDENCE_POLICY: RecallPrecedencePolicy = {
	slotdbTruth: "highest",
	wikiWorkingSet: "primary",
	semanticEvidence: "support",
	graphRoutingSupport: "support",
	canonicalPersistence: "qmd-backend",
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

	if (context.asmRuntime) {
		parts.push(context.asmRuntime);
	}

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

	// Precedence 2: wiki working set is the primary read surface.
	if (context.wikiWorkingSet) {
		parts.push(
			`<wiki-working-surface precedence="primary">\n${context.wikiWorkingSet}\n</wiki-working-surface>`,
		);
	}

	// Precedence 3: semantic memories are supporting evidence only.
	if (context.semanticMemories) {
		parts.push(
			`<supporting-recall precedence="support">\n${context.semanticMemories}\n</supporting-recall>`,
		);
	}

	// Precedence 4: graph context is routing/ranking support only.
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
