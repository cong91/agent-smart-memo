import { createMemoryStoreTool } from "../src/tools/memory_store.js";
import { createMemorySearchTool } from "../src/tools/memory_search.js";
import { DeduplicationService } from "../src/services/dedupe.js";
import type { Point, ScoredPoint } from "../src/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
}

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✅ ${name}`))
    .catch((err) => {
      console.error(`❌ ${name}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

class MockEmbedding {
  async embed(text: string): Promise<number[]> {
    const seed = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return [seed % 101, seed % 97, seed % 89, seed % 83].map((n) => Number((n / 100).toFixed(3)));
  }

  async embedDetailed(text: string): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
    return {
      vector: await this.embed(text),
      metadata: {
        embedding_chunked: false,
        embedding_chunks_count: 1,
        embedding_chunking_strategy: "array_batch_weighted_avg",
        embedding_model: "mock",
        embedding_model_key: "mock::v1",
        embedding_provider: "mock",
        embedding_max_tokens: 0,
        embedding_safe_chunk_tokens: 0,
        embedding_source: "tests",
        embedding_fallback_hash: false,
      },
    };
  }
}

class MockQdrant {
  public points: Point[] = [];
  public lastSearchFilter: Record<string, any> | undefined;

  async upsert(points: Point[]): Promise<void> {
    for (const point of points) {
      const idx = this.points.findIndex((p) => p.id === point.id);
      if (idx >= 0) this.points[idx] = point;
      else this.points.push(point);
    }
  }

  async search(_vector: number[], limit = 5, filter?: Record<string, any>): Promise<ScoredPoint[]> {
    this.lastSearchFilter = filter;
    const matched = this.points.filter((p) => this.matchesFilter(p.payload, filter));
    return matched.slice(0, limit).map((p) => ({
      id: p.id,
      score: 0.95,
      payload: p.payload,
    }));
  }

  private matchesFilter(payload: Record<string, any>, filter?: Record<string, any>): boolean {
    if (!filter?.must || !Array.isArray(filter.must)) return true;

    return filter.must.every((condition: any) => {
      if (condition.should && Array.isArray(condition.should)) {
        return condition.should.some((c: any) => this.matchLeaf(payload, c));
      }
      return this.matchLeaf(payload, condition);
    });
  }

  private matchLeaf(payload: Record<string, any>, condition: any): boolean {
    const key = condition?.key;
    const value = condition?.match?.value;
    if (!key) return true;
    return payload?.[key] === value;
  }
}

async function main() {
  const qdrant = new MockQdrant();
  const embedding = new MockEmbedding();
  const dedupe = new DeduplicationService(0.95, console);

  const memoryStore = createMemoryStoreTool(qdrant as any, embedding as any, dedupe, "shared.project_context");
  const memorySearch = createMemorySearchTool(qdrant as any, embedding as any, "shared.project_context");

  await test("store normalizes alias namespace 'assistant' -> canonical", async () => {
    const res = await memoryStore.execute("t1", {
      text: "ASM namespace alias assistant roundtrip",
      namespace: "assistant" as any,
      agentId: "assistant",
    });

    assert(res.isError !== true, "memory_store should succeed");
    assert(qdrant.points.length >= 1, "point must be stored");
    const saved = qdrant.points[qdrant.points.length - 1];
    assertEqual(saved.payload.namespace, "agent.assistant.working_memory", "alias assistant must map to canonical namespace");

    const details = (res as any).details;
    assert(details?.toolResult?.text, "memory_store details.toolResult.text must exist");
  });

  await test("search from scrum session honors explicit assistant alias instead of fallback agent", async () => {
    const res = await memorySearch.execute("t1b", {
      query: "namespace alias assistant from scrum",
      namespace: "assistant" as any,
      agentId: "scrum",
      minScore: 0.1,
    });

    assert(res.isError !== true, "memory_search should succeed from scrum context");

    const must = (qdrant.lastSearchFilter as any)?.must || [];
    const nsCondition = must.find((m: any) => m?.key === "namespace");
    assertEqual(
      nsCondition?.match?.value,
      "agent.assistant.working_memory",
      "explicit assistant alias must stay assistant even when fallback agent is scrum"
    );
  });

  await test("search normalizes alias namespace 'assistant' -> canonical filter", async () => {
    const res = await memorySearch.execute("t2", {
      query: "namespace alias assistant",
      namespace: "assistant" as any,
      agentId: "assistant",
      minScore: 0.1,
    });

    assert(res.isError !== true, "memory_search should succeed");

    const must = (qdrant.lastSearchFilter as any)?.must || [];
    const nsCondition = must.find((m: any) => m?.key === "namespace");
    assertEqual(nsCondition?.match?.value, "agent.assistant.working_memory", "search namespace filter must be canonical");

    const text = res.content?.[0]?.text || "";
    assert(String(text).includes("Found"), "search should return found message");

    const details = (res as any).details;
    assert(details?.toolResult?.text, "memory_search details.toolResult.text must exist");
  });

  await test("canonical namespace query still works", async () => {
    const res = await memorySearch.execute("t3", {
      query: "assistant roundtrip",
      namespace: "agent.assistant.working_memory",
      agentId: "assistant",
      minScore: 0.1,
    });

    assert(res.isError !== true, "canonical namespace search should succeed");
    assert(String(res.content?.[0]?.text || "").includes("Found"), "canonical search should find memory");
  });

  await test("legacy/shared namespace project_context maps to shared.project_context (store->search roundtrip)", async () => {
    const text = "ASM legacy namespace project context roundtrip";

    const storeRes = await memoryStore.execute("t4", {
      text,
      namespace: "project_context" as any,
      agentId: "assistant",
    });
    assert(storeRes.isError !== true, "legacy namespace store should succeed");

    const saved = qdrant.points[qdrant.points.length - 1];
    assertEqual(saved.payload.namespace, "shared.project_context", "project_context must normalize to shared.project_context");

    const searchRes = await memorySearch.execute("t5", {
      query: "legacy namespace project context",
      namespace: "project_context" as any,
      agentId: "assistant",
      minScore: 0.1,
    });

    assert(searchRes.isError !== true, "legacy namespace search should succeed");
    const must = (qdrant.lastSearchFilter as any)?.must || [];
    const nsCondition = must.find((m: any) => m?.key === "namespace");
    assertEqual(nsCondition?.match?.value, "shared.project_context", "legacy namespace search filter must map to shared.project_context");
    assert(String(searchRes.content?.[0]?.text || "").includes("Found"), "legacy namespace roundtrip should find memory");
  });

  await test("unknown explicit namespace returns clear validation error instead of silent fallback", async () => {
    const searchRes = await memorySearch.execute("t6", {
      query: "unknown namespace",
      namespace: "totally_unknown_namespace" as any,
      agentId: "assistant",
      minScore: 0.1,
    });
    assert(searchRes.isError === true, "unknown explicit namespace search must fail clearly");
    assert(
      String(searchRes.content?.[0]?.text || "").includes("Unknown namespace"),
      "search error should mention unknown namespace"
    );

    const storeRes = await memoryStore.execute("t7", {
      text: "should not store",
      namespace: "totally_unknown_namespace" as any,
      agentId: "assistant",
    });
    assert(storeRes.isError === true, "unknown explicit namespace store must fail clearly");
    assert(
      String(storeRes.content?.[0]?.text || "").includes("Unknown namespace"),
      "store error should mention unknown namespace"
    );
  });

  if (!process.exitCode) {
    console.log("\n🎉 memory tools namespace roundtrip tests passed");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
