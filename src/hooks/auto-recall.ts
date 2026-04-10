/**
 * Auto-Recall Enhancement - Task 3.4
 *
 * Automatically injects Slot Memory, Graph context, and Semantic Memories into System Prompt
 * before each agent run (OnBeforeAgentStart hook).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildRecallInjectionParts } from "../core/precedence/recall-precedence.js";
import {
	applyDomainGraphRerank,
	normalizeSessionToken,
	resolveRecallDomainRoute,
	resolveTraderRecallGate,
	scoreSemanticCandidate,
} from "../core/retrieval-policy.js";

import {
	type RunModeMessageLike,
	resolveAsmRunMode,
} from "../core/usecases/run-mode-resolver.js";
import {
	buildWikiWorkingSet,
	searchWikiMemory,
} from "../core/usecases/semantic-memory-usecase.js";
import { buildStatePack } from "../core/usecases/state-pack-builder.js";
import type { SlotDB } from "../db/slot-db.js";
import {
	getAgentNamespaces,
	type MemoryNamespace,
	normalizeUserId,
} from "../shared/memory-config.js";

// Token budget for different context types
const TOKEN_BUDGETS = {
	currentState: 500,
	recentSlots: 300,
	graphContext: 400,
	semanticMemories: 600,
};

interface WikiWorkingSetSection {
	label: string;
	pages: Array<{
		path: string;
		title: string;
		kind: string;
		layer: string;
		reason: string;
		updatedAt?: number;
		namespace?: string;
	}>;
}

interface RecallContext {
	sessionKey: string;
	stateDir: string;
	userId: string;
	agentId: string;
	messages?: RunModeMessageLike[];
}

interface RecallHintSet {
	sessionKeys: Set<string>;
	topicTags: Set<string>;
	graphTags: Set<string>;
}

interface SemanticMemoryCandidate {
	text: string;
	score: number;
	namespace?: string;
	payload?: Record<string, any>;
	adjustedScore?: number;
	sameSession?: boolean;
	sameProject?: boolean;
	crossProject?: boolean;
}

interface SemanticSelectionResult {
	memories: Array<{ text: string; score: number; namespace?: string }>;
	recallConfidence: "high" | "medium" | "low";
	suppressed: boolean;
	suppressionReason?: string;
}

/**
 * Format current state as XML for system prompt injection
 */
function formatCurrentState(
	state: Record<string, Record<string, unknown>>,
): string {
	if (Object.keys(state).length === 0) return "";

	let xml = "<current-state>\n";
	for (const [category, slots] of Object.entries(state)) {
		xml += `  <${category}>\n`;
		for (const [key, value] of Object.entries(slots)) {
			// Skip internal keys (e.g. _autocapture_hash)
			if (key.startsWith("_")) continue;
			const displayKey = key.includes(".")
				? key.split(".").slice(1).join(".")
				: key;
			const displayValue =
				typeof value === "object" ? JSON.stringify(value) : String(value);
			// Truncate long values
			const truncated =
				displayValue.length > 100
					? displayValue.substring(0, 100) + "..."
					: displayValue;
			xml += `    <${displayKey}>${truncated}</${displayKey}>\n`;
		}
		xml += `  </${category}>\n`;
	}
	xml += "</current-state>";
	return xml;
}

function formatProjectLivingState(value: unknown): string {
	if (!value || typeof value !== "object") return "";

	const v = value as {
		last_actions?: unknown;
		current_focus?: unknown;
		next_steps?: unknown;
	};

	const lastActions = Array.isArray(v.last_actions)
		? v.last_actions.map((x) => String(x)).slice(-5)
		: [];
	const currentFocus =
		typeof v.current_focus === "string" ? v.current_focus : "";
	const nextSteps = Array.isArray(v.next_steps)
		? v.next_steps.map((x) => String(x)).slice(0, 5)
		: [];

	if (lastActions.length === 0 && !currentFocus && nextSteps.length === 0) {
		return "";
	}

	const xmlEscape = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");

	let xml = "<project-living-state>\n";

	if (lastActions.length > 0) {
		xml += "  <last_actions>\n";
		lastActions.forEach((a, i) => {
			xml += `    <action index="${i + 1}">${xmlEscape(a)}</action>\n`;
		});
		xml += "  </last_actions>\n";
	}

	if (currentFocus) {
		xml += `  <current_focus>${xmlEscape(currentFocus)}</current_focus>\n`;
	}

	if (nextSteps.length > 0) {
		xml += "  <next_steps>\n";
		nextSteps.forEach((s, i) => {
			xml += `    <step index="${i + 1}">${xmlEscape(s)}</step>\n`;
		});
		xml += "  </next_steps>\n";
	}

	xml += "</project-living-state>";
	return xml;
}

