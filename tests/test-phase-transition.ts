/**
 * Integration test for phase transition cleanup behavior.
 *
 * Scenario:
 * 1) Set volatile project slots
 * 2) Simulate old updated_at (8 days ago)
 * 3) Trigger cleanup via db.list()/db.get()
 * 4) Assert volatile project slots were cleaned
 * 5) Set new phase value and verify old value is replaced
 */

import { SlotDB } from "../src/db/slot-db.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `agent-memo-phase-test-${Date.now()}`);
const USER = "telegram:dm:phase-test";
const AGENT = "scrum";

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

console.log("\n🧪 Phase Transition Integration Test\n");

const db = new SlotDB(TEST_DIR);

try {
  // 1) Set volatile project slots
  db.set(USER, AGENT, {
    key: "project.current_epic",
    value: "Phase 10",
    source: "tool",
  });

  db.set(USER, AGENT, {
    key: "project.current_task",
    value: "Triển khai Frontend Epic 11-13",
    source: "tool",
  });

  // Verify initial values exist
  const beforeEpic = db.get(USER, AGENT, { key: "project.current_epic" }) as any;
  const beforeTask = db.get(USER, AGENT, { key: "project.current_task" }) as any;
  assert(beforeEpic !== null, "project.current_epic should exist before cleanup");
  assert(beforeTask !== null, "project.current_task should exist before cleanup");
  assertEqual(beforeEpic.value, "Phase 10", "initial epic should be Phase 10");

  // 2) Simulate time passing by forcing updated_at to 8 days ago
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const dbPath = join(TEST_DIR, "agent-memo", "slots.db");
  const raw = new DatabaseSync(dbPath);

  raw.prepare(
    `UPDATE slots
     SET updated_at = ?
     WHERE scope_user_id = ? AND scope_agent_id = ?
       AND key IN ('project.current_epic', 'project.current_task')`,
  ).run(eightDaysAgo, USER, AGENT);

  raw.close();

  // 3) Trigger cleanup via list/get (cleanExpired is called internally)
  db.list(USER, AGENT);

  // 4) Assert volatile project slots were cleaned
  const cleanedEpic = db.get(USER, AGENT, { key: "project.current_epic" });
  const cleanedTask = db.get(USER, AGENT, { key: "project.current_task" });
  assertEqual(cleanedEpic, null, "project.current_epic should be cleaned after TTL");
  assertEqual(cleanedTask, null, "project.current_task should be cleaned after TTL");

  // 5) Set new value and verify old value replaced
  const newEpic = db.set(USER, AGENT, {
    key: "project.current_epic",
    value: "Phase 11",
    source: "tool",
  });

  const afterEpic = db.get(USER, AGENT, { key: "project.current_epic" }) as any;
  assert(afterEpic !== null, "project.current_epic should exist after setting new value");
  assertEqual(afterEpic.value, "Phase 11", "new epic should be Phase 11");
  assertEqual(newEpic.version, 1, "new epic should be recreated as version 1 after cleanup");

  console.log("✅ Phase transition cleanup and replacement test passed\n");
} finally {
  db.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}
