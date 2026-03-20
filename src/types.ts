// Import MemoryNamespace from shared config
import type {
	MemoryScope,
	MemorySourceType,
	MemoryType,
	PromotionState,
	MemoryNamespace as SharedMemoryNamespace,
} from "./shared/memory-config.js";

// Re-export for external use
export type { MemoryNamespace } from "./shared/memory-config.js";

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
	namespace: SharedMemoryNamespace;
	sessionId?: string;
	userId?: string;
	source_agent?: string;
	source_type?: MemorySourceType;
	memory_scope?: MemoryScope;
	memory_type?: MemoryType;
	promotion_state?: PromotionState;
	confidence?: number;
	metadata: Record<string, any>;
	timestamp: number;
	updatedAt?: number;
}

/** Memory payload structure for Qdrant */
export interface MemoryPayload {
	text: string;
	namespace: SharedMemoryNamespace;
	source_agent: string;
	source_type: MemorySourceType;
	userId: string;
	sessionId?: string;
	memory_scope?: MemoryScope;
	memory_type?: MemoryType;
	promotion_state?: PromotionState;
	timestamp: number;
	updatedAt?: number;
	confidence?: number;
	tags?: string[];
	metadata?: Record<string, any>;
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
	retryDelay: number;
	defaultNamespace: SharedMemoryNamespace;
	similarityThreshold: number;
}

// Tool Parameters
export interface StoreParams {
	text: string;
	namespace?: SharedMemoryNamespace;
	sessionId?: string;
	userId?: string;
	metadata?: Record<string, any>;
}

export interface SearchParams {
	query: string;
	limit?: number;
	namespace?: SharedMemoryNamespace;
	sessionId?: string;
	sessionMode?: "strict" | "soft";
	userId?: string;
	minScore?: number;
}

// Tool Output - Match AgentToolResult structure
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: unknown;
}

// Essence-Distiller Types (V2)
export type {
	DistillationConfig,
	DistillationPipeline,
	EssenceDocument,
	ExtractionResult,
} from "./types/essence-distiller.js";
