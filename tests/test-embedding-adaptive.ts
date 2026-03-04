import { EmbeddingClient } from "../src/services/embedding.js";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

async function testLongTextChunking() {
  const originalFetch = global.fetch as any;
  const calls: any[] = [];

  (global as any).fetch = async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const body = JSON.parse(init.body);
    const payload = Array.isArray(body.input) ? body.input : [body.input || body.prompt];

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: payload.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
        };
      },
    } as any;
  };

  try {
    const client = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:4142",
      model: "text-embedding-3-small",
      dimensions: 3,
      timeout: 5000,
    });

    const hugeText = "alpha ".repeat(25000);
    const result = await client.embedDetailed(hugeText);

    assert(result.vector.length === 3, "vector length should be 3");
    assert(result.metadata.embedding_chunks_count > 1, "long text must be chunked");
    assert(result.metadata.embedding_safe_chunk_tokens <= 6000, "safe chunk tokens must be <= 6000");

    const firstReq = calls[0];
    const firstPayload = Array.isArray(firstReq.input) ? firstReq.input : [firstReq.input || firstReq.prompt];
    assert(firstPayload.length > 1, "first request should include multiple chunks for openai format");

    for (const req of calls) {
      const payload = Array.isArray(req.input) ? req.input : [req.input || req.prompt];
      for (const chunk of payload) {
        if (typeof chunk === "string") {
          const estTokens = Math.ceil(chunk.length / 4);
          assert(estTokens <= 6000, "chunk exceeds safe token limit");
        }
      }
    }
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function testAdaptiveRetryOn400() {
  const originalFetch = global.fetch as any;
  const calls: any[] = [];
  let first = true;

  (global as any).fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });

    if (first) {
      first = false;
      return {
        ok: false,
        status: 400,
        async text() {
          return "context length exceeded maximum 8192 tokens";
        },
      } as any;
    }

    const payload = Array.isArray(body.input) ? body.input : [body.input || body.prompt];

    if (String(url).endsWith("/v1/embeddings")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: payload.map(() => ({ embedding: [0.4, 0.5, 0.6] })),
          };
        },
      } as any;
    }

    if (String(url).endsWith("/api/embeddings")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { embedding: [0.4, 0.5, 0.6] };
        },
      } as any;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { embeddings: [[0.4, 0.5, 0.6]] };
      },
    } as any;
  };

  try {
    const client = new EmbeddingClient({
      embeddingApiUrl: "http://localhost:4142",
      model: "text-embedding-3-small",
      dimensions: 3,
      timeout: 5000,
    });

    const longText = "beta ".repeat(12000);
    const result = await client.embedDetailed(longText);

    assert(result.vector.length === 3, "vector length should be 3 after retry");
    assert(calls.length >= 2, "should retry after 400");

    const firstPayload = Array.isArray(calls[0].body.input)
      ? calls[0].body.input
      : [calls[0].body.input || calls[0].body.prompt];
    const secondPayload = Array.isArray(calls[1].body.input)
      ? calls[1].body.input
      : [calls[1].body.input || calls[1].body.prompt];

    const firstChunk = firstPayload.find((x: any) => typeof x === "string") || "";
    const secondChunk = secondPayload.find((x: any) => typeof x === "string") || "";
    assert(firstChunk.length > secondChunk.length, "retry must use smaller chunk size");
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function main() {
  await testLongTextChunking();
  await testAdaptiveRetryOn400();
  console.log("✅ embedding adaptive tests passed");
}

main().catch((err) => {
  console.error("❌ embedding adaptive tests failed:", err.message);
  process.exit(1);
});
