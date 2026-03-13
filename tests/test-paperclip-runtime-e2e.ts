import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ASM_MEMORY_TOOL_NAMES,
  createAsmMemoryWorker,
  createPaperclipRuntime,
  manifest,
  type HostWorkerInput,
} from "../src/entries/paperclip.js";
import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "../src/services/dedupe.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 Paperclip Runtime E2E Tests (CI-safe)\n");

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

function createCiSafeRuntime(_input?: HostWorkerInput) {
  const semanticUseCase = new SemanticMemoryUseCase(
    new MockQdrant() as any,
    new MockEmbedding() as any,
    new DeduplicationService(0.95, console),
  );

  return createPaperclipRuntime({
    stateDir: STATE_DIR,
    slotDbDir: SLOTDB_DIR,
    semanticUseCase,
  });
}

const runtime = createCiSafeRuntime();

const ctx = {
  userId: "paperclip-user-1",
  sessionId: "paperclip-session-1",
  workspaceId: "workspace-1",
  traceId: "trace-1",
};

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

const getRes = await runtime.adapter.execute({
  action: "slot.get",
  payload: { key: "project.current_task" },
  context: ctx,
});
assert(getRes.ok === true, "slot.get should succeed");
assert((getRes.data as any)?.value === "wire-memory-usecase-port", "slot.get should return stored value");

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

const worker = createAsmMemoryWorker(createCiSafeRuntime);
const initRes = worker.initialize({
  config: {
    runtime: {
      stateDir: STATE_DIR,
      slotDbDir: SLOTDB_DIR,
      qdrantHost: "ci-mock",
      embedBaseUrl: "ci-mock",
    },
  },
});
assert(initRes.ok === true, "worker initialize should succeed");
assert(worker.health().initialized === true, "worker health should report initialized");

const toolCaptureRes = await worker.executeTool(ASM_MEMORY_TOOL_NAMES.capture, {
  text: "Paperclip production worker captures from source entry",
  namespace: "assistant",
  context: {
    userId: "paperclip-user-2",
    sessionId: "paperclip-session-2",
    projectWorkspaceId: "workspace-2",
  },
});
assert(toolCaptureRes.ok === true, "worker memory_capture should succeed");

const toolRecallRes = await worker.executeTool(ASM_MEMORY_TOOL_NAMES.recall, {
  query: "captures from source entry",
  namespace: "assistant",
  minScore: 0.1,
  context: {
    userId: "paperclip-user-2",
    sessionId: "paperclip-session-2",
    projectWorkspaceId: "workspace-2",
  },
});
assert(toolRecallRes.ok === true, "worker memory_recall should succeed");
assert(Array.isArray((toolRecallRes.data as any)?.results), "worker memory_recall should return results array");

const eventAck = await worker.onEvent("activity.logged", {
  summary: "Captured from CI-safe activity event",
  context: {
    userId: "paperclip-user-3",
    sessionId: "paperclip-session-3",
    projectWorkspaceId: "workspace-3",
  },
  namespace: "assistant",
});
assert(eventAck.accepted === true, "activity.logged should be accepted");

const preview = await worker.getData("recall.preview", {
  query: "CI-safe activity event",
  context: {
    userId: "paperclip-user-3",
    sessionId: "paperclip-session-3",
    projectWorkspaceId: "workspace-3",
  },
  namespace: "assistant",
});
assert(preview.ok === true, "recall.preview should succeed");

assert(manifest.paperclipPlugin === undefined, "manifest stays host manifest object only");
assert(manifest.configSchema.fields.some((field) => field.key === "embedModel"), "manifest carries shared config field");

await worker.shutdown();
runtime.slotDb.close();
try {
  rmSync(TEST_ROOT, { recursive: true, force: true });
} catch {}

console.log("✅ Paperclip runtime e2e passed (CI-safe, deterministic, no localhost deps)\n");
