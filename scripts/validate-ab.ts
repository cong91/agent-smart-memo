/**
 * ASM-5 Validation A/B
 *
 * A (baseline): raw similarity score, no noise exclusion, no namespace weighting.
 * B (new): exclude noise.filtered + namespace weighting.
 *
 * Metrics:
 * - precision@k (heuristic relevance)
 * - noise ratio in top-k
 * - top-k relevance examples
 *
 * Usage:
 *   npx tsx scripts/validate-ab.ts
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION || "mrc_bot";
const K = Number(process.env.K || 5);

type QueryCase = { query: string; intents: string[]; agent: string };

const CASES: QueryCase[] = [
  { query: "quy tắc staging port 4000 4001", intents: ["shared.rules_slotdb", "shared.project_context"], agent: "fullstack" },
  { query: "bài học root cause và fix", intents: ["lessons", "decisions"], agent: "assistant" },
  { query: "runbook incident rollback", intents: ["shared.runbooks", "shared.rules_slotdb"], agent: "scrum" },
  { query: "trader quyết định risk cap leverage", intents: ["agent.trader.decisions", "shared.rules_slotdb"], agent: "trader" },
];

function nsWeight(agent: string, namespace: string): number {
  if (namespace === `agent.${agent}.decisions`) return 1.25;
  if (namespace === `agent.${agent}.lessons`) return 1.2;
  if (namespace === `agent.${agent}.working_memory`) return 1.1;
  if (namespace === "shared.rules_slotdb") return 1.18;
  if (namespace === "shared.runbooks") return 1.12;
  if (namespace === "shared.project_context") return 1.08;
  if (namespace === "noise.filtered") return 0.01;
  return 1;
}

function isRelevant(payload: any, test: QueryCase): boolean {
  const ns = String(payload?.namespace || "");
  const text = String(payload?.text || "").toLowerCase();

  const nsHit = test.intents.some((i) => ns.includes(i));
  const kw = test.query.toLowerCase().split(/\s+/).filter((x) => x.length > 2);
  const textHit = kw.filter((w) => text.includes(w)).length >= 2;
  return nsHit || textHit;
}

async function qdrant(path: string, method: string, body?: any) {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function embed(query: string): Promise<number[]> {
  // OpenAI-compatible proxy embedding service expected in environment
  const base = process.env.EMBEDDING_API_URL || "http://localhost:11434";
  const model = process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b";

  const v1 = `${base.replace(/\/+$/, "")}/v1/embeddings`;
  const api = `${base.replace(/\/+$/, "")}/api/embeddings`;

  const tryV1 = await fetch(v1, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: [query] }),
  });
  if (tryV1.ok) {
    const json = await tryV1.json();
    const vec = json?.data?.[0]?.embedding;
    if (Array.isArray(vec)) return vec;
  }

  const tryApi = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: query }),
  });
  if (!tryApi.ok) throw new Error(`embed failed: ${tryApi.status} ${await tryApi.text()}`);
  const j2 = await tryApi.json();
  if (!Array.isArray(j2?.embedding)) throw new Error("invalid embedding response");
  return j2.embedding;
}

async function getCollectionVectorSize(): Promise<number> {
  const info = await qdrant(`/collections/${COLLECTION}`, "GET");
  const vectors = info?.result?.config?.params?.vectors;
  if (typeof vectors?.size === "number") return vectors.size;
  if (vectors && typeof vectors === "object") {
    const first: any = Object.values(vectors)[0];
    if (typeof first?.size === "number") return first.size;
  }
  return 1024;
}

function alignVectorDim(vector: number[], expected: number): number[] {
  if (vector.length === expected) return vector;
  if (vector.length > expected) return vector.slice(0, expected);
  const out = vector.slice();
  while (out.length < expected) out.push(0);
  return out;
}

async function runCase(c: QueryCase, expectedDim: number) {
  const rawVector = await embed(c.query);
  const vector = alignVectorDim(rawVector, expectedDim);
  const result = await qdrant(`/collections/${COLLECTION}/points/search`, "POST", {
    vector,
    limit: 20,
    with_payload: true,
    with_vector: false,
  });

  const rows = (result?.result || []) as any[];
  const A = rows.slice(0, K);
  const B = rows
    .filter((r) => String(r.payload?.namespace || "") !== "noise.filtered")
    .map((r) => {
      const ns = String(r.payload?.namespace || "");
      const weighted = Math.min(1, Number(r.score || 0) * nsWeight(c.agent, ns));
      return { ...r, score: weighted };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, K);

  const pA = A.filter((r) => isRelevant(r.payload, c)).length / Math.max(1, A.length);
  const pB = B.filter((r) => isRelevant(r.payload, c)).length / Math.max(1, B.length);

  const nA = A.filter((r) => String(r.payload?.namespace || "") === "noise.filtered").length / Math.max(1, A.length);
  const nB = B.filter((r) => String(r.payload?.namespace || "") === "noise.filtered").length / Math.max(1, B.length);

  return {
    query: c.query,
    precisionAtK_A: Number(pA.toFixed(3)),
    precisionAtK_B: Number(pB.toFixed(3)),
    noiseRatio_A: Number(nA.toFixed(3)),
    noiseRatio_B: Number(nB.toFixed(3)),
    topK_A: A.map((r) => ({ ns: r.payload?.namespace, score: Number(r.score?.toFixed?.(3) || r.score), text: String(r.payload?.text || "").slice(0, 120) })),
    topK_B: B.map((r) => ({ ns: r.payload?.namespace, score: Number(r.score?.toFixed?.(3) || r.score), text: String(r.payload?.text || "").slice(0, 120) })),
  };
}

async function main() {
  const expectedDim = await getCollectionVectorSize();

  const cases = [] as any[];
  for (const c of CASES) {
    try {
      cases.push(await runCase(c, expectedDim));
    } catch (e: any) {
      cases.push({ query: c.query, error: e.message });
    }
  }

  const valid = cases.filter((c) => c.precisionAtK_A !== undefined);
  const avg = (arr: number[]) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)) : 0);

  const out = {
    generatedAt: new Date().toISOString(),
    collection: COLLECTION,
    vectorDim: expectedDim,
    k: K,
    summary: {
      avgPrecisionAtK_A: avg(valid.map((c) => c.precisionAtK_A)),
      avgPrecisionAtK_B: avg(valid.map((c) => c.precisionAtK_B)),
      avgNoiseRatio_A: avg(valid.map((c) => c.noiseRatio_A)),
      avgNoiseRatio_B: avg(valid.map((c) => c.noiseRatio_B)),
    },
    cases,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[validate-ab] failed", e);
  process.exit(1);
});
