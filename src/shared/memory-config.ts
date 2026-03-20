/**
 * Shared Memory Configuration
 * Source of truth for namespace routing, noise policy v2, and recall weighting
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_CORE_AGENTS = [
	"assistant",
	"scrum",
	"fullstack",
	"trader",
	"creator",
] as const;
export type DefaultCoreAgent = (typeof DEFAULT_CORE_AGENTS)[number];

export type AgentNamespace =
	| `agent.${string}.working_memory`
	| `agent.${string}.lessons`
	| `agent.${string}.decisions`;

/** New normalized namespace model (ASM-5, dynamic agent registry aware) */
export type MemoryNamespace =
	| AgentNamespace
	| "shared.project_context"
	| "shared.rules_slotdb"
	| "shared.runbooks"
	| "noise.filtered";

export type MemoryScope = "session" | "agent" | "project" | "shared";

export type MemoryType =
	| "fact"
	| "lesson"
	| "decision"
	| "runbook"
	| "episodic_trace"
	| "task_context"
	| "rule"
	| "noise";

export type PromotionState = "raw" | "distilled" | "promoted" | "deprecated";

export type MemorySourceType =
	| "auto_capture"
	| "manual"
	| "tool_call"
	| "migration"
	| "promotion";

/** Legacy namespaces kept for migration compatibility */
export type LegacyNamespace =
	| "agent_decisions"
	| "user_profile"
	| "project_context"
	| "trading_signals"
	| "agent_learnings"
	| "system_rules"
	| "session_summaries"
	| "market_patterns"
	| "default";

interface OpenClawAgentListEntry {
	id?: unknown;
}

interface OpenClawRuntimeConfig {
	agents?: {
		list?: OpenClawAgentListEntry[];
	};
}

const STATIC_FALLBACK_AGENT_SET = new Set<string>(DEFAULT_CORE_AGENTS);
const AGENT_NAMESPACE_RE =
	/^agent\.([a-z0-9][a-z0-9_-]*)\.(working_memory|lessons|decisions)$/i;

let cachedRegistry: {
	configPath: string;
	mtimeMs: number;
	agentIds: string[];
} | null = null;

