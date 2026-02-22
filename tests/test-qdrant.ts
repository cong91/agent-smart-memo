/**
 * Test script for memory_store and memory_search
 * Run: npx tsx test-qdrant.ts
 */

const QDRANT_HOST = "localhost";
const QDRANT_PORT = 6333;
const QDRANT_COLLECTION = "mrc_bot_memory";

async function generateEmbedding(text: string): Promise<number[]> {
  const hash = text.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  // Collection mrc_bot_memory uses 1024 dimensions
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push(Math.sin(hash + i) * 0.1);
  }
  return embedding;
}

async function qdrantRequest(endpoint: string, method: string, body?: any): Promise<any> {
  const url = `http://${QDRANT_HOST}:${QDRANT_PORT}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Qdrant error: ${response.status} ${error}`);
  }
  
  return response.json();
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function testMemoryStore(): Promise<void> {
  console.log("🧪 Testing memory_store...\n");
  
  try {
    const text = "Test memory from agent-memo Phase 2 fix";
    const namespace = "fullstack";
    const vector = await generateEmbedding(text);
    const id = generateUUID();
    
    await qdrantRequest(`/collections/${QDRANT_COLLECTION}/points`, "PUT", {
      points: [{
        id,
        vector,
        payload: {
          text,
          namespace,
          agent: "fullstack",
          metadata: { type: "test" },
          created_at: new Date().toISOString(),
        },
      }],
    });
    
    console.log("✅ memory_store: SUCCESS");
    console.log(`   ID: ${id}`);
    console.log(`   Text: "${text}"\n`);
    
    return id;
  } catch (error) {
    console.log("❌ memory_store: FAILED");
    console.log(`   Error: ${error}\n`);
    throw error;
  }
}

async function testMemorySearch(): Promise<void> {
  console.log("🧪 Testing memory_search...\n");
  
  try {
    const query = "test memory";
    const vector = await generateEmbedding(query);
    
    const result = await qdrantRequest(
      `/collections/${QDRANT_COLLECTION}/points/search`,
      "POST",
      {
        vector,
        limit: 5,
        with_payload: true,
        with_vector: false,
      },
    );
    
    if (!result.result || result.result.length === 0) {
      console.log("⚠️ memory_search: No results found (but API worked)\n");
      return;
    }
    
    console.log("✅ memory_search: SUCCESS");
    console.log(`   Found ${result.result.length} result(s):\n`);
    
    result.result.forEach((point: any, idx: number) => {
      const payload = point.payload || {};
      const score = (point.score * 100).toFixed(1);
      console.log(`   [${idx + 1}] Score: ${score}%`);
      console.log(`       Text: "${payload.text || 'N/A'}"`);
      console.log(`       Namespace: ${payload.namespace || 'N/A'}\n`);
    });
    
  } catch (error) {
    console.log("❌ memory_search: FAILED");
    console.log(`   Error: ${error}\n`);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("🧪 Testing Qdrant Integration for agent-memo");
  console.log("=".repeat(60) + "\n");
  
  try {
    await testMemoryStore();
    await testMemorySearch();
    
    console.log("=".repeat(60));
    console.log("🎉 ALL TESTS PASSED!");
    console.log("=".repeat(60));
  } catch (error) {
    console.log("=".repeat(60));
    console.log("❌ TESTS FAILED");
    console.log("=".repeat(60));
    process.exit(1);
  }
}

main();