/**
 * Format graph context showing related entities
 */
function formatGraphContext(
	entities: Array<{ name: string; type: string }>,
	relationships: Array<{ source: string; target: string; type: string }>,
	workingSetHints?: Array<{ path: string; reason: string }>,
): string {
	if (
		entities.length === 0 &&
		(!workingSetHints || workingSetHints.length === 0)
	)
		return "";

	let xml = "<knowledge-graph>\n";

	// List entities
	xml += "  <entities>\n";
	entities.slice(0, 10).forEach((e) => {
		// Limit to 10 entities
		xml += `    <entity name="${e.name}" type="${e.type}"/>\n`;
	});
	xml += "  </entities>\n";

	// List key relationships
	if (relationships.length > 0) {
		xml += "  <relationships>\n";
		relationships.slice(0, 8).forEach((r) => {
			// Limit to 8 relationships
			xml += `    <rel>${r.source} --[${r.type}]--> ${r.target}</rel>\n`;
		});
		xml += "  </relationships>\n";
	}

	if (workingSetHints && workingSetHints.length > 0) {
		xml += "  <working-set-hints>\n";
		workingSetHints.slice(0, 4).forEach((hint, index) => {
			xml += `    <hint index="${index + 1}" path="${escapeXml(hint.path)}">${escapeXml(hint.reason)}</hint>\n`;
		});
		xml += "  </working-set-hints>\n";
	}

	xml += "</knowledge-graph>";
	return xml;
}

/**
 * Format semantic memories as XML for system prompt injection
 */
function formatSemanticMemories(
	memories: Array<{ text: string; score: number; namespace?: string }>,
): string {
	if (memories.length === 0) return "";

	let xml = "<semantic-memories>\n";
	memories.forEach((m, i) => {
		const nsAttr = m.namespace ? ` ns="${m.namespace}"` : "";
		xml += `  <memory index="${i + 1}" relevance="${(m.score * 100).toFixed(0)}%"${nsAttr}>${m.text}</memory>\n`;
	});
	xml += "</semantic-memories>";
	return xml;
}

function escapeXml(value: string): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatWikiWorkingSet(input: {
	wikiRoot: string;
	entrypoint: string;
	sections: WikiWorkingSetSection[];
}): string {
	const sections = input.sections.filter((section) => section.pages.length > 0);
	if (!input.wikiRoot || !input.entrypoint || sections.length === 0) return "";

	let xml = `<wiki-working-set>\n  <wiki-root>${escapeXml(input.wikiRoot)}</wiki-root>\n  <entrypoint>${escapeXml(input.entrypoint)}</entrypoint>`;
	for (const section of sections) {
		xml += `\n  <section name="${escapeXml(section.label)}">`;
		for (const [index, page] of section.pages.entries()) {
			const attrs = [
				`index="${index + 1}"`,
				`kind="${escapeXml(page.kind)}"`,
				`layer="${escapeXml(page.layer)}"`,
				`path="${escapeXml(page.path)}"`,
			];
			if (page.namespace)
				attrs.push(`namespace="${escapeXml(page.namespace)}"`);
			if (page.updatedAt) attrs.push(`updated_at="${String(page.updatedAt)}"`);
			xml += `\n    <page ${attrs.join(" ")}>`;
			xml += `\n      <title>${escapeXml(page.title)}</title>`;
			xml += `\n      <reason>${escapeXml(page.reason)}</reason>`;
			xml += "\n    </page>";
		}
		xml += "\n  </section>";
	}
	xml += "\n</wiki-working-set>";
	return xml;
}

