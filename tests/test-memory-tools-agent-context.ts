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

async function run() {
  const qdrant = new MockQdrant();
  const embedding = new MockEmbedding();
  const dedupe = new DeduplicationService(0.95, console);

  const memoryStore = createMemoryStoreTool(qdrant as any, embedding as any, dedupe, "shared.project_context");
  const memorySearch = createMemorySearchTool(qdrant as any, embedding as any, "shared.project_context");

  const agents = ["assistant", "scrum", "fullstack"] as const;

  for (const agent of agents) {
    const sessionId = `agent:${agent}:runtime-test`;

    const storeRes = await memoryStore.execute(`store-${agent}`, {
      text: `runtime-agent-context-${agent}`,
      sessionId,
      // intentionally omit agentId to verify fallback from session identity
    } as any);

    assert(storeRes.isError !== true, `memory_store must succeed for ${agent}`);

    const saved = qdrant.points[qdrant.points.length - 1];
    assertEqual(
      saved.payload.namespace,
      `agent.${agent}.working_memory`,
      `store must route to ${agent} namespace when only sessionId is present`
    );
    assertEqual(saved.payload.agent, agent, `payload.agent must be ${agent}`);

    const searchRes = await memorySearch.execute(`search-${agent}`, {
      query: `runtime-agent-context-${agent}`,
      sessionId,
      minScore: 0.1,
      // intentionally omit agentId
    } as any);

    assert(searchRes.isError !== true, `memory_search must succeed for ${agent}`);

    const must = (qdrant.lastSearchFilter as any)?.must || [];
    const nsShould = must.find((m: any) => Array.isArray(m?.should));
    assert(nsShould, `search must include namespace OR filter for ${agent}`);

    const namespaceValues = (nsShould.should || []).map((c: any) => c?.match?.value);
    assert(
      namespaceValues.includes(`agent.${agent}.working_memory`),
      `search namespaces must include ${agent}.working_memory`
    );
    assert(
      !namespaceValues.includes("agent.assistant.working_memory") || agent === "assistant",
      `search must not leak to assistant namespace for ${agent}`
    );
  }

  console.log("✅ memory tools runtime-context assistant/scrum/fullstack tests passed");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
