import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const workerPath = join(root, "packages", "plugins", "agent-smart-memo", "dist", "worker.js");
const manifestPath = join(root, "packages", "plugins", "agent-smart-memo", "dist", "manifest.js");

if (!existsSync(workerPath) || !existsSync(manifestPath)) {
  console.error("[smoke] Missing plugin dist files. Build plugin dist first.");
  console.error("Expected:", workerPath, manifestPath);
  process.exit(1);
}

const workerMod = await import(pathToFileURL(workerPath).href);
const manifestMod = await import(pathToFileURL(manifestPath).href);
const createAsmMemoryWorker = workerMod.createAsmMemoryWorker;
const manifest = manifestMod.manifest;

assert(typeof createAsmMemoryWorker === "function", "createAsmMemoryWorker export missing");
assert(manifest?.id === "@paperclip/plugin-asm-memory", "manifest id mismatch");
console.log("✅ plugin load: manifest + worker exports are readable");

const sandboxRoot = mkdtempSync(join(tmpdir(), "asm-paperclip-smoke-"));
const fallbackRoot = join(sandboxRoot, "skills", "para-memory-files");

const worker = createAsmMemoryWorker();

logStep("worker initialize + config validation");
const init = worker.initialize({
  config: {
    enabled: true,
    capture: { mode: "event+batch", minConfidence: 0.62, maxItemsPerRun: 12, dedupWindowHours: 72 },
    recall: { topK: 8, minScore: 0.3 },
    markdownFallback: { enabled: true, rootDir: fallbackRoot },
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
});
assert(recall?.ok === true, "memory_recall failed");
const recalledItems = recall?.data?.items ?? [];
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

logStep("markdown fallback guard (must not override source-of-truth)");
const fallbackCapture = await worker.executeTool("memory_capture", {
  text: "Force fallback entry for markdown queue",
  source: "smoke-test",
  confidence: 0.2,
  forceFallback: true,
  context: sharedContext,
});
assert(fallbackCapture?.ok === true, "fallback capture should succeed");
assert(fallbackCapture?.decision === "deferred", "fallback capture should be deferred");

const fallbackQueue = await worker.getData("fallback.queue", { context: sharedContext });
const pending = fallbackQueue?.data ?? [];
assert(Array.isArray(pending) && pending.length >= 1, "fallback queue should contain pending entries");

const fallbackSync = await worker.runJob("asm_fallback_sync", {});
assert(fallbackSync?.ok === true, "fallback sync should succeed");

const recallAfterFallback = await worker.executeTool("memory_recall", {
  query: "Force fallback entry",
  context: sharedContext,
});
const fallbackItems = recallAfterFallback?.data?.items ?? [];
assert(Array.isArray(fallbackItems), "recall after fallback invalid payload");
assert(
  !fallbackItems.some((item) => String(item?.text || "").includes("Force fallback entry")),
  "fallback markdown entry must not appear as source-of-truth recall item"
);

const fallbackFile = join(fallbackRoot, "fallback", "capture-queue", `${new Date().toISOString().slice(0, 10)}.md`);
assert(existsSync(fallbackFile), "fallback markdown file missing");
const fallbackContent = readFileSync(fallbackFile, "utf8");
assert(fallbackContent.includes("capture.deferred"), "fallback markdown file missing capture.deferred marker");
console.log("✅ markdown fallback queued without overriding source-of-truth");

console.log("\n🎉 Paperclip local smoke/debug passed");
console.log(`[smoke] sandboxRoot=${sandboxRoot}`);

try {
  rmSync(sandboxRoot, { recursive: true, force: true });
} catch {
  // no-op
}
