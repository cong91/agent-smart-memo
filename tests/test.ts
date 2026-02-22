/**
 * Tests for SlotDB — run with: node --experimental-sqlite test.ts
 * Or via: npx tsx test.ts (Node 22+)
 */

import { SlotDB } from "../src/db/slot-db.js";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `agent-memo-test-${Date.now()}`);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n🧪 SlotDB Tests\n");

const db = new SlotDB(TEST_DIR);
const USER = "telegram:dm:5165741309";
const AGENT = "scrum";

// --- Basic Set/Get ---

test("set a new slot returns version 1", () => {
  const slot = db.set(USER, AGENT, {
    key: "profile.name",
    value: "MrC",
    source: "manual",
  });
  assertEqual(slot.version, 1, "version should be 1");
  assertEqual(slot.key, "profile.name", "key should match");
  assertEqual(slot.value, "MrC", "value should match");
  assertEqual(slot.category, "profile", "category should be auto-inferred");
  assertEqual(slot.source, "manual", "source should be manual");
});

test("get a slot by key", () => {
  const result = db.get(USER, AGENT, { key: "profile.name" });
  assert(!Array.isArray(result), "should return single slot");
  assert(result !== null, "should find the slot");
  assertEqual((result as any).value, "MrC", "value should be MrC");
});

test("update a slot increments version", () => {
  const slot = db.set(USER, AGENT, {
    key: "profile.name",
    value: "MrC Đẹp Trai",
    source: "manual",
  });
  assertEqual(slot.version, 2, "version should be 2 after update");
  assertEqual(slot.value, "MrC Đẹp Trai", "value should be updated");
});

test("get returns updated value", () => {
  const result = db.get(USER, AGENT, { key: "profile.name" }) as any;
  assertEqual(result.value, "MrC Đẹp Trai", "should get updated value");
  assertEqual(result.version, 2, "version should be 2");
});

// --- Category auto-inference ---

test("auto-infers profile category", () => {
  const slot = db.set(USER, AGENT, { key: "profile.timezone", value: "Asia/Saigon" });
  assertEqual(slot.category, "profile", "should be profile");
});

test("auto-infers preferences category", () => {
  const slot = db.set(USER, AGENT, { key: "preferences.theme", value: "dark" });
  assertEqual(slot.category, "preferences", "should be preferences");
});

test("auto-infers project category", () => {
  const slot = db.set(USER, AGENT, {
    key: "project.tech_stack",
    value: ["TypeScript", "SQLite", "OpenClaw"],
  });
  assertEqual(slot.category, "project", "should be project");
});

test("auto-infers environment category", () => {
  const slot = db.set(USER, AGENT, { key: "environment.os", value: "macOS" });
  assertEqual(slot.category, "environment", "should be environment");
});

test("falls back to custom category", () => {
  const slot = db.set(USER, AGENT, { key: "hobby.favorite_game", value: "chess" });
  assertEqual(slot.category, "custom", "should be custom for unknown prefix");
});

// --- Complex values ---

test("stores array values", () => {
  const arr = ["TypeScript", "SQLite", "OpenClaw"];
  db.set(USER, AGENT, { key: "project.tech_stack", value: arr });
  const result = db.get(USER, AGENT, { key: "project.tech_stack" }) as any;
  assert(Array.isArray(result.value), "should be array");
  assertEqual(result.value.length, 3, "should have 3 items");
});

test("stores object values", () => {
  const obj = { deadline: "2026-03-01", status: "in-progress" };
  db.set(USER, AGENT, { key: "project.details", value: obj });
  const result = db.get(USER, AGENT, { key: "project.details" }) as any;
  assertEqual(result.value.deadline, "2026-03-01", "should preserve object");
});

test("stores boolean values", () => {
  db.set(USER, AGENT, { key: "preferences.notifications", value: true });
  const result = db.get(USER, AGENT, { key: "preferences.notifications" }) as any;
  assertEqual(result.value, true, "should be true");
});

test("stores number values", () => {
  db.set(USER, AGENT, { key: "profile.age", value: 30 });
  const result = db.get(USER, AGENT, { key: "profile.age" }) as any;
  assertEqual(result.value, 30, "should be 30");
});

// --- List ---

test("list all slots", () => {
  const slots = db.list(USER, AGENT);
  assert(slots.length >= 8, `should have at least 8 slots, got ${slots.length}`);
});

test("list by category", () => {
  const slots = db.list(USER, AGENT, { category: "profile" });
  assert(slots.length >= 3, `should have >= 3 profile slots, got ${slots.length}`);
  assert(
    slots.every((s) => s.category === "profile"),
    "all should be profile category",
  );
});

