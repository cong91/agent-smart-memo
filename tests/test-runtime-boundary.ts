import {
  createInitialRuntimeConfig,
  createToolTextResult,
  parseSessionIdentity,
  resolveSlotDbDirForContext,
} from "../src/core/runtime-boundary.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 Runtime Boundary Core Tests\n");

// parseSessionIdentity keeps legacy defaults
{
  const parsed = parseSessionIdentity("agent:fullstack:telegram:dm:123");
  assert(parsed.agentId === "fullstack", "agentId must be parsed from session key");
  assert(parsed.userId === "telegram:dm:123", "userId must include remaining session segments");
  console.log("✅ parseSessionIdentity parses full session");
}

{
  const parsed = parseSessionIdentity(undefined);
  assert(parsed.agentId === "main", "default agentId must remain main");
  assert(parsed.userId === "default", "default userId must remain default");
  console.log("✅ parseSessionIdentity keeps backward-compatible defaults");
}

// resolveSlotDbDirForContext keeps precedence semantics (context over runtime base)
{
  const runtime = {
    stateDir: "/tmp/runtime-state",
    slotDbDir: "/tmp/runtime-state/agent-memo",
  };

  const ctx = {
    stateDir: "/tmp/context-state",
    pluginConfig: {
      slotDbDir: "/tmp/context-slotdb",
    },
  };

  const resolved = resolveSlotDbDirForContext(ctx, runtime);
  assert(resolved === "/tmp/context-slotdb", "context pluginConfig.slotDbDir must win");
  console.log("✅ resolveSlotDbDirForContext honors context plugin slotDbDir");
}

// createInitialRuntimeConfig returns non-empty defaults
{
  const cfg = createInitialRuntimeConfig();
  assert(typeof cfg.stateDir === "string" && cfg.stateDir.length > 0, "stateDir must be non-empty");
  assert(typeof cfg.slotDbDir === "string" && cfg.slotDbDir.length > 0, "slotDbDir must be non-empty");
  console.log("✅ createInitialRuntimeConfig returns valid defaults");
}

// createToolTextResult shape compatibility
{
  const res = createToolTextResult("ok");
  assert(Array.isArray(res.content), "content must be array");
  assert((res.content[0] as any).text === "ok", "text payload must match");
  assert((res.details as any)?.toolResult?.text === "ok", "details.toolResult.text must match");
  console.log("✅ createToolTextResult preserves tool result shape");
}

console.log("\n🎉 Runtime boundary core tests passed\n");
