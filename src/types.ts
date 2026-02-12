// Qdrant Types
export interface Point {
  id: string;
  vector: number[];
  payload: Record<string, any>;
}

export interface ScoredPoint {
  id: string;
  version?: number;
  score: number;
  payload: Record<string, any>;
  vector?: number[];
}

export interface SearchResponse {
  result: ScoredPoint[];
  status?: string;
  time?: number;
}

// Memory Types
export interface MemoryEntry {
  id: string;
  text: string;
  namespace: string;
  sessionId?: string;
  userId?: string;
  metadata: Record<string, any>;
  timestamp: number;
  updatedAt?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// Plugin Config
export interface MemoryConfig {
  qdrantUrl: string;
  collectionName: string;
  vectorSize: number;
  embeddingApiUrl: string;
  timeout: number;
  maxRetries: number;
  defaultNamespace: string;
  similarityThreshold: number;
}

// Tool Parameters
export interface StoreParams {
  text: string;
  namespace?: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

export interface SearchParams {
  query: string;
  limit?: number;
  namespace?: string;
  sessionId?: string;
  userId?: string;
  minScore?: number;
}

// Tool Output
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
