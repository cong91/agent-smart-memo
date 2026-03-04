import { QdrantClient } from "../src/services/qdrant.js";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

async function testDimensionMismatchFailFast() {
  const originalFetch = global.fetch as any;
  const calls: string[] = [];

  (global as any).fetch = async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get(name: string) { return name === "content-type" ? "application/json" : null; } },
      async json() {
        return {
          result: {
            config: {
              params: {
                vectors: { size: 1536 },
              },
            },
          },
        };
      },
      async text() { return JSON.stringify({ ok: true }); },
    } as any;
  };

  try {
    const qdrant = new QdrantClient({
      host: "localhost",
      port: 6333,
      collection: "mrc_bot_memory",
      vectorSize: 1536,
      dimensionRouteMap: { 2560: "mrc_bot_memory_2560" },
    });

    let threw = false;
    try {
      await qdrant.search(new Array(2560).fill(0.01), 5);
    } catch (error: any) {
      threw = true;
      assert(error.message.includes("DIMENSION_MISMATCH"), "must include DIMENSION_MISMATCH");
      assert(error.message.includes("mrc_bot_memory_2560"), "must include route hint");
    }

    assert(threw, "search should fail-fast on dimension mismatch");
    assert(calls.length === 1, `should only fetch collection info; got ${calls.length} fetch calls`);
  } finally {
    (global as any).fetch = originalFetch;
  }
}

async function main() {
  await testDimensionMismatchFailFast();
  console.log("✅ qdrant dimension tests passed");
}

main().catch((err) => {
  console.error("❌ qdrant dimension tests failed:", err.message);
  process.exit(1);
});
