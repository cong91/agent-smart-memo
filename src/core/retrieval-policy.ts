import { getNamespaceWeight } from "../shared/memory-config.js";

export type SessionMode = "strict" | "soft";

export interface ScoreSemanticCandidateInput {
	rawScore: number;
	agentId: string;
	namespace: string;
	sessionMode?: SessionMode;
	preferredSessionId?: string;
	payloadSessionId?: string;
	sameSession?: boolean;
	promotionState?: string;
	suppressionPenalty?: number;
}

export interface ScoreSemanticCandidateOutput {
	weightedBase: number;
	sessionBoost: number;
	promotionBoost: number;
	finalScore: number;
	sameSession: boolean;
}

export type RecallDomainRoute = "generic_shared" | "trader_owner";

export interface RecallRouteInput {
	currentAgentId: string;
	sessionKey?: string;
}

export interface DomainGraphRerankInput {
	route: RecallDomainRoute;
	namespace?: string;
	payloadDomain?: string;
	graphSignalHits?: number;
	sameProject?: boolean;
	crossProject?: boolean;
}

export interface DomainGraphRerankOutput {
	domainBoost: number;
	graphBoost: number;
	crossProjectPenalty: number;
	totalDelta: number;
}

export const SOFT_SESSION_BOOST = 0.12;
export const PROMOTED_BOOST = 0.08;
export const DISTILLED_BOOST = 0.03;
export const TRADER_TACTICAL_SUPPRESSION_PENALTY = 0.5;

export interface TraderRecallGateInput {
	currentAgentId: string;
	sessionKey?: string;
	namespace?: string;
	payloadDomain?: string;
	suppressionReason?: string;
	matchedClasses?: unknown;
	sourceAgent?: string;
}

export interface TraderRecallGateResult {
	isTraderTacticalCandidate: boolean;
	ownerPathExplicit: boolean;
	allowInRecall: boolean;
	suppressionPenalty: number;
	reason?:
		| "trader_owner_path"
		| "generic_owner_path_suppressed"
		| "non_trader_candidate";
}

export function normalizeSessionToken(value: unknown): string {
	return String(value || "")
		.trim()
		.toLowerCase();
}

export function resolveSessionMode(value: unknown): SessionMode {
	return value === "strict" ? "strict" : "soft";
}

function normalizeAgentToken(value: unknown): string {
	const normalized = normalizeSessionToken(value);
	if (!normalized) return "";
	if (normalized.startsWith("agent.")) {
		return normalized.slice("agent.".length).split(".")[0] || "";
	}
	if (normalized.includes(":")) {
		const parts = normalized.split(":");
		if (parts.length >= 2) return parts[1] || "";
	}
	return normalized;
}

export function isTraderOwnerPath(
	currentAgentId: unknown,
	sessionKey?: unknown,
): boolean {
	const agentToken = normalizeAgentToken(currentAgentId);
	if (agentToken === "trader") return true;

	const session = normalizeSessionToken(sessionKey);
	if (!session) return false;
	const parts = session.split(":");
	return parts.length >= 2 && parts[1] === "trader";
}

export function isTraderTacticalCandidate(input: {
	namespace?: unknown;
	payloadDomain?: unknown;
	suppressionReason?: unknown;
	matchedClasses?: unknown;
	sourceAgent?: unknown;
}): boolean {
	const namespace = normalizeSessionToken(input.namespace);
	if (namespace.startsWith("agent.trader.")) return true;

	const payloadDomain = normalizeSessionToken(input.payloadDomain);
	if (payloadDomain === "trader_tactical") return true;

	const suppressionReason = normalizeSessionToken(input.suppressionReason);
	if (suppressionReason.includes("trader_tactical")) return true;

	const sourceAgent = normalizeAgentToken(input.sourceAgent);
	if (
		sourceAgent === "trader" &&
		Array.isArray(input.matchedClasses) &&
		input.matchedClasses.length > 0
	) {
		return true;
	}

	return false;
}

export function resolveRecallDomainRoute(
	input: RecallRouteInput,
): RecallDomainRoute {
	return isTraderOwnerPath(input.currentAgentId, input.sessionKey)
		? "trader_owner"
		: "generic_shared";
}

