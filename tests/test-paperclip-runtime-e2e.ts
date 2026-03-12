import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPaperclipRuntime } from "../src/adapters/paperclip/runtime.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 Paperclip Runtime E2E Tests\n");

const TEST_ROOT = join(tmpdir(), `agent-memo-paperclip-e2e-${Date.now()}`);
const STATE_DIR = join(TEST_ROOT, "state");
const SLOTDB_DIR = join(TEST_ROOT, "slotdb");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(SLOTDB_DIR)) mkdirSync(SLOTDB_DIR, { recursive: true });

const runtime = createPaperclipRuntime({
  stateDir: STATE_DIR,
  slotDbDir: SLOTDB_DIR,
});

const ctx = {
  userId: "paperclip-user-1",
  sessionId: "paperclip-session-1",
  workspaceId: "workspace-1",
  traceId: "trace-1",
};

// slot.set
const setRes = await runtime.adapter.execute({
  action: "slot.set",
  payload: {
    key: "project.current_task",
    value: "wire-memory-usecase-port",
    source: "manual",
  },
  context: ctx,
  namespace: "shared.project_context",
});
assert(setRes.ok === true, "slot.set should succeed");
assert((setRes.data as any)?.key === "project.current_task", "slot.set should return stored key");

// slot.get
const getRes = await runtime.adapter.execute({
  action: "slot.get",
  payload: { key: "project.current_task" },
  context: ctx,
});
assert(getRes.ok === true, "slot.get should succeed");
assert((getRes.data as any)?.value === "wire-memory-usecase-port", "slot.get should return stored value");

// slot.list
const listRes = await runtime.adapter.execute({
  action: "slot.list",
  payload: { scope: "all" },
  context: ctx,
});
assert(listRes.ok === true, "slot.list should succeed");
assert(Array.isArray(listRes.data), "slot.list should return list");
assert((listRes.data as any[]).some((s) => s.key === "project.current_task"), "slot.list should include inserted slot");

// graph.entity.set create
const entityRes = await runtime.adapter.execute({
  action: "graph.entity.set",
  payload: { name: "PaperclipRuntime", type: "project" },
  context: ctx,
});
assert(entityRes.ok === true, "graph.entity.set create should succeed");
const entityId = (entityRes.data as any)?.id;
assert(typeof entityId === "string" && entityId.length > 0, "graph.entity.set should return id");

// graph.entity.get by id
const entityGetRes = await runtime.adapter.execute({
  action: "graph.entity.get",
  payload: { id: entityId },
  context: ctx,
});
assert(entityGetRes.ok === true, "graph.entity.get should succeed");
assert((entityGetRes.data as any)?.name === "PaperclipRuntime", "graph.entity.get should return inserted entity");

// slot.delete
const delRes = await runtime.adapter.execute({
  action: "slot.delete",
  payload: { key: "project.current_task" },
  context: ctx,
});
assert(delRes.ok === true, "slot.delete should succeed");
assert((delRes.data as any)?.deleted === true, "slot.delete should mark deleted true");

runtime.slotDb.close();
try {
  rmSync(TEST_ROOT, { recursive: true, force: true });
} catch {}

console.log("✅ Paperclip runtime e2e passed (runtime wiring + MemoryUseCasePort execution)\n");
