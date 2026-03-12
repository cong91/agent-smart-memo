import { registerMemoryToolContextInjector } from "../src/hooks/tool-context-injector.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
}

type BeforeToolCallHandler = (event: any, ctx: any) => Promise<any> | any;

class MockApi {
  public beforeToolCallHandler: BeforeToolCallHandler | null = null;

  on(eventName: string, handler: BeforeToolCallHandler) {
    if (eventName === "before_tool_call") {
      this.beforeToolCallHandler = handler;
    }
  }
}

async function run() {
  const api = new MockApi();
  registerMemoryToolContextInjector(api as any);

  assert(api.beforeToolCallHandler, "before_tool_call handler must be registered");

  const handler = api.beforeToolCallHandler!;

  const assistant = await handler(
    { toolName: "memory_store", params: { text: "a1" } },
    { agentId: "assistant", sessionKey: "agent:assistant:main" }
  );
  assertEqual(assistant.params.agentId, "assistant", "assistant agentId must be injected");
  assertEqual(assistant.params.namespace, "agent.assistant.working_memory", "assistant default namespace must be canonical");

  const scrum = await handler(
    { toolName: "memory_store", params: { text: "s1" } },
    { agentId: "scrum", sessionKey: "agent:scrum:main" }
  );
  assertEqual(scrum.params.agentId, "scrum", "scrum agentId must be injected");
  assertEqual(scrum.params.namespace, "agent.scrum.working_memory", "scrum default namespace must be canonical");

  const fullstack = await handler(
    { toolName: "memory_search", params: { query: "f1" } },
    { agentId: "fullstack", sessionKey: "agent:fullstack:main" }
  );
  assertEqual(fullstack.params.agentId, "fullstack", "fullstack agentId must be injected");

  // preserve explicit params from caller
  const keepExplicit = await handler(
    {
      toolName: "memory_store",
      params: {
        text: "x",
        agentId: "fullstack",
        namespace: "shared.project_context",
        userId: "u-1",
      },
    },
    { agentId: "assistant", sessionKey: "agent:assistant:main" }
  );

  assertEqual(keepExplicit.params.agentId, "fullstack", "explicit agentId must be preserved");
  assertEqual(keepExplicit.params.namespace, "shared.project_context", "explicit namespace must be preserved");
  assertEqual(keepExplicit.params.userId, "u-1", "explicit userId must be preserved");

  console.log("✅ tool-context-injector assistant/scrum/fullstack tests passed");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
