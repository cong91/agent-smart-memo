import type { DeduplicationService } from "../../services/dedupe.js";
import type { EmbeddingClient } from "../../services/embedding.js";
import type { QdrantClient } from "../../services/qdrant.js";
import {
	getAgentNamespaces,
	type MemoryNamespace,
	parseExplicitNamespace,
	resolveDefaultConfidence,
	resolveMemoryScopeFromNamespace,
	resolveMemoryTypeFromNamespace,
	toCoreAgent,
} from "../../shared/memory-config.js";
import type { ScoredPoint } from "../../types.js";
import type { MemoryContext } from "../contracts/adapter-contracts.js";
import {
	normalizeSessionToken,
	resolveSessionMode,
	scoreSemanticCandidate,
	shouldApplyStrictSessionFilter,
} from "../retrieval-policy.js";

export interface MemoryCapturePayload {
	text: string;
	namespace?: string;
	sessionId?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
}

export interface MemorySearchPayload {
	query: string;
	limit?: number;
	minScore?: number;
	namespace?: string;
	sessionId?: string;
	sessionMode?: "strict" | "soft";
	userId?: string;
	sourceAgent?: string;
}

export interface MemoryCaptureResult {
	id: string;
	created: boolean;
	updated: boolean;
	namespace: MemoryNamespace;
	score?: number;
}

export interface MemorySearchResult {
	query: string;
	count: number;
	results: Array<{
		id: string;
		score: number;
		rawScore: number;
		text: string;
		namespace: string;
		timestamp?: number;
		metadata?: Record<string, unknown>;
	}>;
}

export class SemanticMemoryUseCase {
	constructor(
		private readonly qdrant: QdrantClient,
		private readonly embedding: EmbeddingClient,
		private readonly dedupe: DeduplicationService,
	) {}

	async capture(
		payload: MemoryCapturePayload,
		context: MemoryContext,
	): Promise<MemoryCaptureResult> {
		if (
			!payload?.text ||
			typeof payload.text !== "string" ||
			payload.text.trim().length === 0
		) {
			throw new Error("memory.capture requires payload.text");
		}

		const text = payload.text.trim();
		const sourceAgent = toCoreAgent(context.agentId || "assistant");
		const namespace = this.resolveNamespace(payload.namespace, sourceAgent);
		const memoryScope = resolveMemoryScopeFromNamespace(namespace);
		const memoryType = resolveMemoryTypeFromNamespace(namespace);
		const promotionState = "raw" as const;
		const defaultConfidence = resolveDefaultConfidence("manual");

		const embeddingResult = await this.embedDetailedCompat(text);
		const vector = embeddingResult.vector;

		const existing = await this.qdrant.search(vector, 5, {
			must: [{ key: "namespace", match: { value: namespace } }],
		});

		const duplicateId = this.dedupe.findDuplicate(text, existing);
		const id = duplicateId || crypto.randomUUID();
		const now = Date.now();

		await this.qdrant.upsert([
			{
				id,
				vector,
				payload: {
					text,
					namespace,
					agent: sourceAgent,
					source_agent: sourceAgent,
					source_type: "manual",
					memory_scope: memoryScope,
					memory_type: memoryType,
					promotion_state: promotionState,
					confidence: defaultConfidence,
					sessionId: payload.sessionId || context.sessionId || null,
					userId: payload.userId || context.userId || null,
					metadata: {
						...(payload.metadata || {}),
						...embeddingResult.metadata,
					},
					...embeddingResult.metadata,
					timestamp: now,
					...(duplicateId ? { updatedAt: now } : {}),
				},
			},
		]);

		return {
			id,
			created: !duplicateId,
			updated: Boolean(duplicateId),
			namespace,
		};
	}

	async search(
		payload: MemorySearchPayload,
		context: MemoryContext,
	): Promise<MemorySearchResult> {
		if (
			!payload?.query ||
			typeof payload.query !== "string" ||
			payload.query.trim().length === 0
		) {
			throw new Error("memory.search requires payload.query");
		}

		const query = payload.query.trim();
		const sourceAgent = toCoreAgent(context.agentId || "assistant");
		const minScore =
			typeof payload.minScore === "number" ? payload.minScore : 0.7;
		const sessionMode = resolveSessionMode(payload.sessionMode);
		const preferredSessionId = normalizeSessionToken(
			payload.sessionId || context.sessionId,
		);
		const limit = Math.min(Math.max(payload.limit || 5, 1), 20);
		const namespaces = payload.namespace
			? [this.resolveNamespace(payload.namespace, sourceAgent)]
			: getAgentNamespaces(sourceAgent);

		const namespaceFilter = namespaces.length === 1 ? namespaces[0] : null;

		const filterMust: any[] = [];
		if (namespaceFilter) {
			filterMust.push({ key: "namespace", match: { value: namespaceFilter } });
		} else {
			filterMust.push({
				should: namespaces.map((ns) => ({
					key: "namespace",
					match: { value: ns },
				})),
			});
		}

		if (
			shouldApplyStrictSessionFilter(
				sessionMode,
				payload.sessionId || context.sessionId,
			)
		) {
			filterMust.push({
				key: "sessionId",
				match: { value: payload.sessionId || context.sessionId },
			});
		}

		if (payload.userId || context.userId) {
			filterMust.push({
				key: "userId",
				match: { value: payload.userId || context.userId },
			});
		}

		if (payload.sourceAgent) {
			filterMust.push({
				key: "source_agent",
				match: { value: payload.sourceAgent },
			});
		}

		const vector = await this.embedding.embed(query);
		const points = await this.qdrant.search(vector, limit, {
			must: filterMust,
		});

		const weighted = points
			.filter(
				(r: ScoredPoint) => (r.payload?.namespace || "") !== "noise.filtered",
			)
			.map((r: ScoredPoint) => {
				const ns = String(r.payload?.namespace || "");
				const scored = scoreSemanticCandidate({
					rawScore: r.score,
					agentId: sourceAgent,
					namespace: ns,
					sessionMode,
					preferredSessionId,
					payloadSessionId: r.payload?.sessionId,
					promotionState: r.payload?.promotion_state,
				});
				return {
					id: String(r.id),
					rawScore: r.score,
					score: scored.finalScore,
					text: String(r.payload?.text || ""),
					namespace: ns,
					timestamp:
						typeof r.payload?.timestamp === "number"
							? r.payload.timestamp
							: undefined,
					metadata: (r.payload?.metadata || {}) as Record<string, unknown>,
				};
			})
			.filter((r) => r.score >= minScore)
			.sort((a, b) => b.score - a.score);

		return {
			query,
			count: weighted.length,
			results: weighted,
		};
	}

	private resolveNamespace(
		namespace: string | undefined,
		sourceAgent: string,
	): MemoryNamespace {
		if (typeof namespace === "string" && namespace.trim().length > 0) {
			return parseExplicitNamespace(namespace, sourceAgent);
		}
		return `agent.${sourceAgent}.working_memory` as MemoryNamespace;
	}

	private async embedDetailedCompat(
		text: string,
	): Promise<{ vector: number[]; metadata: Record<string, unknown> }> {
		const emb = this.embedding as any;
		if (typeof emb.embedDetailed === "function") {
			return emb.embedDetailed(text);
		}

		const vector = await this.embedding.embed(text);
		return {
			vector,
			metadata: {
				embedding_chunked: false,
				embedding_chunks_count: 1,
				embedding_chunking_strategy: "array_batch_weighted_avg",
				embedding_model: "unknown",
				embedding_model_key: "unknown",
				embedding_provider: "auto",
			},
		};
	}
}
