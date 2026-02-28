import { QdrantClient } from "../services/qdrant.js";
import { EmbeddingClient } from "../services/embedding.js";
import { SearchParams, ToolResult, ScoredPoint, MemoryNamespace } from "../types.js";
import { getAgentNamespaces } from "../shared/memory-config.js";

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
      description: "Filter by namespace (default: auto-detected from agent)",
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
    sourceAgent: {
      type: "string",
      description: "Filter by source agent ID",
    },
  },
  required: ["query"],
};

export function createMemorySearchTool(
  qdrant: QdrantClient,
  embedding: EmbeddingClient,
  defaultNamespace: MemoryNamespace
) {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search stored memories by semantic similarity. Returns most relevant past information.",
    parameters: memorySearchSchema,
    
    async execute(
      _id: string, 
      params: SearchParams & { sourceAgent?: string; agentId?: string },
      _signal?: AbortSignal
    ): Promise<ToolResult> {
      try {
        // Validate
        if (!params.query || typeof params.query !== "string") {
          return {
            content: [{ type: "text", text: "Error: query is required" }],
            isError: true,
            details: { error: "Missing query parameter" },
          };
        }
        
        const query = params.query.trim();
        if (query.length === 0) {
          return {
            content: [{ type: "text", text: "Error: query cannot be empty" }],
            isError: true,
            details: { error: "Empty query" },
          };
        }
        
        const limit = Math.min(Math.max(params.limit || 5, 1), 20);
        const minScore = params.minScore ?? 0.7;
        
        // Determine namespaces to search
        const agentId = params.agentId || "";
        const namespaces: MemoryNamespace[] = params.namespace 
          ? [params.namespace as MemoryNamespace]
          : getAgentNamespaces(agentId);
        
        // Build namespace filter (OR if multiple namespaces)
        const namespaceConditions = namespaces.map(ns => ({
          key: "namespace",
          match: { value: ns },
        }));
        
        const filterConditions: any[] = [];
        
        if (namespaceConditions.length === 1) {
          filterConditions.push(namespaceConditions[0]);
        } else if (namespaceConditions.length > 1) {
          filterConditions.push({ should: namespaceConditions });
        }
        
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
        
        if (params.sourceAgent) {
          filterConditions.push({
            key: "source_agent",
            match: { value: params.sourceAgent },
          });
        }
        
        const filter = filterConditions.length > 0 ? { must: filterConditions } : undefined;
        
        // Generate embedding and search
        const vector = await embedding.embed(query);
        const results = await qdrant.search(vector, limit, filter);
        
        // Filter by minScore
        const filtered = results.filter((r: ScoredPoint) => r.score >= minScore);
        
        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0, query },
          };
        }
        
        // Format results
        const formatted = filtered.map((r: ScoredPoint, i: number) => {
          const payload = r.payload;
          const date = payload.timestamp 
            ? new Date(payload.timestamp).toLocaleDateString() 
            : "Unknown";
          
          const lines = [
            `[${i + 1}] Score: ${(r.score * 100).toFixed(1)}%`,
            `Namespace: ${payload.namespace || "unknown"}`,
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
          details: { count: filtered.length, query, results: filtered },
        };
        
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error searching memories: ${error.message}` }],
          isError: true,
          details: { error: error.message },
        };
      }
    },
  };
}