function formatRecentUpdates(
	updates: Array<{
		key: string;
		updatedAt: string;
		scope: string;
		category: string;
	}>,
): string {
	if (updates.length === 0) return "";
	return `<recent-updates>\n${updates
		.map(
			(update) =>
				`  <update key="${update.key}" category="${update.category}" scope="${update.scope}" at="${update.updatedAt}"/>`,
		)
		.join("\n")}\n</recent-updates>`;
}

function formatAsmRuntime(input: {
	runMode: "light" | "wiki-first" | "write-back";
	reasons: string[];
	activeTaskHints: string[];
}): string {
	const modeGuidance =
		input.runMode === "wiki-first"
			? [
					"treat wiki pages as the primary working surface for this run",
					"treat markdown wiki pages as a rendered working surface, not the only storage truth",
					"keep QMD-backed persistence as canonical backend state when runtime is configured for QMD storage",
					"inspect wiki root, entrypoint, and canonical pages before leaning on supporting recall",
					"use supporting recall and graph context only as routing/evidence, not as the primary cognition layer",
				]
			: input.runMode === "write-back"
				? [
						"preserve write-back lane behavior and ownership boundaries",
						"do not rewrite read-path guidance into snippet-first recall",
					]
				: [
						"keep context light unless project-specific signals require wiki-first inspection",
					];
	const reasons = input.reasons
		.slice(0, 5)
		.map((reason, index) => `  <reason index="${index + 1}">${reason}</reason>`)
		.join("\n");
	const hints = input.activeTaskHints
		.slice(0, 5)
		.map((hint, index) => `  <hint index="${index + 1}">${hint}</hint>`)
		.join("\n");

	let xml = `<asm-runtime>\n  <run-mode>${input.runMode}</run-mode>`;
	xml += "\n  <contract>";
	xml +=
		input.runMode === "wiki-first"
			? "working-surface"
			: input.runMode === "write-back"
				? "write-back"
				: "light";
	xml += "</contract>";
	if (input.runMode === "wiki-first") {
		xml +=
			"\n  <storage-boundary><canonical-persistence>qmd-backend</canonical-persistence><working-surface>markdown-wiki</working-surface><slotdb-role>state-control</slotdb-role><graph-role>support-routing</graph-role></storage-boundary>";
	}
	if (reasons) {
		xml += `\n  <reasons>\n${reasons}\n  </reasons>`;
	}
	if (hints) {
		xml += `\n  <active-task-hints>\n${hints}\n  </active-task-hints>`;
	}
	if (modeGuidance.length > 0) {
		xml += "\n  <guidance>\n";
		modeGuidance.forEach((guidance, index) => {
			xml += `    <instruction index="${index + 1}">${escapeXml(guidance)}</instruction>\n`;
		});
		xml += "  </guidance>";
	}
	xml += "\n</asm-runtime>";
	return xml;
}

function normalizeToken(value: unknown): string {
	if (value === null || value === undefined) return "";
	return normalizeSessionToken(value);
}

function splitToTags(input: string): string[] {
	return input
		.split(/[\s,;|:/\\]+/g)
		.map((x) => normalizeToken(x))
		.filter((x) => x.length >= 3)
		.slice(0, 12);
}

