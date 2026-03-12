import {
  configureOpenClawRuntime,
  createOpenClawResult,
  getSessionKey,
  parseOpenClawSessionIdentity,
} from "../src/adapters/openclaw/tool-runtime.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 OpenClaw Adapter Contract Tests\n");

configureOpenClawRuntime({ stateDir: "/tmp/openclaw-state", slotDbDir: "/tmp/openclaw-slotdb" });

{
  const sessionKey = getSessionKey({ sessionKey: "agent:fullstack:telegram:group:123" });
  assert(sessionKey === "agent:fullstack:telegram:group:123", "must read ctx.sessionKey");
  const parsed = parseOpenClawSessionIdentity(sessionKey);
  assert(parsed.agentId === "fullstack", "agentId parse");
  assert(parsed.userId === "telegram:group:123", "userId parse");
  console.log("✅ session identity mapping");
}

{
  const fallbackKey = getSessionKey({});
  assert(fallbackKey === "agent:main:default", "fallback session key");
  console.log("✅ fallback session key");
}

{
  const r = createOpenClawResult("ok", false);
  assert(Array.isArray(r.content) && (r.content[0] as any).text === "ok", "content shape");
  assert((r.details as any)?.toolResult?.text === "ok", "details shape");
  assert(r.isError === false, "isError default false");
  console.log("✅ tool result contract shape");
}

console.log("\n🎉 OpenClaw adapter contract tests passed\n");
