import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "../src/services/dedupe.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class MockEmbedding {
  async embed(text: string): Promise<number[]> {
    const seed = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0);
    return [seed % 97, seed % 89, seed % 83].map((n) => Number((n / 100).toFixed(3)));
  }

  async embedDetailed(text: string): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
    return {
      vector: await this.embed(text),
      metadata: {
        embedding_model: "mock",
        embedding_provider: "mock",
      },
    };
  }
}

class MockQdrant {
  public points: any[] = [];

  async upsert(points: any[]): Promise<void> {
    for (const p of points) {
      const idx = this.points.findIndex((x) => x.id === p.id);
      if (idx >= 0) this.points[idx] = p;
      else this.points.push(p);
    }
  }

  async search(_vector: number[], limit = 5, filter?: any): Promise<any[]> {
    const filtered = this.points.filter((p) => {
      const must = filter?.must || [];
      return must.every((m: any) => {
        if (Array.isArray(m.should)) {
          return m.should.some((s: any) => this.matchLeaf(p.payload, s));
        }
        return this.matchLeaf(p.payload, m);
      });
    });

    return filtered.slice(0, limit).map((p) => ({
      id: p.id,
      score: 0.95,
      payload: p.payload,
    }));
  }

  private matchLeaf(payload: any, cond: any): boolean {
    const key = cond?.key;
    const val = cond?.match?.value;
    if (!key) return true;
    return payload?.[key] === val;
  }
}

async function run() {
  console.log("\n🧪 Semantic Memory UseCase Tests\n");

  const qdrant = new MockQdrant();
  const embedding = new MockEmbedding();
  const dedupe = new DeduplicationService(0.95, console);
  const usecase = new SemanticMemoryUseCase(qdrant as any, embedding as any, dedupe);

  const context = { userId: "u1", agentId: "assistant", sessionId: "s1" };

  const captureRes = await usecase.capture(
    {
      text: "ASM-43 semantic usecase path is wired",
      namespace: "assistant",
      metadata: { source: "test" },
    },
    context,
  );

  assert(captureRes.created === true, "capture should create point");
  assert(captureRes.namespace === "agent.assistant.working_memory", "alias namespace must be canonicalized");

  const searchRes = await usecase.search(
    {
      query: "semantic usecase path",
      namespace: "assistant",
      minScore: 0.1,
    },
    context,
  );

  assert(searchRes.count >= 1, "search should return result");
  assert(searchRes.results[0].namespace === "agent.assistant.working_memory", "search namespace should match canonical");

  const duplicate = await usecase.capture(
    {
      text: "ASM-43 semantic usecase path is wired",
      namespace: "assistant",
    },
    context,
  );
  assert(duplicate.updated === true, "duplicate capture should update existing point");

  console.log("✅ semantic memory usecase tests passed\n");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