function collectRecallHints(
	sessionKey: string,
	projectLivingStateValue: unknown,
	currentState: Record<string, Record<string, unknown>>,
): RecallHintSet {
	const hints: RecallHintSet = {
		sessionKeys: new Set<string>(),
		topicTags: new Set<string>(),
		graphTags: new Set<string>(),
	};

	const normalizedSession = normalizeToken(sessionKey);
	if (normalizedSession) hints.sessionKeys.add(normalizedSession);

	const sessionTail = normalizeToken(sessionKey.split(":").slice(2).join(":"));
	if (sessionTail) hints.sessionKeys.add(sessionTail);

	const living =
		projectLivingStateValue && typeof projectLivingStateValue === "object"
			? (projectLivingStateValue as Record<string, unknown>)
			: null;

	if (living) {
		const activeContext = normalizeToken(living.active_context);
		if (activeContext) {
			hints.topicTags.add(activeContext);
			splitToTags(activeContext).forEach((t) => hints.topicTags.add(t));
		}

		const currentFocus = normalizeToken(living.current_focus);
		if (currentFocus) {
			splitToTags(currentFocus).forEach((t) => hints.topicTags.add(t));
		}
	}

	const projectState = currentState.project || {};
	for (const key of [
		"project.current",
		"project.current_epic",
		"project.current_task",
		"project.phase",
		"project.status",
	]) {
		const raw = projectState[key];
		const normalized = normalizeToken(raw);
		if (normalized) {
			hints.topicTags.add(normalized);
			splitToTags(normalized).forEach((t) => hints.topicTags.add(t));
		}
	}

	return hints;
}

function getSessionTokenFromPayload(payload: Record<string, any>): string {
	const direct = normalizeToken(
		payload.sessionId ||
			payload.session_id ||
			payload.thread_id ||
			payload.threadId ||
			payload.conversationId ||
			payload.conversation_id,
	);
	if (direct) return direct;

	const meta =
		payload.metadata && typeof payload.metadata === "object"
			? (payload.metadata as Record<string, any>)
			: {};
	return normalizeToken(
		meta.sessionId ||
			meta.session_id ||
			meta.thread_id ||
			meta.threadId ||
			meta.conversationId ||
			meta.conversation_id,
	);
}

function collectPayloadTopicTags(payload: Record<string, any>): Set<string> {
	const tags = new Set<string>();
	const meta =
		payload.metadata && typeof payload.metadata === "object"
			? (payload.metadata as Record<string, any>)
			: {};

	const rawCandidates: unknown[] = [
		payload.project,
		payload.projectTag,
		payload.project_tag,
		payload.topic,
		payload.topicTag,
		payload.topic_tag,
		meta.project,
		meta.projectTag,
		meta.project_tag,
		meta.topic,
		meta.topicTag,
		meta.topic_tag,
		payload.namespace,
	];

	for (const raw of rawCandidates) {
		const v = normalizeToken(raw);
		if (!v) continue;
		tags.add(v);
		splitToTags(v).forEach((x) => tags.add(x));
	}

	const listCandidates: unknown[] = [
		payload.tags,
		payload.topics,
		meta.tags,
		meta.topics,
	];
	for (const lc of listCandidates) {
		if (Array.isArray(lc)) {
			lc.forEach((item) => {
				const v = normalizeToken(item);
				if (v) {
					tags.add(v);
					splitToTags(v).forEach((x) => tags.add(x));
				}
			});
		}
	}

	return tags;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
	if (a.size === 0 || b.size === 0) return false;
	for (const x of a) {
		if (b.has(x)) return true;
	}
	return false;
}

function countIntersection(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let count = 0;
	for (const x of a) {
		if (b.has(x)) count += 1;
	}
	return count;
}

function collectGraphTags(
	entities: Array<{ name: string; type: string }>,
	relationships: Array<{ source: string; target: string; type: string }>,
): Set<string> {
	const tags = new Set<string>();
	for (const e of entities) {
		const name = normalizeToken(e.name);
		if (name) {
			tags.add(name);
			splitToTags(name).forEach((x) => tags.add(x));
		}
		const type = normalizeToken(e.type);
		if (type) tags.add(type);
	}
	for (const r of relationships) {
		for (const raw of [r.source, r.target, r.type]) {
			const token = normalizeToken(raw);
			if (!token) continue;
			tags.add(token);
			splitToTags(token).forEach((x) => tags.add(x));
		}
	}
	return tags;
}

function uniqueGraphSignals(
	entities: Array<{ name: string; type: string }>,
	relationships: Array<{ source: string; target: string; type: string }>,
): string[] {
	return [...collectGraphTags(entities, relationships)].slice(0, 16);
}

