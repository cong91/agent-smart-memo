import type { Slot, SlotDB } from "../../db/slot-db.js";

export type SlotScopeLabel = "private" | "team" | "public";

export interface BuildStatePackInput {
	userId: string;
	agentId: string;
	recentUpdateLimit?: number;
}

export interface StatePackRecentUpdate {
	key: string;
	updatedAt: string;
	category: string;
	scope: SlotScopeLabel;
}

export interface StatePackBuildResult {
	currentState: Record<string, Record<string, unknown>>;
	projectLivingState: unknown;
	recentUpdates: StatePackRecentUpdate[];
	activeTaskHints: string[];
	runContext: {
		currentProject?: string;
		currentTask?: string;
		phase?: string;
		focus?: string;
	};
}

interface SlotScope {
	userId: string;
	agentId: string;
	label: SlotScopeLabel;
	precedence: number;
}

function getSlotScopes(userId: string, agentId: string): SlotScope[] {
	return [
		{ userId, agentId, label: "private", precedence: 0 },
		{ userId, agentId: "__team__", label: "team", precedence: 1 },
		{
			userId: "__public__",
			agentId: "__public__",
			label: "public",
			precedence: 2,
		},
	];
}

function getSlotTimestampMap(slots: Slot[]): Record<string, string> {
	const timestamps: Record<string, string> = {};
	for (const slot of slots) {
		timestamps[slot.key] = slot.updated_at;
	}
	return timestamps;
}

function pickProjectLivingState(db: SlotDB, scopes: SlotScope[]): unknown {
	for (const scope of scopes) {
		const candidate = db.get(scope.userId, scope.agentId, {
			key: "project_living_state",
		});
		if (candidate && !Array.isArray(candidate)) {
			return candidate.value;
		}
	}
	return null;
}

function buildRunContext(
	currentState: Record<string, Record<string, unknown>>,
	projectLivingState: unknown,
): StatePackBuildResult["runContext"] {
	const projectState = currentState.project || {};
	const living =
		projectLivingState && typeof projectLivingState === "object"
			? (projectLivingState as Record<string, unknown>)
			: {};

	const currentProject =
		typeof projectState["project.current"] === "string"
			? String(projectState["project.current"])
			: typeof living.current_project === "string"
				? String(living.current_project)
				: undefined;

	const currentTask =
		typeof projectState["project.current_task"] === "string"
			? String(projectState["project.current_task"])
			: typeof living.current_task === "string"
				? String(living.current_task)
				: undefined;

	const phase =
		typeof projectState["project.phase"] === "string"
			? String(projectState["project.phase"])
			: typeof living.phase === "string"
				? String(living.phase)
				: undefined;

	const focus =
		typeof living.current_focus === "string"
			? String(living.current_focus)
			: typeof living.active_context === "string"
				? String(living.active_context)
				: undefined;

	return { currentProject, currentTask, phase, focus };
}

function buildActiveTaskHints(
	runContext: StatePackBuildResult["runContext"],
	projectLivingState: unknown,
): string[] {
	const hints = new Set<string>();
	for (const value of [
		runContext.currentProject,
		runContext.currentTask,
		runContext.phase,
		runContext.focus,
	]) {
		if (typeof value === "string" && value.trim()) hints.add(value.trim());
	}

	const living =
		projectLivingState && typeof projectLivingState === "object"
			? (projectLivingState as Record<string, unknown>)
			: null;
	if (living && Array.isArray(living.next_steps)) {
		for (const step of living.next_steps.slice(0, 3)) {
			if (typeof step === "string" && step.trim()) hints.add(step.trim());
		}
	}

	return [...hints];
}

export function buildStatePack(
	db: SlotDB,
	input: BuildStatePackInput,
): StatePackBuildResult {
	const scopes = getSlotScopes(input.userId, input.agentId);
	const mergedState: Record<string, Record<string, unknown>> = {};
	const mergedTimestamps: Record<string, Record<string, string>> = {};
	const recentSlots: Array<StatePackRecentUpdate & { precedence: number }> = [];

	for (const scope of scopes) {
		const currentState = db.getCurrentState(scope.userId, scope.agentId);
		const slots = db.list(scope.userId, scope.agentId);
		const timestamps = getSlotTimestampMap(slots);

		for (const slot of slots) {
			recentSlots.push({
				key: slot.key,
				updatedAt: slot.updated_at,
				category: slot.category,
				scope: scope.label,
				precedence: scope.precedence,
			});
		}

		for (const [category, categorySlots] of Object.entries(currentState)) {
			if (!mergedState[category]) {
				mergedState[category] = {};
				mergedTimestamps[category] = {};
			}

			for (const [key, value] of Object.entries(categorySlots)) {
				if (key.startsWith("_")) continue;
				const existingTs = mergedTimestamps[category]?.[key];
				const nextTs = timestamps[key] || "";
				if (!existingTs || nextTs >= existingTs) {
					mergedState[category][key] = value;
					mergedTimestamps[category][key] = nextTs;
				}
			}
		}
	}

	const projectLivingState = pickProjectLivingState(db, scopes);
	const runContext = buildRunContext(mergedState, projectLivingState);
	const activeTaskHints = buildActiveTaskHints(runContext, projectLivingState);

	return {
		currentState: mergedState,
		projectLivingState,
		recentUpdates: recentSlots
			.sort((a, b) => {
				const tsDiff =
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
				if (tsDiff !== 0) return tsDiff;
				return a.precedence - b.precedence;
			})
			.slice(0, input.recentUpdateLimit ?? 5)
			.map(({ precedence: _precedence, ...slot }) => slot),
		activeTaskHints,
		runContext,
	};
}
