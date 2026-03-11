import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EmbeddingClient } from "../src/services/embedding.js";
import { createMemoryStoreTool } from "../src/tools/memory_store.js";
import { createMemorySearchTool } from "../src/tools/memory_search.js";
import { DeduplicationService } from "../src/services/dedupe.js";
import type { ScoredPoint } from "../src/types.js";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} > ${ms}ms`)), ms)),
  ]);
}

function makeStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function prepareOldCapability(stateDir: string, modelKey: string): void {
  const filePath = join(stateDir, "plugin-data", "agent-smart-memo", "embedding-capabilities.json");
  mkdirSync(join(stateDir, "plugin-data", "agent-smart-memo"), { recursive: true });

  writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        capabilities: {
          [modelKey]: {
            seedMaxTokens: 8192,
            discoveredMaxTokens: 8192,
            safeRatio: 0.72,
            reserveTokens: 96,
            vectorDim: 4,
            updatedAt: "2020-01-01T00:00:00.000Z",
            source: "docs",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );
}

class MockQdrant {
  public points: Array<{ id: string; vector: number[]; payload: Record<string, any> }> = [];

  async search(_vector: number[], _limit: number, _filter?: Record<string, any>): Promise<ScoredPoint[]> {
    if (this.points.length === 0) return [];
    return this.points.map((p) => ({
      id: p.id,
      score: 0.96,
      payload: p.payload,
    }));
  }

  async upsert(points: Array<{ id: string; vector: number[]; payload: Record<string, any> }>): Promise<void> {
    this.points.push(...points);
  }
}

async function testReadyIsNonBlockingAndEmbedDetailedWorks() {
  const originalFetch = global.fetch as any;

  let embeddingCalls = 0;
  (global as any).fetch = async (url: string, init?: any) => {
    if (!init?.body) {
      if (String(url).includes("/api/tags")) {
        return { ok: true, status: 200, async json() { return { models: [] }; } } as any;
      }
      throw new Error(`unexpected metadata call: ${url}`);
    }

    embeddingCalls += 1;
    // simulate heavy probe/API latency
    await new Promise((r) => setTimeout(r, 200));

    return {
      ok: true,
      status: 200,
      async json() {
        return { embedding: [0.1, 0.2, 0.3, 0.4] };
      },
    } as any;
  };

  try {
    const stateDir = makeStateDir("asm-nohang-");
    const endpoint = "http://localhost:11434/api/embeddings";
    const model = "qwen3-embedding:0.6b";
    const modelKey = `ollama::${endpoint}::${model}`;
    prepareOldCapability(stateDir, modelKey);

    const client = new EmbeddingClient({
      embeddingApiUrl: endpoint,
      model,
      dimensions: 4,
      stateDir,
      timeout: 5000,
    });

    const t0 = Date.now();
    const key = await withTimeout(client.getModelKey(), 300, "EmbeddingClient.ready");
    const elapsed = Date.now() - t0;

    assert(key === modelKey, `modelKey mismatch: ${key}`);
    assert(elapsed < 300, `ready resolved too slow: ${elapsed}ms`);

    const embedded = await withTimeout(client.embedDetailed("hello from nohang test"), 1500, "embedDetailed");
    assert(Array.isArray(embedded.vector) && embedded.vector.length === 4, "embedDetailed vector invalid");
    assert(embedded.metadata.embedding_fallback_hash === false, "embedDetailed should not fallback hash");
    assert(embeddingCalls >= 1, "expected embedding API calls");
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function testMemoryToolsDoNotHang() {
  const originalFetch = global.fetch as any;

  (global as any).fetch = async (_url: string, init?: any) => {
    if (!init?.body) {
      return { ok: true, status: 200, async json() { return { models: [] }; } } as any;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { embedding: [0.5, 0.4, 0.3, 0.2] };
      },
    } as any;
  };

  try {
    const embedding = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:11434/api/embeddings",
      model: "qwen3-embedding:0.6b",
      dimensions: 4,
      stateDir: makeStateDir("asm-tools-"),
    });

    const qdrant = new MockQdrant();
    const dedupe = new DeduplicationService(0.95, console);

    const memoryStore = createMemoryStoreTool(qdrant as any, embedding, dedupe, "shared.project_context");
    const memorySearch = createMemorySearchTool(qdrant as any, embedding, "shared.project_context");

    const storeRes = await withTimeout(
      memoryStore.execute("tc-store", { text: "Fix deadlock memory tools", agentId: "assistant" }),
      1500,
      "memory_store"
    );

    assert(storeRes.isError !== true, `memory_store failed: ${(storeRes as any).details?.toolResult?.text}`);

    const searchRes = await withTimeout(
      memorySearch.execute("tc-search", { query: "deadlock memory", agentId: "assistant", minScore: 0.1 }),
      1500,
      "memory_search"
    );

    assert(searchRes.isError !== true, `memory_search failed: ${(searchRes as any).details?.toolResult?.text}`);
    const text = (searchRes.content?.[0]?.text || "") as string;
    assert(text.includes("Found") || text.includes("No relevant memories"), "memory_search response not valid");
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function main() {
  await testReadyIsNonBlockingAndEmbedDetailedWorks();
  await testMemoryToolsDoNotHang();
  console.log("✅ embedding nohang tests passed");
}

main().catch((err) => {
  console.error("❌ embedding nohang tests failed:", err.message);
  process.exit(1);
});