test("list by prefix", () => {
  const slots = db.list(USER, AGENT, { prefix: "profile." });
  assert(slots.length >= 3, `should have >= 3 slots with profile. prefix, got ${slots.length}`);
});

// --- Get by category ---

test("get all slots in a category", () => {
  const result = db.get(USER, AGENT, { category: "preferences" });
  assert(Array.isArray(result), "should return array for category query");
  assert((result as any[]).length >= 2, "should have >= 2 preference slots");
});

// --- Delete ---

test("delete a slot", () => {
  const deleted = db.delete(USER, AGENT, "hobby.favorite_game");
  assert(deleted, "should return true for successful delete");
  const result = db.get(USER, AGENT, { key: "hobby.favorite_game" });
  assertEqual(result, null, "should be null after delete");
});

test("delete non-existent slot returns false", () => {
  const deleted = db.delete(USER, AGENT, "nonexistent.key");
  assert(!deleted, "should return false");
});

// --- getCurrentState ---

test("getCurrentState returns grouped structure", () => {
  const state = db.getCurrentState(USER, AGENT);
  assert("profile" in state, "should have profile category");
  assert("preferences" in state, "should have preferences category");
  assert("project" in state, "should have project category");
  assertEqual(state.profile["profile.name"], "MrC Đẹp Trai", "should have correct name");
});

// --- Scope isolation ---

test("different users have isolated slots", () => {
  const USER2 = "telegram:dm:9999999";
  db.set(USER2, AGENT, { key: "profile.name", value: "OtherUser" });
  const result1 = db.get(USER, AGENT, { key: "profile.name" }) as any;
  const result2 = db.get(USER2, AGENT, { key: "profile.name" }) as any;
  assertEqual(result1.value, "MrC Đẹp Trai", "user1 should be isolated");
  assertEqual(result2.value, "OtherUser", "user2 should be isolated");
});

test("different agents have isolated slots", () => {
  const AGENT2 = "fullstack";
  db.set(USER, AGENT2, { key: "profile.name", value: "FullstackUser" });
  const result1 = db.get(USER, AGENT, { key: "profile.name" }) as any;
  const result2 = db.get(USER, AGENT2, { key: "profile.name" }) as any;
  assertEqual(result1.value, "MrC Đẹp Trai", "agent1 should be isolated");
  assertEqual(result2.value, "FullstackUser", "agent2 should be isolated");
});

// --- Count ---

test("count returns correct number", () => {
  const count = db.count(USER, AGENT);
  assert(count >= 7, `should have >= 7 slots, got ${count}`);
});

// --- Expiration ---

test("expired slots are cleaned up", () => {
  const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
  db.set(USER, AGENT, {
    key: "temp.expired_test",
    value: "should disappear",
    expires_at: pastDate,
  });
  // The next get/list should clean it up
  const result = db.get(USER, AGENT, { key: "temp.expired_test" });
  assertEqual(result, null, "expired slot should be cleaned up");
});

test("non-expired slots persist", () => {
  const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
  db.set(USER, AGENT, {
    key: "temp.valid_test",
    value: "should persist",
    expires_at: futureDate,
  });
  const result = db.get(USER, AGENT, { key: "temp.valid_test" }) as any;
  assertEqual(result.value, "should persist", "non-expired slot should exist");
  // Cleanup
  db.delete(USER, AGENT, "temp.valid_test");
});

// --- Confidence ---

test("custom confidence is stored", () => {
  db.set(USER, AGENT, {
    key: "profile.estimated_age",
    value: 28,
    confidence: 0.7,
  });
  const result = db.get(USER, AGENT, { key: "profile.estimated_age" }) as any;
  assertEqual(result.confidence, 0.7, "confidence should be 0.7");
  db.delete(USER, AGENT, "profile.estimated_age");
});

// --- Unicode support ---

test("handles Vietnamese text", () => {
  db.set(USER, AGENT, { key: "profile.location", value: "Thành phố Hồ Chí Minh" });
  const result = db.get(USER, AGENT, { key: "profile.location" }) as any;
  assertEqual(result.value, "Thành phố Hồ Chí Minh", "should handle Vietnamese");
});

test("handles emoji", () => {
  db.set(USER, AGENT, { key: "preferences.mood", value: "🚀 Productive!" });
  const result = db.get(USER, AGENT, { key: "preferences.mood" }) as any;
  assertEqual(result.value, "🚀 Productive!", "should handle emoji");
  db.delete(USER, AGENT, "preferences.mood");
});

// ============================================================================
// Summary
// ============================================================================

db.close();

// Cleanup test dir
try {
  rmSync(TEST_DIR, { recursive: true, force: true });
} catch {}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("🎉 All tests passed!\n");
}
