import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label) {
  console.log(`\n[smoke] ${label}`);
}

const root = process.cwd();
const entryPath = join(root, "dist-paperclip", "entries", "paperclip.js");

if (!existsSync(entryPath)) {
  console.error("[smoke] Missing paperclip entry build output. Run npm run build:paperclip first.");
  console.error("Expected:", entryPath);
  process.exit(1);
}

const entryMod = await import(pathToFileURL(entryPath).href);
const createAsmMemoryWorker = entryMod.createAsmMemoryWorker;
const manifest = entryMod.manifest;

assert(typeof createAsmMemoryWorker === "function", "createAsmMemoryWorker export missing");
assert(manifest?.id === "@paperclip/plugin-asm-memory", "manifest id mismatch");
console.log("✅ plugin load: manifest + worker exports are readable");

const sandboxRoot = mkdtempSync(join(tmpdir(), "asm-paperclip-smoke-"));

const worker = createAsmMemoryWorker();

logStep("worker initialize + config validation");
const init = worker.initialize({
  config: {
    enabled: true,
    capture: { mode: "event+batch", minConfidence: 0.62, maxItemsPerRun: 12, dedupWindowHours: 72 },
    recall: { topK: 8, minScore: 0.3 },
  },
});
assert(init?.ok === true, "worker initialize failed");
const health = worker.health();
assert(health?.ok === true && health?.initialized === true, "worker health check failed");
console.log("✅ worker start + health ok");

logStep("memory_capture + memory_recall");
const sharedContext = {
  companyId: "cmp-local",
  projectId: "prj-local",
  agentId: "agent-local",
  runId: "run-local",
  projectWorkspaceId: "ws-local",
  sessionDisplayId: "session-local",
};

const capture = await worker.executeTool("memory_capture", {
  text: "Remember: always include correlationId in Paperclip runtime traces",
  source: "smoke-test",
  confidence: 0.95,
  context: sharedContext,
});
assert(capture?.ok === true, "memory_capture failed");
assert(capture?.decision === "accepted", "memory_capture should be accepted");

const recall = await worker.executeTool("memory_recall", {
  query: "correlationId runtime traces",
  context: sharedContext,
  minScore: 0,
});
assert(recall?.ok === true, "memory_recall failed");
const recalledItems = recall?.data?.results ?? recall?.data?.items ?? [];
assert(Array.isArray(recalledItems) && recalledItems.length >= 1, "memory_recall returned no items");
console.log("✅ memory_capture + memory_recall ok");

logStep("event hook response (activity.logged)");
const eventAck = await worker.onEvent("activity.logged", {
  summary: "Captured from activity event",
  context: sharedContext,
});
assert(eventAck?.accepted === true, "activity.logged should be accepted");
console.log("✅ event hook accepted");

logStep("job hook response");
const jobAck = await worker.runJob("asm_capture_compact", {});
assert(jobAck?.ok === true, "asm_capture_compact should succeed");
console.log("✅ job hook ack ok");

logStep("basic worker action surface");
const feedback = await worker.executeTool("memory_feedback", {
  memoryId: "memory-1",
  feedback: "upvote",
  reason: "smoke",
  context: sharedContext,
});
assert(feedback?.ok === true, "memory_feedback should succeed");

const fallbackSync = await worker.runJob("asm_fallback_sync", {});
assert(fallbackSync?.ok === true, "asm_fallback_sync should succeed");
console.log("✅ action + job surface ok");

console.log("\n🎉 Paperclip local smoke/debug passed");
console.log(`[smoke] sandboxRoot=${sandboxRoot}`);

try {
  rmSync(sandboxRoot, { recursive: true, force: true });
} catch {
  // no-op
}
