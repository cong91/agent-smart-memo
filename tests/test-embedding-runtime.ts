import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingClient } from "../src/services/embedding.js";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

function makeStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function testModelSwitchOpenAIvsOllama() {
  const originalFetch = global.fetch as any;
  const calls: Array<{ url: string; body: any }> = [];

  (global as any).fetch = async (url: string, init?: any) => {
    if (!init?.body) {
      if (String(url).includes("/api/tags")) {
        return { ok: true, status: 200, async json() { return { models: [] }; } } as any;
      }
      throw new Error(`unexpected metadata call url=${url}`);
    }

    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });

    if (String(url).endsWith("/v1/embeddings")) {
      const input = Array.isArray(body.input) ? body.input : [body.input || "x"];
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) };
        },
      } as any;
    }

    if (String(url).endsWith("/api/embeddings")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { embedding: [0.2, 0.3, 0.4, 0.5] };
        },
      } as any;
    }

    throw new Error(`unexpected url ${url}`);
  };

  try {
    const openaiClient = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:4142/v1/embeddings",
      model: "text-embedding-3-small",
      dimensions: 4,
      stateDir: makeStateDir("memo-openai-"),
    });

    const r1 = await openaiClient.embedDetailed("hello openai");
    const k1 = await openaiClient.getModelKey();

    assert(k1.includes("openai::http://localhost:4142/v1/embeddings::text-embedding-3-small"), "openai model key mismatch");
    assert(r1.vector.length === 4, "openai vector length mismatch");

    const ollamaClient = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:11434/api/embeddings",
      model: "qwen3-embedding:4b",
      dimensions: 4,
      stateDir: makeStateDir("memo-ollama-"),
    });

    const r2 = await ollamaClient.embedDetailed("hello ollama");
    const k2 = await ollamaClient.getModelKey();

    assert(k2.includes("ollama::http://localhost:11434/api/embeddings::qwen3-embedding:4b"), "ollama model key mismatch");
    assert(r2.vector.length === 4, "ollama vector length mismatch");
    assert(k1 !== k2, "model switch must create different model keys");

    assert(calls.some((c) => c.url.endsWith("/v1/embeddings")), "missing openai embedding call");
    assert(calls.some((c) => c.url.endsWith("/api/embeddings")), "missing ollama embedding call");
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function testCalibrationUpdateByContextErrors() {
  const originalFetch = global.fetch as any;
  const stateDir = makeStateDir("memo-calibrate-");

  (global as any).fetch = async (url: string, init?: any) => {
    if (!init?.body) {
      if (String(url).includes("/api/tags")) {
        return { ok: true, status: 200, async json() { return { models: [{ model: "qwen3-embedding:4b", details: { embedding_length: 2560 } }] }; } } as any;
      }
      throw new Error(`unexpected metadata call: ${url}`);
    }

    const body = JSON.parse(init.body);
    const prompt = body.prompt || "";
    const tokens = String(prompt).trim().split(/\s+/).filter(Boolean).length;

    if (tokens > 4096) {
      return {
        ok: false,
        status: 500,
        async text() {
          return "the input length exceeds the context length (max 4096 tokens)";
        },
      } as any;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { embedding: [0.11, 0.12, 0.13, 0.14] };
      },
    } as any;
  };

  try {
    const client = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:11434/api/embeddings",
      model: "qwen3-embedding:4b",
      dimensions: 4,
      stateDir,
    });

    await client.calibrateRuntimeCapability(true);

    const registryPath = join(stateDir, "plugin-data", "agent-smart-memo", "embedding-capabilities.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const key = await client.getModelKey();
    assert(!!registry.capabilities?.[key], `capability registry should contain key ${key}`);

    const cap = registry.capabilities[key];
    assert(cap.discoveredMaxTokens <= 4096, `expected discovered <= 4096, got ${cap.discoveredMaxTokens}`);
    assert(cap.vectorDim === 2560, `expected vectorDim=2560 from metadata, got ${cap.vectorDim}`);
    assert(cap.source === "probe", `expected source=probe, got ${cap.source}`);
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function testLongTextStressWithRetryNoHashFallback() {
  const originalFetch = global.fetch as any;
  let firstLongCall = true;

  (global as any).fetch = async (url: string, init?: any) => {
    if (!init?.body) {
      if (String(url).includes("/api/tags")) {
        return { ok: true, status: 200, async json() { return { models: [] }; } } as any;
      }
      throw new Error(`unexpected metadata call: ${url}`);
    }

    const body = JSON.parse(init.body);
    const prompt = body.prompt || "";
    const tokens = String(prompt).trim().split(/\s+/).filter(Boolean).length;

    if (firstLongCall && tokens > 3000) {
      firstLongCall = false;
      return {
        ok: false,
        status: 500,
        async text() {
          return "the input length exceeds the context length";
        },
      } as any;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { embedding: [0.7, 0.8, 0.9, 1.0] };
      },
    } as any;
  };

  try {
    const client = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:11434/api/embeddings",
      model: "qwen3-embedding:4b",
      dimensions: 4,
      stateDir: makeStateDir("memo-stress-"),
      timeout: 10000,
    });

    const longText = Array(12000).fill("alpha").join(" ");
    const result = await client.embedDetailed(longText);

    assert(result.vector.length === 4, "vector length mismatch for stress test");
    assert(result.metadata.embedding_chunks_count > 1, "stress text should be chunked");
    assert(result.metadata.embedding_fallback_hash === false, "should avoid hash fallback in recoverable context-length case");
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function main() {
  await testModelSwitchOpenAIvsOllama();
  await testCalibrationUpdateByContextErrors();
  await testLongTextStressWithRetryNoHashFallback();
  console.log("✅ embedding runtime tests passed");
}

main().catch((err) => {
  console.error("❌ embedding runtime tests failed:", err.message);
  process.exit(1);
});
