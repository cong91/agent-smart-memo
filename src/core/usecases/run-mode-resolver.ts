export type AsmRunMode = "light" | "wiki-first" | "write-back";

export interface RunModeMessageLike {
	role?: string;
	content?: unknown;
}

export interface RunModeStateSummary {
	activeTaskHints?: string[];
	projectLivingState?: unknown;
	currentState?: Record<string, Record<string, unknown>>;
}

export interface ResolveRunModeInput {
	sessionKey: string;
	userQuery?: string;
	messages?: RunModeMessageLike[];
	stateSummary?: RunModeStateSummary;
	continuation?: {
		isWriteBackLane?: boolean;
	};
}

export interface ResolveRunModeResult {
	runMode: AsmRunMode;
	reasons: string[];
}

function normalizeText(value: unknown): string {
	if (typeof value === "string") {
		return value.toLowerCase();
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => normalizeText(item))
			.filter(Boolean)
			.join(" ");
	}
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>)
			.map((item) => normalizeText(item))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

function collectMessageText(
	messages: RunModeMessageLike[] | undefined,
): string {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	return messages
		.map((message) => normalizeText(message?.content))
		.filter(Boolean)
		.join(" ");
}

function hasProjectState(
	stateSummary: RunModeStateSummary | undefined,
): boolean {
	if (!stateSummary) return false;
	if ((stateSummary.activeTaskHints || []).length > 0) return true;

	const living =
		stateSummary.projectLivingState &&
		typeof stateSummary.projectLivingState === "object"
			? (stateSummary.projectLivingState as Record<string, unknown>)
			: null;
	if (living) {
		for (const key of [
			"active_context",
			"current_focus",
			"current_task",
			"current_project",
			"next_steps",
		]) {
			const value = living[key];
			if (typeof value === "string" && value.trim()) return true;
			if (Array.isArray(value) && value.length > 0) return true;
		}
	}

	const projectState = stateSummary.currentState?.project || {};
	for (const key of [
		"project.current",
		"project.current_task",
		"project.current_epic",
		"project.phase",
		"project.status",
	]) {
		const value = projectState[key];
		if (typeof value === "string" && value.trim()) return true;
	}

	return false;
}

const WIKI_FIRST_KEYWORDS = [
	/\bimplement(?:ation)?\b/,
	/\bdebug(?:ging)?\b/,
	/\bbug\b/,
	/\bfix\b/,
	/\bplan(?:ning)?\b/,
	/\binvestigat(?:e|ion)\b/,
	/\brefactor\b/,
	/\bproject\b/,
	/\brepo\b/,
	/\bcode(?:base)?\b/,
	/\bslotdb\b/,
	/\bwiki\b/,
	/\bgraph\b/,
	/\bstate pack\b/,
	/\btask\b/,
	/\btest(?:ing)?\b/,
	/\bbuild\b/,
	/\bspec\b/,
	/\bbead\b/,
	/\bintegration\b/,
	/\bregression\b/,
];

export function resolveAsmRunMode(
	input: ResolveRunModeInput,
): ResolveRunModeResult {
	const reasons: string[] = [];
	const sessionKey = String(input.sessionKey || "").toLowerCase();
	const queryText = normalizeText(input.userQuery);
	const messageText = collectMessageText(input.messages);
	const combinedText = `${queryText} ${messageText}`.trim();

	if (
		input.continuation?.isWriteBackLane ||
		sessionKey.includes(":distill:") ||
		sessionKey.includes(":write-back:") ||
		sessionKey.includes(":write_back:")
	) {
		reasons.push("continuation_write_back_lane");
		return { runMode: "write-back", reasons };
	}

	if (hasProjectState(input.stateSummary)) {
		reasons.push("slotdb_project_state_present");
	}

	if (combinedText) {
		for (const matcher of WIKI_FIRST_KEYWORDS) {
			if (matcher.test(combinedText)) {
				reasons.push(`query_matches_${matcher.source}`);
				break;
			}
		}
	}

	if (reasons.length > 0) {
		return { runMode: "wiki-first", reasons };
	}

	return {
		runMode: "light",
		reasons: ["no_project_or_writeback_signal"],
	};
}