function applyRecencyBoost(
	baseScore: number,
	payload: Record<string, any>,
	sameSession: boolean,
): number {
	const tsRaw = payload.updatedAt || payload.timestamp || payload.ts;
	const ts = Number(tsRaw);
	if (!Number.isFinite(ts) || ts <= 0) return baseScore;

	const ageMs = Math.max(0, Date.now() - ts);
	if (sameSession) {
		if (ageMs <= 60 * 60 * 1000) return baseScore + 0.12;
		if (ageMs <= 24 * 60 * 60 * 1000) return baseScore + 0.07;
		if (ageMs <= 3 * 24 * 60 * 60 * 1000) return baseScore + 0.03;
	}
	if (ageMs <= 60 * 60 * 1000) return baseScore + 0.02;
	return baseScore;
}

export function selectSemanticMemories(
	results: Array<{ score: number; payload?: Record<string, any> }>,
	ctx: RecallContext,
	hints: RecallHintSet,
): SemanticSelectionResult {
	const route = resolveRecallDomainRoute({
		currentAgentId: ctx.agentId,
		sessionKey: ctx.sessionKey,
	});

	const weighted: SemanticMemoryCandidate[] = results
		.filter((r: any) => (r.payload?.namespace || "") !== "noise.filtered")
		.map((r: any) => {
			const payload = (r.payload || {}) as Record<string, any>;
			const ns = String(payload.namespace || "");
			const gate = resolveTraderRecallGate({
				currentAgentId: ctx.agentId,
				sessionKey: ctx.sessionKey,
				namespace: ns,
				payloadDomain: payload.domain,
				suppressionReason:
					payload.suppressionReason || payload.suppression_reason,
				matchedClasses: payload.matchedClasses || payload.matched_classes,
				sourceAgent: payload.source_agent || payload.agent,
			});

			const sessionToken = getSessionTokenFromPayload(payload);
			const sameSession = sessionToken
				? hints.sessionKeys.has(sessionToken)
				: false;
			const preferredSession =
				hints.sessionKeys.size > 0
					? [...hints.sessionKeys][0]
					: normalizeSessionToken(ctx.sessionKey);
			const scored = scoreSemanticCandidate({
				rawScore: r.score,
				agentId: ctx.agentId,
				namespace: ns,
				sessionMode: "soft",
				preferredSessionId: preferredSession,
				payloadSessionId: sessionToken,
				sameSession,
				promotionState: payload.promotion_state,
				suppressionPenalty: gate.suppressionPenalty,
			});

			const memoryTags = collectPayloadTopicTags(payload);
			const sameProject = intersects(hints.topicTags, memoryTags);
			const crossProject =
				hints.topicTags.size > 0 && memoryTags.size > 0 && !sameProject;
			const graphSignalHits = countIntersection(hints.graphTags, memoryTags);

			let adjusted = scored.finalScore;
			if (sameSession) adjusted += 0.08;
			if (sameProject) adjusted += 0.1;
			if (crossProject) adjusted -= 0.18;
			const rerank = applyDomainGraphRerank({
				route,
				namespace: ns,
				payloadDomain: payload.domain,
				graphSignalHits,
				sameProject,
				crossProject,
			});
			adjusted += rerank.totalDelta;
			adjusted = applyRecencyBoost(adjusted, payload, sameSession);

			return {
				text: payload.text || "",
				score: scored.weightedBase,
				namespace: ns,
				payload,
				adjustedScore: Math.max(0, Math.min(1, adjusted)),
				sameSession,
				sameProject,
				crossProject,
			};
		})
		.filter((m) => {
			if (m.text.length === 0) return false;
			const gate = resolveTraderRecallGate({
				currentAgentId: ctx.agentId,
				sessionKey: ctx.sessionKey,
				namespace: m.namespace,
				payloadDomain: m.payload?.domain,
				suppressionReason:
					m.payload?.suppressionReason || m.payload?.suppression_reason,
				matchedClasses: m.payload?.matchedClasses || m.payload?.matched_classes,
				sourceAgent: m.payload?.source_agent || m.payload?.agent,
			});
			if (!gate.allowInRecall) return false;
			return true;
		})
		.sort((a, b) => (b.adjustedScore || 0) - (a.adjustedScore || 0));

	const kept = weighted
		.filter((m) => (m.adjustedScore || 0) >= 0.7)
		.slice(0, 5);

	if (kept.length === 0) {
		return {
			memories: [],
			recallConfidence: "low",
			suppressed: true,
			suppressionReason: "no_high_relevance",
		};
	}

	const top3 = kept.slice(0, 3);
	const crossCount = top3.filter((m) => m.crossProject).length;
	const sessionCount = top3.filter((m) => m.sameSession).length;
	const projectCount = top3.filter((m) => m.sameProject).length;

	// ASM-42 hardening:
	// Require at least one same-session or same-project anchor in top hits.
	// This avoids injecting seemingly relevant but cross-scope memories.
	if (sessionCount === 0 && projectCount === 0) {
		return {
			memories: [],
			recallConfidence: "low",
			suppressed: true,
			suppressionReason: "missing_scope_anchor",
		};
	}

	if (crossCount >= 2 && sessionCount === 0 && projectCount === 0) {
		return {
			memories: [],
			recallConfidence: "low",
			suppressed: true,
			suppressionReason: "mixed_or_cross_topic_top_hits",
		};
	}

	const recallConfidence: "high" | "medium" | "low" =
		sessionCount >= 1 || projectCount >= 2
			? "high"
			: crossCount >= 1
				? "medium"
				: "high";

	const cap = recallConfidence === "medium" ? 2 : 5;
	return {
		memories: kept.slice(0, cap).map((m) => ({
			text: m.text,
			score: m.adjustedScore || m.score,
			namespace: m.namespace,
		})),
		recallConfidence,
		suppressed: false,
	};
}

