/**
 * ASM-5 Migration: normalize mrc_bot payloads to namespace/metadata schema v2
 *
 * - collection: mrc_bot (only active collection)
 * - required payload fields: agent, namespace, source_type, timestamp
 * - namespace normalization policy
 * - noise quarantine: noisy points -> noise.filtered
 *
 * Usage:
 *   npx tsx scripts/migrate-namespaces.ts
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "mrc_bot";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);

type SourceType = "auto_capture" | "manual" | "tool_call";

type Agent = "assistant" | "scrum" | "fullstack" | "trader" | "creator";

const NOISE_PATTERNS: RegExp[] = [
  /^\s*(ok|k|kk|yes|no|thanks?|tks|thx)\s*$/i,
  /^\s*(no_reply|heartbeat_ok)\s*$/i,
  /^\s*[.?]+\s*$/,
  /^\s*\/\w+/,
  /^\s*\[tool[:\]]/i,
  /^\s*\{\s*"type"\s*:\s*"toolCall"/i,
];

function toAgent(value: unknown): Agent {
  const v = String(value || "assistant").toLowerCase();
  if (["assistant", "scrum", "fullstack", "trader", "creator"].includes(v)) return v as Agent;
  return "assistant";
}

function normalizeNamespace(current: unknown, agent: Agent): string {
  const ns = String(current || "").trim();

  if (/^agent\.(assistant|scrum|fullstack|trader|creator)\.(working_memory|lessons|decisions)$/.test(ns)) return ns;
  if (["shared.project_context", "shared.rules_slotdb", "shared.runbooks", "noise.filtered"].includes(ns)) return ns;

  switch (ns) {
    case "agent_decisions":
      return `agent.${agent}.decisions`;
    case "agent_learnings":
      return `agent.${agent}.lessons`;
    case "trading_signals":
      return "agent.trader.decisions";
    case "project_context":
    case "user_profile":
      return "shared.project_context";
    case "system_rules":
      return "shared.rules_slotdb";
    case "session_summaries":
      return "shared.runbooks";
    case "default":
    case "":
      return `agent.${agent}.working_memory`;
    default:
      return `agent.${agent}.working_memory`;
  }
}

function normalizeSourceType(value: unknown): SourceType {
  const v = String(value || "auto_capture").toLowerCase();
  if (v === "manual" || v === "tool_call" || v === "auto_capture") return v;
  return "auto_capture";
}

function toTimestamp(value: unknown): number {
  const n = Number(value || 0);
  if (Number.isFinite(n) && n > 0) return n;
  return Date.now();
}

function noiseScore(text: string, sourceType: SourceType): number {
  const content = String(text || "").trim();
  const patternHits = NOISE_PATTERNS.filter((p) => p.test(content)).length;
  const patternScore = Math.min(0.8, patternHits * 0.4);
  const lengthPenalty = content.length < 8 ? 0.45 : content.length < 24 ? 0.15 : 0;
  const sourceBonus = sourceType === "manual" ? 0.02 : sourceType === "tool_call" ? 0.2 : 0.15;
  return Math.min(1, Number((patternScore + lengthPenalty + sourceBonus).toFixed(3)));
}

interface QdrantPoint {
  id: string | number;
  payload: Record<string, any>;
  vector?: number[];
}

async function qdrant(path: string, method: string, body?: any): Promise<any> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`[ASM-5] migrate namespaces on collection=${COLLECTION_NAME}`);

  let offset: string | number | null = null;
  let processed = 0;
  let changed = 0;
  let quarantined = 0;

  do {
    const scroll = await qdrant(`/collections/${COLLECTION_NAME}/points/scroll`, "POST", {
      limit: BATCH_SIZE,
      with_payload: true,
      with_vector: true,
      ...(offset !== null ? { offset } : {}),
    });

    const points: QdrantPoint[] = scroll?.result?.points || [];
    if (points.length === 0) break;

    const updates: QdrantPoint[] = [];

    for (const point of points) {
      processed += 1;
      const payload = point.payload || {};

      const agent = toAgent(payload.agent || payload.source_agent);
      const source_type = normalizeSourceType(payload.source_type);
      let namespace = normalizeNamespace(payload.namespace, agent);
      const timestamp = toTimestamp(payload.timestamp);
      const text = String(payload.text || "");

      const nScore = noiseScore(text, source_type);
      if (nScore >= 0.62) {
        namespace = "noise.filtered";
        quarantined += 1;
      }

      const nextPayload = {
        ...payload,
        agent,
        source_agent: agent,
        source_type,
        namespace,
        timestamp,
        noise_score: nScore,
        migrated_by: "asm5_namespace_router",
        migrated_at: Date.now(),
      };

      const changedNow =
        payload.agent !== nextPayload.agent ||
        payload.source_agent !== nextPayload.source_agent ||
        payload.source_type !== nextPayload.source_type ||
        payload.namespace !== nextPayload.namespace ||
        payload.timestamp !== nextPayload.timestamp ||
        payload.noise_score !== nextPayload.noise_score;

      if (changedNow) {
        updates.push({ id: point.id, vector: point.vector, payload: nextPayload });
        changed += 1;
      }
    }

    if (updates.length > 0) {
      await qdrant(`/collections/${COLLECTION_NAME}/points?wait=true`, "PUT", {
        points: updates.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
      console.log(`[ASM-5] updated batch=${updates.length}, processed=${processed}, changed=${changed}`);
    }

    offset = scroll?.result?.next_page_offset ?? null;
  } while (offset !== null);

  console.log(`[ASM-5] done processed=${processed} changed=${changed} quarantined=${quarantined}`);
}

main().catch((e) => {
  console.error("[ASM-5] migration failed", e);
  process.exit(1);
});
