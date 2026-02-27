/**
 * Shared Memory Configuration
 * Single source of truth for namespace routing and agent mapping
 */

/** Valid namespace types for memory organization */
export type MemoryNamespace =
  | "agent_decisions"
  | "user_profile"
  | "project_context"
  | "trading_signals";

/**
 * Maps agent IDs to their allowed namespaces.
 * First namespace is the default storage target for auto-capture.
 * All listed namespaces are searchable by auto-recall.
 */
export const AGENT_NAMESPACE_MAP: Record<string, MemoryNamespace[]> = {
  assistant: ["agent_decisions", "user_profile"],
  scrum: ["agent_decisions", "project_context"],
  fullstack: ["agent_decisions", "project_context"],
  creator: ["agent_decisions", "project_context"],
  trader: ["trading_signals", "agent_decisions"],
};

/** Default namespaces for agents not in the map */
export const DEFAULT_NAMESPACES: MemoryNamespace[] = ["agent_decisions"];

/** Agents that should be completely blocked from auto-capture (empty - no agents blocked by default) */
export const DEFAULT_AGENT_BLOCKLIST = new Set<string>([
  // "trader" is NOT in this list - trader is allowed for auto-capture
  // Add agent IDs here if they should never be auto-captured
]);

/** General noise patterns - applied to all agents */
export const NOISE_PATTERNS: RegExp[] = [
  /^\s*ok\s*$/i,
  /^\s*yes\s*$/i,
  /^\s*no\s*$/i,
  /^\s*thanks?\s*$/i,
  /^\s*\.\s*$/,
  /^\s*\?\s*$/,
  /^\/\w+/, // command-like messages
];

/** Trading-specific noise patterns - used to skip auto-capture for trading content */
export const TRADING_NOISE_PATTERNS: RegExp[] = [
  /\b(buy|sell|long|short|entry|exit|stop.?loss|take.?profit)\b/i,
  /\b(BTC|ETH|SOL|DOGE|XRP|USDT|BNB|ADA|DOT|AVAX|LINK|UNI|AAVE|COMP|SUSHI|CRV)\b/,
  /\b\d+(\.\d+)?%\b/, // percentage
  /\b(signal|position|leverage|liquidation|margin|futures|perp)\b/i,
  /\b(candle|support|resistance|breakout|pullback|rsi|macd|ema|sma|bollinger)\b/i,
  /\b(breakout|consolidation|accumulation|distribution)\b/i,
  /\b(tp|sl)\s*\d+/i, // TP/SL with numbers
  /\b@\s*\d+[\d,.]*/i, // @ price format
];

/**
 * Get namespaces for an agent.
 * Returns mapped namespaces or DEFAULT_NAMESPACES if agent not in map.
 */
export function getAgentNamespaces(agentId: string): MemoryNamespace[] {
  return AGENT_NAMESPACE_MAP[agentId] || DEFAULT_NAMESPACES;
}

/**
 * Get the default storage namespace for auto-capture.
 * For trader: always "agent_decisions" (trading data goes through memory_store)
 * For others: first namespace in their map
 */
export function getAutoCaptureNamespace(agentId: string): MemoryNamespace {
  if (agentId === "trader") {
    return "agent_decisions"; // Trading data goes through memory_store manually
  }
  const namespaces = getAgentNamespaces(agentId);
  return namespaces[0] || "agent_decisions";
}

/**
 * Check if an agent is the trader agent.
 * Used by noise filter to apply trading-specific rules.
 */
export function isTraderAgent(agentId: string): boolean {
  return agentId === "trader";
}

/**
 * Check if content matches any trading noise patterns
 */
export function isTradingContent(text: string): boolean {
  return TRADING_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Check if content matches general noise patterns
 */
export function isNoiseContent(text: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Check if agent is in the blocklist
 */
export function isBlockedAgent(agentId: string): boolean {
  return DEFAULT_AGENT_BLOCKLIST.has(agentId);
}

/**
 * Normalize scope_user_id to prevent fragmentation.
 * Maps all session-based IDs (hook:*, cron:*, subagent:*) to 'default'.
 * Preserves __team__ and __public__ scopes.
 * 
 * ROOT CAUSE FIX: Each session generates a unique scope_user_id like
 * "hook:e0758a07-..." or "cron:5668fdad-...", causing massive duplication.
 * Since this is a single-user system, we normalize everything to 'default'.
 */
export function normalizeUserId(rawUserId: string): string {
  // Preserve special scopes
  if (rawUserId === '__team__' || rawUserId === '__public__') {
    return rawUserId;
  }
  // Always normalize to 'default' for single-user system
  return 'default';
}

/** Slot TTL configuration by category (in days) */
export const SLOT_TTL_DAYS: Record<string, number> = {
  project: 7,        // Project/task slots: 7 days
  environment: 3,    // Environment slots: 3 days  
  custom: 14,        // Custom slots: 14 days
  profile: 90,       // Profile slots: 90 days
  preferences: 90,   // Preferences: 90 days
};

/** Get TTL in days for a slot category */
export function getSlotTTL(category: string): number {
  return SLOT_TTL_DAYS[category] ?? 30; // default 30 days
}

/**
 * NoiseFilter class for auto-capture
 * Determines whether content should be captured or skipped
 */
export class NoiseFilter {
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * Check if this agent should be completely blocked from auto-capture
   */
  isBlocked(): boolean {
    return isBlockedAgent(this.agentId);
  }

  /**
   * Check if content should be skipped for this agent
   * - General noise patterns apply to all agents
   * - Trading noise patterns only apply to trader agent (to skip auto-capture of trading data)
   */
  shouldSkip(text: string): boolean {
    // Check general noise patterns
    if (isNoiseContent(text)) {
      return true;
    }

    // For trader agent, skip trading content (trader should use memory_store manually)
    if (isTraderAgent(this.agentId) && isTradingContent(text)) {
      return true;
    }

    return false;
  }

  /**
   * Get the target namespace for auto-capture for this agent
   */
  getTargetNamespace(): MemoryNamespace {
    return getAutoCaptureNamespace(this.agentId);
  }
}
