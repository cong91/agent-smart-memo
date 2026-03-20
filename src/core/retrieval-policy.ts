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
}

export interface ScoreSemanticCandidateOutput {
	weightedBase: number;
	sessionBoost: number;
	promotionBoost: number;
	finalScore: number;
	sameSession: boolean;
}

export const SOFT_SESSION_BOOST = 0.12;
export const PROMOTED_BOOST = 0.08;
export const DISTILLED_BOOST = 0.03;

export function normalizeSessionToken(value: unknown): string {
	return String(value || "")
		.trim()
		.toLowerCase();
}

export function resolveSessionMode(value: unknown): SessionMode {
	return value === "strict" ? "strict" : "soft";
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

	return {
		weightedBase,
		sessionBoost,
		promotionBoost,
		finalScore: Math.min(1, weightedBase + sessionBoost + promotionBoost),
		sameSession,
	};
}
