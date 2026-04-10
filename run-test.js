import { registerSemanticMemoryTools } from "./src/tools/semantic-memory-tools.js";
import { SemanticMemoryUseCase } from "./src/core/usecases/semantic-memory-usecase.js";
import { DeduplicationService } from "./src/services/dedupe.js";

class MockApi {
  tools = new Map();
  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }
}
async function run() {
  const api = new MockApi();
  const semantic = new SemanticMemoryUseCase();

  registerSemanticMemoryTools(api, {
    semanticUseCaseFactory: () => semantic,
  });

  const store = api.tools.get("memory_store");
  const ctx = { sessionKey: "agent:assistant:u-test" };

  const storeRes = await store.execute("1", {
    text: "OpenClaw tool path now uses MemoryUseCase semantic execution",
    namespace: "assistant",
  }, ctx);
  console.log("storeRes:", JSON.stringify(storeRes));
}
run();