function normalizeAgentId(agentId: string | null | undefined): string {
	return String(agentId || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function getStateDir(): string {
	return process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
}

export function resolveOpenClawConfigPath(): string {
	const explicit =
		process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_RUNTIME_CONFIG;
	if (explicit && explicit.trim()) {
		return explicit.trim();
	}
	return join(getStateDir(), "openclaw.json");
}

function readRuntimeAgentIdsFromConfig(configPath: string): string[] {
	if (!existsSync(configPath)) {
		return [...DEFAULT_CORE_AGENTS];
	}

	try {
		const parsed = JSON.parse(
			readFileSync(configPath, "utf8"),
		) as OpenClawRuntimeConfig;
		const listed = Array.isArray(parsed?.agents?.list)
			? parsed.agents.list
			: [];
		const dynamicIds = listed
			.map((entry) => normalizeAgentId(String(entry?.id || "")))
			.filter(Boolean);

		const merged = new Set<string>([...DEFAULT_CORE_AGENTS, ...dynamicIds]);
		return [...merged];
	} catch {
		return [...DEFAULT_CORE_AGENTS];
	}
}

export function getRegisteredAgentIds(): string[] {
	const configPath = resolveOpenClawConfigPath();

	try {
		const mtimeMs = existsSync(configPath) ? statSync(configPath).mtimeMs : -1;
		if (
			cachedRegistry &&
			cachedRegistry.configPath === configPath &&
			cachedRegistry.mtimeMs === mtimeMs
		) {
			return [...cachedRegistry.agentIds];
		}

		const agentIds = readRuntimeAgentIdsFromConfig(configPath);
		cachedRegistry = { configPath, mtimeMs, agentIds };
		return [...agentIds];
	} catch {
		return [...DEFAULT_CORE_AGENTS];
	}
}

export function isRegisteredAgent(agentId: string): boolean {
	const normalized = normalizeAgentId(agentId);
	if (!normalized) return false;
	return getRegisteredAgentIds().includes(normalized);
}

export function resolveAgentId(
	agentId: string | null | undefined,
	fallbackAgent: string = "assistant",
): string {
	const normalized = normalizeAgentId(agentId);
	if (normalized) {
		return normalized;
	}

	const fallback = normalizeAgentId(fallbackAgent);
	return fallback || "assistant";
}

const LEGACY_TO_NEW_NAMESPACE: Partial<
	Record<LegacyNamespace, MemoryNamespace>
> = {
	agent_decisions: "agent.assistant.decisions",
	user_profile: "shared.project_context",
	project_context: "shared.project_context",
	trading_signals: "agent.trader.decisions",
	agent_learnings: "agent.assistant.lessons",
	system_rules: "shared.rules_slotdb",
	default: "agent.assistant.working_memory",
};

export function isAgentNamespace(
	value: string | null | undefined,
): value is AgentNamespace {
	return typeof value === "string" && AGENT_NAMESPACE_RE.test(value.trim());
}

export function normalizeNamespace(
	value: string | null | undefined,
	fallbackAgent: string = "assistant",
): MemoryNamespace {
	const agent = resolveAgentId(fallbackAgent);
	if (!value) return `agent.${agent}.working_memory`;

	const trimmed = value.trim();
	if (
		trimmed === "shared.project_context" ||
		trimmed === "shared.rules_slotdb" ||
		trimmed === "shared.runbooks" ||
		trimmed === "noise.filtered" ||
		isAgentNamespace(trimmed)
	) {
		return trimmed as MemoryNamespace;
	}

	const directAgentAlias = resolveAgentId(trimmed);
	if (directAgentAlias && isRegisteredAgent(directAgentAlias)) {
		return `agent.${directAgentAlias}.working_memory`;
	}

	const mapped = LEGACY_TO_NEW_NAMESPACE[trimmed as LegacyNamespace];
	if (mapped) return mapped;

	return `agent.${agent}.working_memory`;
}

export function parseExplicitNamespace(
	value: string | null | undefined,
	fallbackAgent: string = "assistant",
): MemoryNamespace {
	if (!value || !value.trim()) {
		throw new Error("Namespace cannot be empty when provided explicitly");
	}

	const trimmed = value.trim();
	const agent = resolveAgentId(fallbackAgent);

	if (
		trimmed === "shared.project_context" ||
		trimmed === "shared.rules_slotdb" ||
		trimmed === "shared.runbooks" ||
		trimmed === "noise.filtered" ||
		isAgentNamespace(trimmed)
	) {
		return trimmed as MemoryNamespace;
	}

	const directAgentAlias = resolveAgentId(trimmed);
	if (directAgentAlias && isRegisteredAgent(directAgentAlias)) {
		return `agent.${directAgentAlias}.working_memory`;
	}

	const mapped = LEGACY_TO_NEW_NAMESPACE[trimmed as LegacyNamespace];
	if (mapped) return mapped;

	throw new Error(
		`Unknown namespace: ${trimmed}. Use a registered agent alias, canonical agent.<id>.(working_memory|lessons|decisions), or shared namespace.`,
	);
}

/**
 * Backward-compatible alias.
 * Historically this returned only a hardcoded core agent and defaulted unknowns to assistant.
 * New behavior keeps unknown/extra registry agents as themselves.
 */
export function toCoreAgent(agentId: string): string {
	return resolveAgentId(agentId);
}

/**
 * Revert coarse blocklist change:
 * keep all agents eligible for capture by default.
 */
export const DEFAULT_AGENT_BLOCKLIST = new Set<string>([]);

/**
 * Per-agent recall namespaces (noise.filtered is intentionally excluded)
 */
export function getAgentNamespaces(agentId: string): MemoryNamespace[] {
	const agent = resolveAgentId(agentId);
	return [
		`agent.${agent}.working_memory`,
		`agent.${agent}.lessons`,
		`agent.${agent}.decisions`,
		"shared.project_context",
		"shared.rules_slotdb",
		"shared.runbooks",
	];
}

export function getAutoCaptureNamespace(
	agentId: string,
	text?: string,
): MemoryNamespace {
	const agent = resolveAgentId(agentId);
	const content = String(text || "");

	if (isLearningContent(content)) return `agent.${agent}.lessons`;
	if (isDecisionContent(content)) return `agent.${agent}.decisions`;
	if (isRunbookContent(content)) return "shared.runbooks";
	if (isRuleContent(content)) return "shared.rules_slotdb";
	if (isProjectContextContent(content)) return "shared.project_context";
	return `agent.${agent}.working_memory`;
}

/** Recall priority weighting policy */
const SHARED_NAMESPACE_WEIGHT: Record<
	"shared.project_context" | "shared.rules_slotdb" | "shared.runbooks",
	number
> = {
	"shared.project_context": 1.08,
	"shared.rules_slotdb": 1.18,
	"shared.runbooks": 1.12,
};

export function getNamespaceWeight(agentId: string, namespace: string): number {
	const agent = resolveAgentId(agentId);
	if (namespace === `agent.${agent}.decisions`) return 1.25;
	if (namespace === `agent.${agent}.lessons`) return 1.2;
	if (namespace === `agent.${agent}.working_memory`) return 1.1;

	if (namespace in SHARED_NAMESPACE_WEIGHT) {
		return SHARED_NAMESPACE_WEIGHT[
			namespace as keyof typeof SHARED_NAMESPACE_WEIGHT
		];
	}

	if (namespace === "noise.filtered") return 0.01;
	return 1.0;
}

/** Noise policy v2 */
export const NOISE_PATTERNS_V2: RegExp[] = [
	/^\s*(ok|k|kk|yes|no|thanks?|tks|thx)\s*$/i,
	/^\s*(no_reply|heartbeat_ok)\s*$/i,
	/^\s*[.?]+\s*$/,
	/^\s*\/\w+/,
	/^\s*\[tool[:\]]/i,
	/^\s*\{\s*"type"\s*:\s*"toolCall"/i,
	/^\s*(ping|pong)\s*$/i,
];

const SOURCE_TYPE_NOISE_WEIGHT: Record<string, number> = {
	auto_capture: 0.15,
	tool_call: 0.2,
	manual: 0.02,
};

export function evaluateNoiseV2(
	text: string,
	sourceType: "auto_capture" | "manual" | "tool_call" = "auto_capture",
): {
	score: number;
	isNoise: boolean;
	matchedPatterns: string[];
} {
	const content = String(text || "").trim();
	const matchedPatterns = NOISE_PATTERNS_V2.filter((p) => p.test(content)).map(
		(p) => p.toString(),
	);

	const lengthPenalty =
		content.length < 8 ? 0.45 : content.length < 24 ? 0.15 : 0;
	const patternScore =
		matchedPatterns.length > 0
			? Math.min(0.8, matchedPatterns.length * 0.4)
			: 0;
	const sourceScore = SOURCE_TYPE_NOISE_WEIGHT[sourceType] ?? 0.1;

	const score = Math.min(
		1,
		Number((patternScore + sourceScore + lengthPenalty).toFixed(3)),
	);
	return {
		score,
		isNoise: score >= 0.62,
		matchedPatterns,
	};
}

export function isLearningContent(text: string): boolean {
	return /\b(learned|lesson|takeaway|kinh nghiệm|bài học|rút ra|postmortem|root cause)\b/i.test(
		text,
	);
}

export function isDecisionContent(text: string): boolean {
	return /\b(decision|approved|chốt|quyết định|ship|go with|reject|accept)\b/i.test(
		text,
	);
}

export function isProjectContextContent(text: string): boolean {
	return /\b(deploy|release|migration|rollback|staging|production|port|endpoint|schema|db|api key|config)\b/i.test(
		text,
	);
}

export function isRuleContent(text: string): boolean {
	return /\b(rule|policy|guardrail|must|never|always|slotdb|quy tắc|bắt buộc|không được)\b/i.test(
		text,
	);
}

export function isRunbookContent(text: string): boolean {
	return /\b(runbook|sop|playbook|incident response|checklist|triage|khắc phục|vận hành)\b/i.test(
		text,
	);
}

export function isBlockedAgent(agentId: string): boolean {
	return DEFAULT_AGENT_BLOCKLIST.has(agentId);
}

export function normalizeUserId(rawUserId: string): string {
	if (rawUserId === "__team__" || rawUserId === "__public__") {
		return rawUserId;
	}
	return "default";
}

export function resolveMemoryScopeFromNamespace(
	namespace: MemoryNamespace,
): MemoryScope {
	if (namespace.startsWith("agent.")) return "agent";
	if (namespace === "shared.project_context") return "project";
	if (namespace === "noise.filtered") return "session";
	return "shared";
}

export function resolveMemoryTypeFromNamespace(
	namespace: MemoryNamespace,
): MemoryType {
	if (namespace.endsWith(".lessons")) return "lesson";
	if (namespace.endsWith(".decisions")) return "decision";
	if (namespace === "shared.rules_slotdb") return "rule";
	if (namespace === "shared.runbooks") return "runbook";
	if (namespace === "shared.project_context") return "task_context";
	if (namespace === "noise.filtered") return "noise";
	return "episodic_trace";
}

export function resolveDefaultConfidence(sourceType: MemorySourceType): number {
	switch (sourceType) {
		case "manual":
			return 0.9;
		case "tool_call":
			return 0.85;
		case "migration":
			return 0.75;
		case "promotion":
			return 0.95;
		case "auto_capture":
		default:
			return 0.7;
	}
}

export const SLOT_TTL_DAYS: Record<string, number> = {
	project: 7,
	environment: 3,
	custom: 14,
	profile: 90,
	preferences: 90,
};

export function getSlotTTL(category: string): number {
	return SLOT_TTL_DAYS[category] ?? 30;
}

export class NoiseFilter {
	private agentId: string;
	constructor(agentId: string) {
		this.agentId = agentId;
	}

	isBlocked(): boolean {
		return isBlockedAgent(this.agentId);
	}

	shouldSkip(text: string): boolean {
		return evaluateNoiseV2(text, "auto_capture").isNoise;
	}

	classify(
		text: string,
		sourceType: "auto_capture" | "manual" | "tool_call" = "auto_capture",
	) {
		return evaluateNoiseV2(text, sourceType);
	}

	getTargetNamespace(text?: string): MemoryNamespace {
		return getAutoCaptureNamespace(this.agentId, text);
	}
}

export const CORE_AGENTS = DEFAULT_CORE_AGENTS;
export const DEFAULT_AGENT_SET = STATIC_FALLBACK_AGENT_SET;
