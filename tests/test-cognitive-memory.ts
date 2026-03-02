import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import {
  captureShortTermState,
  captureMidTermSummary,
  captureLongTermPattern,
  injectMemoryContext,
} from "../src/hooks/auto-capture.js";

const TEST_DIR = join(tmpdir(), `agent-memo-cognitive-memory-${Date.now()}`);
const USER = "telegram:dm:test-cognitive";
const AGENT = "scrum";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeEmbeddingClient {
  async embed(_text: string): Promise<number[]> {
    return Array.from({ length: 8 }, (_, i) => i / 10);
  }
}

class FakeQdrantClient {
  public upserts: Array<any[]> = [];
  public searchResults: any[] = [];

  async upsert(points: any[]): Promise<void> {
    this.upserts.push(points);
  }

  async search(_vector: number[], _limit = 5, _filter?: Record<string, any>): Promise<any[]> {
    return this.searchResults;
  }
}

async function run() {
  console.log("\n🧪 Cognitive Memory Tests\n");

  const dbDir = join(TEST_DIR, "agent-memo");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "slots.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.close();

  const slotDB = new SlotDB(TEST_DIR);
  const fakeEmbedding = new FakeEmbeddingClient() as any;
  const fakeQdrant = new FakeQdrantClient() as any;

  let passed = 0;

  // 1) Short-term capture after 3 actions
  {
    const messages = [
      { role: "user", content: "Action 1: receive request" },
      { role: "assistant", content: "Action 2: analyze architecture" },
      { role: "assistant", content: "Action 3: implement feature" },
    ] as any;

    const stored = captureShortTermState(slotDB, USER, AGENT, messages, "Implementing memory tiers", 3);
    assert(stored, "Short-term should be captured after 3 actions");

    const slot = slotDB.get(USER, AGENT, { key: "project_living_state" }) as any;
    assert(slot && !Array.isArray(slot), "project_living_state must exist");
    assert(slot.value.ttl === 48 * 3600 * 1000, "Short-term TTL should be 48h");
    passed++;
    console.log("✅ Test 1: Short-term capture after 3 actions");
  }

  // 2) TTL expiration fallback: short-term expired -> mid-term
  {
    const expiredValue = {
      last_actions: ["old action"],
      current_focus: "old focus",
      next_steps: ["old step"],
      timestamp: Date.now() - (49 * 3600 * 1000),
      ttl: 48 * 3600 * 1000,
    };

    slotDB.set(USER, AGENT, {
      key: "project_living_state",
      value: expiredValue,
      category: "project",
      source: "auto_capture",
    });

    const dateKey = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split("T")[0];
    slotDB.set(USER, AGENT, {
      key: `session.${dateKey}.summary`,
      value: {
        summary: "Yesterday summary",
        key_decisions: ["Use fallback"],
        outcomes: ["Recovered context"],
        ttl: 30 * 24 * 3600 * 1000,
        timestamp: Date.now(),
      },
      category: "custom",
      source: "auto_capture",
    });

    const context = await injectMemoryContext(AGENT, {
      db: slotDB,
      qdrant: fakeQdrant,
      embedding: fakeEmbedding,
      userId: USER,
      query: "recent context",
    });

    assert(context.includes("MID_TERM:"), "Should fallback to mid-term when short-term expired");
    passed++;
    console.log("✅ Test 2: TTL expiration fallback short -> mid");
  }

  // 3) End-of-day summary creation
  {
    const msgs = [
      { role: "user", content: "Quyết định chốt kiến trúc" },
      { role: "assistant", content: "completed implementation and deployed staging" },
    ] as any;

    const result = await captureMidTermSummary(slotDB, fakeQdrant, fakeEmbedding, {
      userId: USER,
      agentId: AGENT,
      sessionKey: "agent:scrum:test-cognitive",
      messages: msgs,
      sessionEnding: true,
      lastMidTermCaptureAt: Date.now(),
      now: Date.now(),
    });

    assert(result.stored, "Mid-term summary should store on session ending");

    const key = `session.${new Date().toISOString().split("T")[0]}.summary`;
    const slot = slotDB.get(USER, AGENT, { key }) as any;
    assert(slot && !Array.isArray(slot), "session summary slot must exist");
    assert(slot.value.ttl === 30 * 24 * 3600 * 1000, "Mid-term TTL should be 30d");
    assert(fakeQdrant.upserts.length >= 1, "Should upsert summary into long-term index namespace");
    passed++;
    console.log("✅ Test 3: End-of-day mid-term summary creation");
  }

  // 4) Important pattern detection -> long-term store
  {
    const stored = await captureLongTermPattern(fakeQdrant, fakeEmbedding, {
      text: "Critical exploit detected with major drawdown and SEC regulation response",
      agentId: AGENT,
      userId: USER,
    });

    assert(stored, "Important pattern should be stored to long-term memory");
    const latest = fakeQdrant.upserts[fakeQdrant.upserts.length - 1][0];
    assert(latest.payload.namespace === "market_patterns", "Long-term namespace must be market_patterns");
    passed++;
    console.log("✅ Test 4: Important pattern -> long-term memory store");
  }

  // 5) Agent wake -> memory context injection with long-term fallback
  {
    slotDB.delete(USER, AGENT, "project_living_state");
    const dateKey = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split("T")[0];
    slotDB.delete(USER, AGENT, `session.${dateKey}.summary`);

    fakeQdrant.searchResults = [
      {
        score: 0.81,
        payload: { text: "Pattern: always validate session memory fallback" },
      },
    ];

    const context = await injectMemoryContext(AGENT, {
      db: slotDB,
      qdrant: fakeQdrant,
      embedding: fakeEmbedding,
      userId: USER,
      query: "recent context",
    });

    assert(context.includes("LONG_TERM:"), "Should fallback to long-term semantic memories");
    passed++;
    console.log("✅ Test 5: Agent wake memory context injection with long-term fallback");
  }

  slotDB.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log(`\n🎉 Cognitive memory tests passed: ${passed}/5\n`);
}

run().catch((err) => {
  console.error("❌ Cognitive memory tests failed:", err);
  process.exit(1);
});
