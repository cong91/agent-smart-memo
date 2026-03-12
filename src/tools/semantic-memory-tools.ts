import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  configureOpenClawRuntime,
  createOpenClawResult,
  getMemoryUseCasePortForContext,
  getSessionKey,
  parseOpenClawSessionIdentity,
} from "../adapters/openclaw/tool-runtime.js";
import type { SemanticMemoryUseCase } from "../core/usecases/semantic-memory-usecase.js";

function createResult(text: string, isError = false) {
  return createOpenClawResult(text, isError);
}

export function registerSemanticMemoryTools(
  api: OpenClawPluginApi,
  options?: {
    stateDir?: string;
    slotDbDir?: string;
    semanticUseCaseFactory?: (slotDbDir: string) => SemanticMemoryUseCase | undefined;
  },
): void {
  configureOpenClawRuntime(options);

  api.registerTool({
    name: "memory_store",
    label: "Memory Store",
    description: "Store a memory in the vector database. Automatically deduplicates similar content.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The content to remember" },
        namespace: { type: "string", description: "Namespace for organization" },
        sessionId: { type: "string", description: "Optional session ID" },
        userId: { type: "string", description: "Optional user ID" },
        metadata: { type: "object", description: "Additional metadata" },
      },
      required: ["text"],
    },
    async execute(_id: string, params: any, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<any, any>("memory.capture", {
          context: { userId, agentId, sessionId: params.sessionId },
          payload: {
            text: params.text,
            namespace: params.namespace,
            sessionId: params.sessionId,
            userId: params.userId,
            metadata: params.metadata,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_store",
            requestId: _id,
          },
        });

        const message = data.updated
          ? `Memory updated (duplicate detected, ID: ${data.id})`
          : `Memory stored successfully (ID: ${data.id})`;
        return createResult(message);
      } catch (error) {
        return createResult(`Error storing memory: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search stored memories by semantic similarity.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", minimum: 1, maximum: 20 },
        namespace: { type: "string" },
        sessionId: { type: "string" },
        userId: { type: "string" },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        sourceAgent: { type: "string" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<any, any>("memory.search", {
          context: { userId, agentId, sessionId: params.sessionId },
          payload: {
            query: params.query,
            limit: params.limit,
            namespace: params.namespace,
            sessionId: params.sessionId,
            userId: params.userId,
            minScore: params.minScore,
            sourceAgent: params.sourceAgent,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_search",
            requestId: _id,
          },
        });

        if (!data?.results || data.results.length === 0) {
          return createResult("No relevant memories found.");
        }

        const lines = data.results.map((r: any, i: number) => {
          const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "Unknown";
          return [
            `[${i + 1}] Score: ${(Number(r.score || 0) * 100).toFixed(1)}%`,
            `Namespace: ${r.namespace || "unknown"}`,
            `Text: ${r.text}`,
            `Date: ${date}`,
          ].join("\n");
        });

        return createResult(`Found ${data.results.length} relevant memories for "${data.query}":\n\n${lines.join("\n\n---\n\n")}`);
      } catch (error) {
        return createResult(`Error searching memories: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
}
