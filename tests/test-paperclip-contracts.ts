import {
  ASM_MEMORY_PLUGIN_ID,
  ASM_MEMORY_TOOL_NAMES,
  createAsmMemoryWorker,
  manifest,
} from "../src/entries/paperclip.js";
import { AGENT_MEMO_CONFIG_SCHEMA } from "../src/index.js";
import { PaperclipContextMapper } from "../src/adapters/paperclip/paperclip-context-mapper.js";
import { PaperclipErrorPresenter } from "../src/adapters/paperclip/paperclip-error-presenter.js";
import { PaperclipAdapter } from "../src/adapters/paperclip/paperclip-adapter.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 Paperclip Adapter Contract Tests\n");

const mapper = new PaperclipContextMapper();
const ctx = mapper.toMemoryContext({
  userId: "u1",
  sessionId: "s1",
  workspaceId: "w1",
  traceId: "t1",
  locale: "vi",
});
assert(ctx.userId === "u1", "userId mapping");
assert(ctx.agentId === "paperclip", "agentId mapping");
assert(ctx.sessionId === "s1", "sessionId mapping");
assert(ctx.traceId === "t1", "traceId mapping");
console.log("✅ context mapping");

const ns = mapper.toNamespace("shared.project_context");
assert(ns === "shared.project_context", "namespace mapping");
console.log("✅ namespace mapping");

const presenter = new PaperclipErrorPresenter();
const err = presenter.fromMemoryError(new Error("Unknown namespace: x"));
assert(err.code === "VALIDATION_ERROR", "validation error mapping");
console.log("✅ error presenter mapping");

const adapter = new PaperclipAdapter({
  async run(_useCase, req) {
    return { received: req.meta?.source, session: req.context.sessionId };
  },
});

const ok = await adapter.execute({
  action: "slot.get",
  payload: { key: "project.current" },
  context: { userId: "u2", sessionId: "s2" },
});
assert(ok.ok === true, "adapter execute ok");
assert((ok.data as any).received === "paperclip", "meta source mapped");
console.log("✅ adapter execute success path");

assert(manifest.id === ASM_MEMORY_PLUGIN_ID, "manifest plugin id");
assert(manifest.tools.some((tool) => tool.name === ASM_MEMORY_TOOL_NAMES.capture), "manifest contains capture tool");
assert(Array.isArray(manifest.configSchema.fields), "manifest config schema has fields");
assert(manifest.configSchema.fields.some((field) => field.key === "llmBaseUrl"), "manifest config derives from shared schema");
assert(Object.keys(AGENT_MEMO_CONFIG_SCHEMA.properties).includes("qdrantHost"), "shared config schema exported");
console.log("✅ shared config contract + manifest wiring");

const worker = createAsmMemoryWorker();
const initRes = worker.initialize({
  config: {
    runtime: {
      stateDir: "/tmp/asm-paperclip-contract-state",
      slotDbDir: "/tmp/asm-paperclip-contract-slotdb",
    },
  },
});
assert(initRes.ok === true, "worker initialize ok");
assert(worker.health().initialized === true, "worker health initialized true");
console.log("✅ worker lifecycle exports");

console.log("\n🎉 Paperclip contract tests passed\n");
