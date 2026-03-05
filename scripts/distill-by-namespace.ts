/**
 * ASM-5 Distiller (namespace-aware)
 *
 * Operates on single active collection mrc_bot.
 * - Reads points grouped by namespace
 * - Excludes noise.filtered
 * - Produces distilled snapshot report by namespace
 *
 * Usage:
 *   npx tsx scripts/distill-by-namespace.ts
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION || "mrc_bot";
const LIMIT = Number(process.env.DISTILL_LIMIT || 3000);

interface Point {
  id: string | number;
  payload?: Record<string, any>;
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

function distillText(text: string): string {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\b(in conclusion|overall|therefore|moreover|xin chào|cảm ơn)\b/gi, "")
    .trim();
  return t.length > 220 ? `${t.slice(0, 220)}...` : t;
}

async function main() {
  let offset: any = null;
  const points: Point[] = [];

  while (points.length < LIMIT) {
    const scroll = await qdrant(`/collections/${COLLECTION}/points/scroll`, "POST", {
      limit: 200,
      with_payload: true,
      with_vector: false,
      ...(offset != null ? { offset } : {}),
    });

    const batch = (scroll?.result?.points || []) as Point[];
    if (!batch.length) break;
    points.push(...batch);

    offset = scroll?.result?.next_page_offset;
    if (offset == null) break;
  }

  const byNamespace = new Map<string, Array<{ id: string | number; text: string; agent: string; ts: number }>>();

  for (const p of points) {
    const payload = p.payload || {};
    const ns = String(payload.namespace || "");
    if (!ns || ns === "noise.filtered") continue;

    const text = String(payload.text || "").trim();
    if (!text) continue;

    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns)!.push({
      id: p.id,
      text,
      agent: String(payload.agent || payload.source_agent || "assistant"),
      ts: Number(payload.timestamp || 0),
    });
  }

  const report = Array.from(byNamespace.entries())
    .map(([namespace, rows]) => {
      const sorted = rows.sort((a, b) => b.ts - a.ts).slice(0, 12);
      const distilled = sorted.map((r) => distillText(r.text));
      return {
        namespace,
        count: rows.length,
        distilled_examples: distilled.slice(0, 5),
      };
    })
    .sort((a, b) => b.count - a.count);

  const out = {
    generatedAt: new Date().toISOString(),
    collection: COLLECTION,
    namespaces: report,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[distill-by-namespace] failed", e);
  process.exit(1);
});
