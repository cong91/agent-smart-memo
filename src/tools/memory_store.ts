import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { DeduplicationService } from "../services/dedupe.js";
import { StoreParams, ToolResult, Point, MemoryNamespace } from "../types.js";
import { normalizeNamespace, toCoreAgent, evaluateNoiseV2 } from "../shared/memory-config.js";

export const memoryStoreSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The content to remember",
    },
    namespace: {
      type: "string",
      description: "Namespace for organization (default: 'shared.project_context')",
    },
    sessionId: {
      type: "string",
      description: "Optional session ID for context isolation",
    },
    userId: {
      type: "string",
      description: "Optional user ID for multi-user systems",
    },
    metadata: {
      type: "object",
      description: "Additional metadata to store",
    },
  },
  required: ["text"],
};

export function createMemoryStoreTool(
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  dedupe: DeduplicationService,
  defaultNamespace: MemoryNamespace
) {
  const createDetails = (text: string, extra: Record<string, unknown> = {}) => ({
    ...extra,
    toolResult: { text },
  });

  return {
    name: "memory_store",
    label: "Memory Store",
    description: "Store a memory in the vector database. Automatically deduplicates similar content.",
    parameters: memoryStoreSchema,
    
    async execute(
      _id: string, 
      params: StoreParams & { agentId?: string },
      _signal?: AbortSignal
    ): Promise<ToolResult> {
      try {
        // Validate
        if (!params.text || typeof params.text !== "string") {
          return {
            content: [{ type: "text", text: "Error: text is required" }],
            isError: true,
            details: createDetails("Error: text is required", { error: "Missing text parameter" }),
          };
        }
        
        const text = params.text.trim();
        if (text.length === 0) {
          return {
            content: [{ type: "text", text: "Error: text cannot be empty" }],
            isError: true,
            details: createDetails("Error: text cannot be empty", { error: "Empty text" }),
          };
        }
        
        if (text.length > 10000) {
          return {
            content: [{ type: "text", text: "Error: text exceeds 10000 character limit" }],
            isError: true,
            details: createDetails("Error: text exceeds 10000 character limit", { error: "Text too long", length: text.length }),
          };
        }
        
        // Namespace router + normalization policy (ASM-5)
        const agentId = params.agentId || "assistant";
        const sourceAgent = toCoreAgent(agentId);
        const requestedNamespace = (params.namespace as string) || defaultNamespace;
        let namespace = normalizeNamespace(requestedNamespace, sourceAgent);

        // Noise policy v2: quarantine noisy content into noise.filtered
        const noise = evaluateNoiseV2(text, "tool_call");
        if (noise.isNoise) {
          namespace = "noise.filtered" as MemoryNamespace;
        }
        
        // Generate embedding (chunking + weighted average)
        const embeddingResult = typeof (embedding as any).embedDetailed === "function"
          ? await (embedding as any).embedDetailed(text)
          : {
              vector: await embedding.embed(text),
              metadata: {
                embedding_chunked: false,
                embedding_chunks_count: 1,
                embedding_chunking_strategy: "array_batch_weighted_avg",
                embedding_model: "unknown",
                embedding_model_key: "unknown",
                embedding_provider: "auto",
                embedding_max_tokens: 0,
                embedding_safe_chunk_tokens: 0,
                embedding_source: "docs",
                embedding_fallback_hash: false,
              },
            };
        const vector = embeddingResult.vector;
        
        // Check for duplicates
        const candidates = await qdrant.search(vector, 5, {
          must: [
            { key: "namespace", match: { value: namespace } },
          ],
        });
        
        const duplicateId = dedupe.findDuplicate(text, candidates);
        
        if (duplicateId) {
          // Update existing memory
          const point: Point = {
            id: duplicateId,
            vector,
            payload: {
              text,
              namespace,
              agent: sourceAgent,
              source_agent: sourceAgent,
              source_type: "tool_call" as const,
              sessionId: params.sessionId || null,
              userId: params.userId || null,
              metadata: {
                ...(params.metadata || {}),
                ...embeddingResult.metadata,
                noise_score: noise.score,
                noise_matched_patterns: noise.matchedPatterns,
              },
              ...embeddingResult.metadata,
              timestamp: Date.now(),
              noise_score: noise.score,
              updatedAt: Date.now(),
            },
          };
          
          await qdrant.upsert([point]);
          
          const textOut = `Memory updated (duplicate detected, ID: ${duplicateId})`;
          return {
            content: [{ type: "text", text: textOut }],
            details: createDetails(textOut, { id: duplicateId, updated: true }),
          };
        }
        
        // Create new memory with UUID v4
        const id = crypto.randomUUID();
        
        const point: Point = {
          id,
          vector,
          payload: {
            text,
            namespace,
            agent: sourceAgent,
            source_agent: sourceAgent,
            source_type: "tool_call" as const,
            sessionId: params.sessionId || null,
            userId: params.userId || null,
            metadata: {
              ...(params.metadata || {}),
              ...embeddingResult.metadata,
              noise_score: noise.score,
              noise_matched_patterns: noise.matchedPatterns,
            },
            ...embeddingResult.metadata,
            timestamp: Date.now(),
            noise_score: noise.score,
          },
        };
        
        await qdrant.upsert([point]);
        
        const textOut = `Memory stored successfully (ID: ${id})`;
        return {
          content: [{ type: "text", text: textOut }],
          details: createDetails(textOut, { id, created: true }),
        };
        
      } catch (error: any) {
        const textOut = `Error storing memory: ${error.message}`;
        return {
          content: [{ type: "text", text: textOut }],
          isError: true,
          details: createDetails(textOut, { error: error.message }),
        };
      }
    },
  };
}
