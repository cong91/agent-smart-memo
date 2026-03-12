import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPaperclipRuntime } from "../src/adapters/paperclip/runtime.js";
import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "../src/services/dedupe.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 Paperclip Runtime E2E Tests\n");

const TEST_ROOT = join(tmpdir(), `agent-memo-paperclip-e2e-${Date.now()}`);
const STATE_DIR = join(TEST_ROOT, "state");
const SLOTDB_DIR = join(TEST_ROOT, "slotdb");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(SLOTDB_DIR)) mkdirSync(SLOTDB_DIR, { recursive: true });

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
        if (Array.isArray(m.should)) return m.should.some((s: any) => this.matchLeaf(p.payload, s));
        return this.matchLeaf(p.payload, m);
      });
    });
    return matched.slice(0, limit).map((p) => ({ id: p.id, score: 0.95, payload: p.payload }));
  }
  private matchLeaf(payload: any, cond: any): boolean {
    const key = cond?.key;
    const val = cond?.match?.value;
    if (!key) return true;
    return payload?.[key] === val;
  }
}

const semanticUseCase = new SemanticMemoryUseCase(
  new MockQdrant() as any,
  new MockEmbedding() as any,
  new DeduplicationService(0.95, console),
);

const runtime = createPaperclipRuntime({
  stateDir: STATE_DIR,
  slotDbDir: SLOTDB_DIR,
  semanticUseCase,
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

// memory.capture (semantic runtime path)
const memCaptureRes = await runtime.adapter.execute({
  action: "memory.capture",
  payload: {
    text: "Paperclip runtime semantic path now runs through MemoryUseCasePort",
    namespace: "assistant",
  },
  context: ctx,
});
assert(memCaptureRes.ok === true, "memory.capture should succeed");
assert(Boolean((memCaptureRes.data as any)?.id), "memory.capture should return id");

// memory.search (semantic runtime path)
const memSearchRes = await runtime.adapter.execute({
  action: "memory.search",
  payload: {
    query: "semantic path",
    namespace: "assistant",
    minScore: 0.1,
  },
  context: ctx,
});
assert(memSearchRes.ok === true, "memory.search should succeed");
assert(Array.isArray((memSearchRes.data as any)?.results), "memory.search should return results array");
assert(((memSearchRes.data as any)?.results || []).length >= 1, "memory.search should find inserted memory");

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