/**
 * Gather auto-recall context from all memory sources
 */
export async function gatherRecallContext(
	db: SlotDB,
	ctx: RecallContext,
	userQuery?: string,
): Promise<{
	asmRuntime: string;
	currentState: string;
	projectLivingState: string;
	wikiWorkingSet: string;
	graphContext: string;
	recentUpdates: string;
	semanticMemories: string;
	recallMeta: {
		recall_confidence: "high" | "medium" | "low";
		recall_suppressed: boolean;
		suppression_reason?: string;
	};
}> {
	const statePack = buildStatePack(db, {
		userId: ctx.userId,
		agentId: ctx.agentId,
	});

	const currentStateXml = formatCurrentState(statePack.currentState);
	const projectLivingStateXml = formatProjectLivingState(
		statePack.projectLivingState,
	);

	const recallHints = collectRecallHints(
		ctx.sessionKey,
		statePack.projectLivingState,
		statePack.currentState,
	);

	const runMode = resolveAsmRunMode({
		sessionKey: ctx.sessionKey,
		userQuery,
		messages: ctx.messages,
		stateSummary: {
			activeTaskHints: statePack.activeTaskHints,
			projectLivingState: statePack.projectLivingState,
			currentState: statePack.currentState,
		},
	});
	const asmRuntime = formatAsmRuntime({
		runMode: runMode.runMode,
		reasons: runMode.reasons,
		activeTaskHints: statePack.activeTaskHints,
	});

	// 2. Get Graph Context (from private scope only for privacy)
	const allEntities = db.graph.listEntities(ctx.userId, ctx.agentId);
	const entityList = allEntities
		.slice(0, 10)
		.map((e) => ({ name: e.name, type: e.type }));

	const relationships: Array<{ source: string; target: string; type: string }> =
		[];
	for (const entity of allEntities.slice(0, 5)) {
		const rels = db.graph.getRelationships(
			ctx.userId,
			ctx.agentId,
			entity.id,
			"outgoing",
		);
		for (const rel of rels.slice(0, 2)) {
			const target = db.graph.getEntity(
				ctx.userId,
				ctx.agentId,
				rel.target_entity_id,
			);
			if (target) {
				relationships.push({
					source: entity.name,
					target: target.name,
					type: rel.relation_type,
				});
			}
		}
	}
	const graphSignals = uniqueGraphSignals(entityList, relationships);
	const wikiWorkingSet = buildWikiWorkingSet({
		namespaces: getAgentNamespaces(ctx.agentId),
		sourceAgent: ctx.agentId,
		query: userQuery,
		userId: ctx.userId,
		preferredSessionId: ctx.sessionKey,
		currentProject: statePack.runContext.currentProject,
		currentTask: statePack.runContext.currentTask,
		phase: statePack.runContext.phase,
		focus: statePack.runContext.focus,
		activeTaskHints: statePack.activeTaskHints,
		graphSignals,
		includeDrafts: false,
		includeRaw: false,
	});
	const graphExpandedPages = wikiWorkingSet?.graphAssist.expandedPages || [];
	const wikiWorkingSetXml = wikiWorkingSet
		? formatWikiWorkingSet({
				wikiRoot: wikiWorkingSet.wikiRoot,
				entrypoint: wikiWorkingSet.entrypoint,
				sections: [
					{ label: "canonical-pages", pages: wikiWorkingSet.canonicalPages },
					{ label: "task-pages", pages: wikiWorkingSet.taskPages },
					{ label: "rule-pages", pages: wikiWorkingSet.rulePages },
					{ label: "runbook-pages", pages: wikiWorkingSet.runbookPages },
					{ label: "supporting-pages", pages: wikiWorkingSet.supportingPages },
					{ label: "graph-expanded-pages", pages: graphExpandedPages },
				],
			})
		: "";

	const graphContextXml = formatGraphContext(
		entityList,
		relationships,
		graphExpandedPages.map((page) => ({
			path: page.path,
			reason: page.reason,
		})),
	);
	recallHints.graphTags = collectGraphTags(entityList, relationships);
	graphSignals.forEach((signal: string) => recallHints.graphTags.add(signal));

	const recentUpdates = formatRecentUpdates(statePack.recentUpdates);

	// 4. Semantic Memories: wiki-only primary path after phase-1 cutover.
	let semanticMemoriesXml = "";
	let recallMeta: {
		recall_confidence: "high" | "medium" | "low";
		recall_suppressed: boolean;
		suppression_reason?: string;
	} = {
		recall_confidence: "medium",
		recall_suppressed: false,
	};

	if (wikiWorkingSet && userQuery && userQuery.trim().length > 0) {
		try {
			// Get agent's namespaces
			const namespaces = getAgentNamespaces(ctx.agentId);

			const wikiResults = searchWikiMemory({
				query: userQuery,
				limit: 8,
				minScore: 0.7,
				namespaces,
				sourceAgent: ctx.agentId,
				sessionMode: "soft",
				preferredSessionId: ctx.sessionKey,
				userId: ctx.userId,
				includeDrafts: false,
				includeRaw: false,
			});

			const selection = selectSemanticMemories(
				wikiResults.map((r) => ({
					score: r.rawScore,
					payload: {
						id: r.id,
						text: r.text,
						namespace: r.namespace,
						timestamp: r.timestamp,
						metadata: r.metadata,
						source_type: "wiki",
						sessionId: (r.metadata?.sessionId as string | undefined) || null,
						userId: (r.metadata?.userId as string | undefined) || null,
						source_agent:
							(r.metadata?.source_agent as string | undefined) || ctx.agentId,
						promotion_state: "distilled",
					},
				})),
				ctx,
				recallHints,
			);
			recallMeta = {
				recall_confidence: selection.recallConfidence,
				recall_suppressed: selection.suppressed,
				suppression_reason: selection.suppressionReason,
			};
			semanticMemoriesXml = formatSemanticMemories(selection.memories);

			if (selection.memories.length > 0) {
				console.log(
					`[AutoRecall] Found ${selection.memories.length} supporting wiki memories for query (confidence=${selection.recallConfidence}, namespaces: ${namespaces.join(", ")})`,
				);
			} else if (selection.suppressed) {
				console.warn(
					`[AutoRecall] Wiki recall suppressed due to low confidence: ${selection.suppressionReason || "unknown"}`,
				);
			}
		} catch (error: any) {
			console.error(
				"[AutoRecall] Error querying semantic memories:",
				error.message,
			);
			semanticMemoriesXml = "";
			recallMeta = {
				recall_confidence: "low",
				recall_suppressed: true,
				suppression_reason: "semantic_search_error",
			};
		}
	} else if (!wikiWorkingSet && userQuery && userQuery.trim().length > 0) {
		recallMeta = {
			recall_confidence: "low",
			recall_suppressed: true,
			suppression_reason: "wiki_working_set_unavailable",
		};
	}

	return {
		asmRuntime,
		currentState: currentStateXml,
		projectLivingState: projectLivingStateXml,
		wikiWorkingSet: wikiWorkingSetXml,
		graphContext: graphContextXml,
		recentUpdates,
		semanticMemories: semanticMemoriesXml,
		recallMeta,
	};
}

