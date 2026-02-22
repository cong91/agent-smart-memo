import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { DeduplicationService } from "../services/dedupe.js";
import { StoreParams, ToolResult, Point } from "../types.js";

export const memoryStoreSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The content to remember",
    },
    namespace: {
      type: "string",
      description: "Namespace for organization (default: 'default')",
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
  defaultNamespace: string
) {
  return {
    name: "memory_store",
    label: "Memory Store",
    description: "Store a memory in the vector database. Automatically deduplicates similar content.",
    parameters: memoryStoreSchema,
    
    async execute(_id: string, params: StoreParams): Promise<ToolResult> {
      try {
        // Validate
        if (!params.text || typeof params.text !== "string") {
          return {
            content: [{ type: "text", text: "Error: text is required" }],
            isError: true,
            details: { error: "Missing text parameter" },
          };
        }
        
        const text = params.text.trim();
        if (text.length === 0) {
          return {
            content: [{ type: "text", text: "Error: text cannot be empty" }],
            isError: true,
            details: { error: "Empty text" },
          };
        }
        
        if (text.length > 10000) {
          return {
            content: [{ type: "text", text: "Error: text exceeds 10000 character limit" }],
            isError: true,
            details: { error: "Text too long", length: text.length },
          };
        }
        
        const namespace = params.namespace || defaultNamespace;
        
        // Generate embedding
        const vector = await embedding.embed(text);
        
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
              sessionId: params.sessionId || null,
              userId: params.userId || null,
              metadata: params.metadata || {},
              timestamp: Date.now(),
              updatedAt: Date.now(),
            },
          };
          
          await qdrant.upsert([point]);
          
          return {
            content: [{ type: "text", text: `Memory updated (duplicate detected, ID: ${duplicateId})` }],
            details: { id: duplicateId, updated: true },
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
            sessionId: params.sessionId || null,
            userId: params.userId || null,
            metadata: params.metadata || {},
            timestamp: Date.now(),
          },
        };
        
        await qdrant.upsert([point]);
        
        return {
          content: [{ type: "text", text: `Memory stored successfully (ID: ${id})` }],
          details: { id, created: true },
        };
        
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error storing memory: ${error.message}` }],
          isError: true,
          details: { error: error.message },
        };
      }
    },
  };
}
