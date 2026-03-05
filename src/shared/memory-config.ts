/**
 * Shared Memory Configuration
 * Source of truth for namespace routing, noise policy v2, and recall weighting
 */

export const CORE_AGENTS = ["assistant", "scrum", "fullstack", "trader", "creator"] as const;
export type CoreAgent = (typeof CORE_AGENTS)[number];

/** New normalized namespace model (ASM-5) */
export type MemoryNamespace =
  | `agent.${CoreAgent}.working_memory`
  | `agent.${CoreAgent}.lessons`
  | `agent.${CoreAgent}.decisions`
  | "shared.project_context"
  | "shared.rules_slotdb"
  | "shared.runbooks"
  | "noise.filtered";

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

const LEGACY_TO_NEW_NAMESPACE: Partial<Record<LegacyNamespace, MemoryNamespace>> = {
  agent_decisions: "agent.assistant.decisions",
  user_profile: "shared.project_context",
  project_context: "shared.project_context",
  trading_signals: "agent.trader.decisions",
  agent_learnings: "agent.assistant.lessons",
  system_rules: "shared.rules_slotdb",
  default: "agent.assistant.working_memory",
};

export function normalizeNamespace(value: string | null | undefined, fallbackAgent: string = "assistant"): MemoryNamespace {
  const agent = toCoreAgent(fallbackAgent);
  if (!value) return `agent.${agent}.working_memory`;

  if ((value as MemoryNamespace) === "shared.project_context"
    || (value as MemoryNamespace) === "shared.rules_slotdb"
    || (value as MemoryNamespace) === "shared.runbooks"
    || (value as MemoryNamespace) === "noise.filtered"
    || /^agent\.(assistant|scrum|fullstack|trader|creator)\.(working_memory|lessons|decisions)$/.test(value)
  ) {
    return value as MemoryNamespace;
  }

  const mapped = LEGACY_TO_NEW_NAMESPACE[value as LegacyNamespace];
  if (mapped) return mapped;

  return `agent.${agent}.working_memory`;
}

export function toCoreAgent(agentId: string): CoreAgent {
  const normalized = (agentId || "").toLowerCase();
  if ((CORE_AGENTS as readonly string[]).includes(normalized)) {
    return normalized as CoreAgent;
  }
  return "assistant";
}

/**
 * Revert coarse blocklist change:
 * keep all 5 core agents eligible for capture by default.
 */
export const DEFAULT_AGENT_BLOCKLIST = new Set<string>([]);

/**
 * Per-agent recall namespaces (noise.filtered is intentionally excluded)
 */
export function getAgentNamespaces(agentId: string): MemoryNamespace[] {
  const agent = toCoreAgent(agentId);
  return [
    `agent.${agent}.working_memory`,
    `agent.${agent}.lessons`,
    `agent.${agent}.decisions`,
    "shared.project_context",
    "shared.rules_slotdb",
    "shared.runbooks",
  ];
}

export function getAutoCaptureNamespace(agentId: string, text?: string): MemoryNamespace {
  const agent = toCoreAgent(agentId);
  const content = String(text || "");

  if (isLearningContent(content)) return `agent.${agent}.lessons`;
  if (isDecisionContent(content)) return `agent.${agent}.decisions`;
  if (isRunbookContent(content)) return "shared.runbooks";
  if (isRuleContent(content)) return "shared.rules_slotdb";
  if (isProjectContextContent(content)) return "shared.project_context";
  return `agent.${agent}.working_memory`;
}

/** Recall priority weighting policy */
const SHARED_NAMESPACE_WEIGHT: Record<"shared.project_context" | "shared.rules_slotdb" | "shared.runbooks", number> = {
  "shared.project_context": 1.08,
  "shared.rules_slotdb": 1.18,
  "shared.runbooks": 1.12,
};

export function getNamespaceWeight(agentId: string, namespace: string): number {
  const agent = toCoreAgent(agentId);
  if (namespace === `agent.${agent}.decisions`) return 1.25;
  if (namespace === `agent.${agent}.lessons`) return 1.2;
  if (namespace === `agent.${agent}.working_memory`) return 1.1;

  if (namespace in SHARED_NAMESPACE_WEIGHT) {
    return SHARED_NAMESPACE_WEIGHT[namespace as keyof typeof SHARED_NAMESPACE_WEIGHT];
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

export function evaluateNoiseV2(text: string, sourceType: "auto_capture" | "manual" | "tool_call" = "auto_capture"): {
  score: number;
  isNoise: boolean;
  matchedPatterns: string[];
} {
  const content = String(text || "").trim();
  const matchedPatterns = NOISE_PATTERNS_V2.filter((p) => p.test(content)).map((p) => p.toString());

  const lengthPenalty = content.length < 8 ? 0.45 : content.length < 24 ? 0.15 : 0;
  const patternScore = matchedPatterns.length > 0 ? Math.min(0.8, matchedPatterns.length * 0.4) : 0;
  const sourceScore = SOURCE_TYPE_NOISE_WEIGHT[sourceType] ?? 0.1;

  const score = Math.min(1, Number((patternScore + sourceScore + lengthPenalty).toFixed(3)));
  return {
    score,
    isNoise: score >= 0.62,
    matchedPatterns,
  };
}

export function isLearningContent(text: string): boolean {
  return /\b(learned|lesson|takeaway|kinh nghiệm|bài học|rút ra|postmortem|root cause)\b/i.test(text);
}

export function isDecisionContent(text: string): boolean {
  return /\b(decision|approved|chốt|quyết định|ship|go with|reject|accept)\b/i.test(text);
}

export function isProjectContextContent(text: string): boolean {
  return /\b(deploy|release|migration|rollback|staging|production|port|endpoint|schema|db|api key|config)\b/i.test(text);
}

export function isRuleContent(text: string): boolean {
  return /\b(rule|policy|guardrail|must|never|always|slotdb|quy tắc|bắt buộc|không được)\b/i.test(text);
}

export function isRunbookContent(text: string): boolean {
  return /\b(runbook|sop|playbook|incident response|checklist|triage|khắc phục|vận hành)\b/i.test(text);
}

export function isBlockedAgent(agentId: string): boolean {
  return DEFAULT_AGENT_BLOCKLIST.has(agentId);
}

export function normalizeUserId(rawUserId: string): string {
  if (rawUserId === '__team__' || rawUserId === '__public__') {
    return rawUserId;
  }
  return 'default';
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

  classify(text: string, sourceType: "auto_capture" | "manual" | "tool_call" = "auto_capture") {
    return evaluateNoiseV2(text, sourceType);
  }

  getTargetNamespace(text?: string): MemoryNamespace {
    return getAutoCaptureNamespace(this.agentId, text);
  }
}
