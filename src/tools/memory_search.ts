import { QdrantClient } from "../services/qdrant";
import { EmbeddingClient } from "../services/embedding";
import { SearchParams, ToolResult, MemoryEntry, ScoredPoint } from "../types";

export const memorySearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query for relevant memories",
    },
    limit: {
      type: "number",
      description: "Max results (default: 5)",
      minimum: 1,
      maximum: 20,
    },
    namespace: {
      type: "string",
      description: "Filter by namespace",
    },
    sessionId: {
      type: "string",
      description: "Filter by session ID",
    },
    userId: {
      type: "string",
      description: "Filter by user ID",
    },
    minScore: {
      type: "number",
      description: "Minimum similarity score (0-1, default: 0.7)",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["query"],
};

export function createMemorySearchTool(
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  defaultNamespace: string
) {
  return {
    name: "memory_search",
    description: "Search stored memories by semantic similarity. Returns most relevant past information.",
    parameters: memorySearchSchema,
    
    async execute(_id: string, params: SearchParams): Promise<ToolResult> {
      try {
        // Validate
        if (!params.query || typeof params.query !== "string") {
          return {
            content: [{ type: "text", text: "Error: query is required" }],
            isError: true,
          };
        }
        
        const query = params.query.trim();
        if (query.length === 0) {
          return {
            content: [{ type: "text", text: "Error: query cannot be empty" }],
            isError: true,
          };
        }
        
        const limit = Math.min(Math.max(params.limit || 5, 1), 20);
        const namespace = params.namespace || defaultNamespace;
        const minScore = params.minScore ?? 0.7;
        
        // Build filter
        const filterConditions: any[] = [
          { key: "namespace", match: { value: namespace } },
        ];
        
        if (params.sessionId) {
          filterConditions.push({
            key: "sessionId",
            match: { value: params.sessionId },
          });
        }
        
        if (params.userId) {
          filterConditions.push({
            key: "userId",
            match: { value: params.userId },
          });
        }
        
        const filter = filterConditions.length > 0 ? { must: filterConditions } : undefined;
        
        // Generate embedding and search
        const vector = await embedding.embed(query);
        const results = await qdrant.search(vector, limit, filter);
        
        // Filter by minScore
        const filtered = results.filter(r => r.score >= minScore);
        
        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
          };
        }
        
        // Format results
        const formatted = filtered.map((r, i) => {
          const payload = r.payload;
          const date = payload.timestamp 
            ? new Date(payload.timestamp).toLocaleDateString() 
            : "Unknown";
          
          const lines = [
            `[${i + 1}] Score: ${(r.score * 100).toFixed(1)}%`,
            `Text: ${payload.text}`,
            `Date: ${date}`,
          ];
          
          if (payload.metadata && Object.keys(payload.metadata).length > 0) {
            lines.push(`Metadata: ${JSON.stringify(payload.metadata)}`);
          }
          
          return lines.join("\n");
        }).join("\n\n---\n\n");
        
        return {
          content: [{
            type: "text",
            text: `Found ${filtered.length} relevant memories for "${query}":\n\n${formatted}`,
          }],
        };
        
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error searching memories: ${error.message}` }],
          isError: true,
        };
      }
    },
  };
}
