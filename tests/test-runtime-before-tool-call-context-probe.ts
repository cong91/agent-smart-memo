import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function run() {
  const runtimeFile = resolve(
    process.cwd(),
    "node_modules/openclaw/dist/reply-DM7CfktL.js"
  );

  const content = readFileSync(runtimeFile, "utf8");

  assert(
    content.includes("hookRunner.runBeforeToolCall({"),
    "runtime must invoke runBeforeToolCall"
  );

  assert(
    content.includes("agentId: args.ctx?.agentId"),
    "runtime must pass ctx.agentId into before_tool_call context"
  );

  assert(
    content.includes("sessionKey: args.ctx?.sessionKey"),
    "runtime must pass ctx.sessionKey into before_tool_call context"
  );

  console.log("✅ runtime probe passed: before_tool_call context includes agentId + sessionKey");
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
