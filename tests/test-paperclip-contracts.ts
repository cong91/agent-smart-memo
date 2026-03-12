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

console.log("\n🎉 Paperclip contract tests passed\n");