export function resolveTraderRecallGate(
	input: TraderRecallGateInput,
): TraderRecallGateResult {
	const ownerPathExplicit =
		resolveRecallDomainRoute({
			currentAgentId: input.currentAgentId,
			sessionKey: input.sessionKey,
		}) === "trader_owner";
	const isTraderTactical = isTraderTacticalCandidate({
		namespace: input.namespace,
		payloadDomain: input.payloadDomain,
		suppressionReason: input.suppressionReason,
		matchedClasses: input.matchedClasses,
		sourceAgent: input.sourceAgent,
	});

	if (!isTraderTactical) {
		return {
			isTraderTacticalCandidate: false,
			ownerPathExplicit,
			allowInRecall: true,
			suppressionPenalty: 0,
			reason: "non_trader_candidate",
		};
	}

	if (ownerPathExplicit) {
		return {
			isTraderTacticalCandidate: true,
			ownerPathExplicit: true,
			allowInRecall: true,
			suppressionPenalty: 0,
			reason: "trader_owner_path",
		};
	}

	return {
		isTraderTacticalCandidate: true,
		ownerPathExplicit: false,
		allowInRecall: false,
		suppressionPenalty: TRADER_TACTICAL_SUPPRESSION_PENALTY,
		reason: "generic_owner_path_suppressed",
	};
}

export function applyDomainGraphRerank(
	input: DomainGraphRerankInput,
): DomainGraphRerankOutput {
	const namespace = normalizeSessionToken(input.namespace);
	const payloadDomain = normalizeSessionToken(input.payloadDomain);
	const isTraderTactical =
		namespace.startsWith("agent.trader.") || payloadDomain === "trader_tactical";

	const domainBoost =
		input.route === "generic_shared"
			? isTraderTactical
				? -0.35
				: namespace.startsWith("shared.")
					? 0.06
					: 0
			: 0;

	const graphHits = Math.max(0, Math.min(6, Number(input.graphSignalHits || 0)));
	const graphBoost = graphHits * 0.03;
	const crossProjectPenalty = input.crossProject ? 0.18 : 0;
	const sameProjectCompensation = input.sameProject ? 0.04 : 0;

	const totalDelta = domainBoost + graphBoost + sameProjectCompensation - crossProjectPenalty;
	return {
		domainBoost,
		graphBoost,
		crossProjectPenalty,
		totalDelta,
	};
}

export function shouldApplyStrictSessionFilter(
	sessionMode: unknown,
	preferredSessionId: unknown,
): boolean {
	return (
		resolveSessionMode(sessionMode) === "strict" &&
		normalizeSessionToken(preferredSessionId).length > 0
	);
}

export function scoreSemanticCandidate(
	input: ScoreSemanticCandidateInput,
): ScoreSemanticCandidateOutput {
	const weightedBase = Math.min(
		1,
		Math.max(0, input.rawScore) *
			getNamespaceWeight(input.agentId, input.namespace),
	);

	const preferredSessionId = normalizeSessionToken(input.preferredSessionId);
	const payloadSessionId = normalizeSessionToken(input.payloadSessionId);
	const sameSession =
		typeof input.sameSession === "boolean"
			? input.sameSession
			: Boolean(
					preferredSessionId &&
						payloadSessionId &&
						preferredSessionId === payloadSessionId,
				);

	const sessionBoost =
		resolveSessionMode(input.sessionMode) === "soft" && sameSession
			? SOFT_SESSION_BOOST
			: 0;

	const promotionState = String(input.promotionState || "").toLowerCase();
	const promotionBoost =
		promotionState === "promoted"
			? PROMOTED_BOOST
			: promotionState === "distilled"
				? DISTILLED_BOOST
				: 0;
	const suppressionPenalty = Math.max(0, Number(input.suppressionPenalty || 0));
	const boostedScore = Math.min(
		1,
		weightedBase + sessionBoost + promotionBoost,
	);

	return {
		weightedBase,
		sessionBoost,
		promotionBoost,
		finalScore: Math.max(0, boostedScore - suppressionPenalty),
		sameSession,
	};
}