/**
 * Inject recall context into system prompt
 */
export function injectRecallContext(
	systemPrompt: string,
	context: {
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
	},
): string {
	const injectionParts = buildRecallInjectionParts(context);

	if (injectionParts.length === 0) {
		return systemPrompt;
	}

	const injection = `<!-- Auto-Injected Context -->\n${injectionParts.join("\n\n")}\n<!-- End Auto-Injected Context -->\n\n`;

	// Insert after any existing system tags or at the beginning
	if (systemPrompt.includes("<system>")) {
		// Insert after </system> tag
		return systemPrompt.replace("</system>", `</system>\n\n${injection}`);
	}

	// Prepend to the prompt
	return injection + systemPrompt;
}

/**
 * Register auto-recall hook
 */
export function registerAutoRecall(api: OpenClawPluginApi, db: SlotDB): void {
	// Hook into agent lifecycle using the on() method
	api.on("before_agent_start", async (event: unknown, ctx: unknown) => {
		const typedEvent = event as {
			messages?: Array<{ role: string; content: string }>;
			systemPrompt?: string;
		};
		const typedCtx = ctx as { sessionKey?: string };

		const sessionKey = typedCtx?.sessionKey || "agent:main:default";
		const parts = sessionKey.split(":");
		const agentId = parts.length >= 2 ? parts[1] : "main";
		const userId = normalizeUserId(
			parts.length >= 3 ? parts.slice(2).join(":") : "default",
		);

		// Extract user query from last user message for semantic search
		let userQuery = "";
		if (typedEvent?.messages && typedEvent.messages.length > 0) {
			// Find the last user message
			for (let i = typedEvent.messages.length - 1; i >= 0; i--) {
				const msg = typedEvent.messages[i];
				if (msg.role === "user" && msg.content) {
					userQuery =
						typeof msg.content === "string"
							? msg.content
							: JSON.stringify(msg.content);
					break;
				}
			}
		}

		const recallCtx: RecallContext = {
			sessionKey,
			stateDir:
				process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
			userId,
			agentId,
			messages: typedEvent?.messages,
		};

		try {
			const context = await gatherRecallContext(db, recallCtx, userQuery);

			// Get original system prompt from event if available
			const originalPrompt = typedEvent?.systemPrompt || "";

			// Return system prompt override via the hook result
			return {
				systemPrompt: injectRecallContext(originalPrompt, context),
			};
		} catch (error) {
			console.error("Auto-recall error:", error);
		}
	});
}

/**
 * Get formatted recall context for manual injection
 */
export async function getRecallContextText(
	db: SlotDB,
	sessionKey: string,
	userQuery?: string,
): Promise<string> {
	const parts = sessionKey.split(":");
	const agentId = parts.length >= 2 ? parts[1] : "main";
	const userId = normalizeUserId(
		parts.length >= 3 ? parts.slice(2).join(":") : "default",
	);

	const ctx: RecallContext = {
		sessionKey,
		stateDir: process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
		userId,
		agentId,
	};

	const context = await gatherRecallContext(db, ctx, userQuery);

	return buildRecallInjectionParts(context).join("\n\n");
}
