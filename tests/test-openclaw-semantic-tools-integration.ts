import { registerSemanticMemoryTools } from "../src/tools/semantic-memory-tools.js";
import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "../src/services/dedupe.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

class MockApi {
  tools = new Map<string, any>();
  registerTool(tool: any) {
    this.tools.set(tool.name, tool);
  }
}

class MockEmbedding {
  async embed(text: string): Promise<number[]> {
    const seed = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0);
    return [seed % 101, seed % 97, seed % 89].map((n) => Number((n / 100).toFixed(3)));
  }

  async embedDetailed(text: string): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
    return { vector: await this.embed(text), metadata: { embedding_model: "mock" } };
  }
}

class MockQdrant {
  points: any[] = [];
  async upsert(points: any[]): Promise<void> {
    for (const p of points) {
      const idx = this.points.findIndex((x) => x.id === p.id);
      if (idx >= 0) this.points[idx] = p;
      else this.points.push(p);
    }
  }

  async search(_vector: number[], limit = 5, filter?: any): Promise<any[]> {
    const matched = this.points.filter((p) => {
      const must = filter?.must || [];
      return must.every((m: any) => {
        if (Array.isArray(m.should)) {
          return m.should.some((s: any) => this.matchLeaf(p.payload, s));
        }
        return this.matchLeaf(p.payload, m);
      });
    });

    return matched.slice(0, limit).map((p) => ({ id: p.id, score: 0.95, payload: p.payload }));
  }

  private matchLeaf(payload: any, cond: any): boolean {
    const key = cond?.key;
    const value = cond?.match?.value;
    if (!key) return true;
    return payload?.[key] === value;
  }
}

async function run() {
  console.log("\n🧪 OpenClaw Semantic Tools Integration Tests\n");

  const api = new MockApi();
  const qdrant = new MockQdrant();
  const embedding = new MockEmbedding();
  const dedupe = new DeduplicationService(0.95, console);
  const semantic = new SemanticMemoryUseCase(qdrant as any, embedding as any, dedupe);

  registerSemanticMemoryTools(api as any, {
    stateDir: "/tmp/asm43-state",
    slotDbDir: "/tmp/asm43-slotdb",
    semanticUseCaseFactory: () => semantic,
  });

  const store = api.tools.get("memory_store");
  const search = api.tools.get("memory_search");
  assert(store && search, "memory_store and memory_search tools must be registered");

  const ctx = { sessionKey: "agent:assistant:u-test" };

  const storeRes = await store.execute("1", {
    text: "OpenClaw tool path now uses MemoryUseCase semantic execution",
    namespace: "assistant",
  }, ctx);
  assert(storeRes?.isError !== true, "memory_store should succeed via runtime use-case path");
  assert(String(storeRes?.content?.[0]?.text || "").includes("Memory stored successfully"), "store response text compatibility");

  const searchRes = await search.execute("2", {
    query: "semantic execution",
    namespace: "assistant",
    minScore: 0.1,
  }, ctx);
  assert(searchRes?.isError !== true, "memory_search should succeed via runtime use-case path");
  const text = String(searchRes?.content?.[0]?.text || "");
  assert(text.includes("Found"), "search response should include found summary");
  assert(text.includes("OpenClaw tool path now uses MemoryUseCase semantic execution"), "search should include stored memory text");

  console.log("✅ OpenClaw semantic tools integration passed\n");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
