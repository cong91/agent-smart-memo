import type { SlotDB } from "../../db/slot-db.js";
import { MEMORY_FOUNDATION_SCHEMA_VERSION } from "../migrations/memory-foundation-migration.js";
import { resolvePromotionMetadata } from "../promotion/promotion-lifecycle.js";
import {
	type MemoryNamespace,
	normalizeNamespace,
	resolveMemoryScopeFromNamespace,
	toCoreAgent,
} from "../../shared/memory-config.js";
import { writeWikiMemoryCapture } from "./semantic-memory-usecase.js";

/**
 * Common shape for Distill results (from llm-extractor)
 */
export interface DistillApplyInput {
	slot_updates?: Array<{ key: string; value: any; confidence: number; category: string }>;
	slot_removals?: Array<{ key: string; reason: string }>;
	memories?: Array<any>;
	draft_updates?: Array<any>;
	briefing_updates?: Array<any>;
	log_entries?: Array<any>;
	promotion_hints?: Array<any>;
}

export interface DistillApplyContext {
	userId: string;
	agentId: string;
	sessionKey: string;
	targetNamespace?: MemoryNamespace;
	minConfidence: number;
}

export interface DistillApplyResult {
	slotsStored: number;
	slotsRemoved: number;
	memoriesStored: number;
	draftsStored: number;
	briefingsStored: number;
	hintsStored: number;
}

/**
 * Deterministic Apply Layer for Distill Results
 * Enforces explicit non-capturable loop guards by injecting `autoCaptureSkip`
 * and `internalLifecycle: "distill_apply"` into metadata.
 */
export class DistillApplyUseCase {
	constructor(private db: SlotDB) {}

	public execute(
		extracted: DistillApplyInput,
		ctx: DistillApplyContext,
	): DistillApplyResult {
		const result: DistillApplyResult = {
			slotsStored: 0,
			slotsRemoved: 0,
			memoriesStored: 0,
			draftsStored: 0,
			briefingsStored: 0,
			hintsStored: 0,
		};

		const { userId, agentId, sessionKey, minConfidence } = ctx;
		const coreAgent = toCoreAgent(agentId);
		const defaultNamespace: MemoryNamespace = ctx.targetNamespace || `agent.${coreAgent}.working_memory` as MemoryNamespace;

		// 1. Process log entries
		for (const logEntry of extracted.log_entries || []) {
			const level = String(logEntry?.level || "info").toLowerCase();
			const text = String(logEntry?.text || "").trim();
			if (!text) continue;
			if (level === "error") console.error(`[DistillApply][log] ${text}`);
			else if (level === "warn") console.warn(`[DistillApply][log] ${text}`);
			else console.log(`[DistillApply][log] ${text}`);
		}

		// 2. Process slot REMOVALS
		if (extracted.slot_removals && extracted.slot_removals.length > 0) {
			for (const removal of extracted.slot_removals) {
				try {
					const deleted = this.db.delete(userId, agentId, removal.key);
					if (deleted) {
						result.slotsRemoved++;
						console.log(`[DistillApply] Removed stale slot: ${removal.key} (reason: ${removal.reason})`);
					}
				} catch (e) {
					console.error("[DistillApply] Failed to remove slot:", e);
				}
			}
		}

		// 3. Process slot UPDATES
		if (extracted.slot_updates && extracted.slot_updates.length > 0) {
			for (const fact of extracted.slot_updates) {
				if (fact.confidence < minConfidence) continue;
				try {
					this.db.set(userId, agentId, {
						key: fact.key,
						value: fact.value,
						category: fact.category,
						source: "auto_capture",
						confidence: fact.confidence,
						// Add non-capturable metadata to slot if needed, though SlotDB doesn't store arbitrary metadata at root level
					});
					result.slotsStored++;
					console.log(`[DistillApply] Stored: ${fact.key} = ${JSON.stringify(fact.value)}`);
				} catch (e) {
					console.error("[DistillApply] Failed to store slot:", e);
				}
			}
		}

		// 4. Process Wiki Memories
		if (extracted.memories && extracted.memories.length > 0) {
			for (let i = 0; i < extracted.memories.length; i++) {
				const memory = extracted.memories[i];
				try {
					const text = typeof memory === "string" ? memory : memory.text || JSON.stringify(memory);
					if (!text || text.trim().length === 0) continue;

					const memoryNamespace = memory.namespace ? normalizeNamespace(memory.namespace, agentId) : defaultNamespace;
					
					const lifecycle = resolvePromotionMetadata({
						namespace: memoryNamespace,
						sourceType: "auto_capture",
					});

					writeWikiMemoryCapture({
						text,
						namespace: memoryNamespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(memoryNamespace),
						memoryType: lifecycle.memoryType,
						promotionState: lifecycle.promotionState,
						confidence: lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: lifecycle.promotionState,
							// Explicit loop guards
							autoCaptureSkip: true,
							internalLifecycle: "distill_apply",
						},
					});
					result.memoriesStored++;
				} catch (e: any) {
					console.error(`[DistillApply] Error processing memory ${i + 1}:`, e.message);
				}
			}
		}

		// 5. Process Draft Updates
		if (extracted.draft_updates && extracted.draft_updates.length > 0) {
			for (const draft of extracted.draft_updates) {
				const text = String(draft?.text || "").trim();
				if (!text) continue;
				const namespace = normalizeNamespace(String(draft?.namespace || defaultNamespace), agentId);
				try {
					const lifecycle = resolvePromotionMetadata({
						namespace,
						sourceType: "auto_capture",
						promotionState: "raw",
					});
					writeWikiMemoryCapture({
						text,
						namespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(namespace),
						memoryType: lifecycle.memoryType,
						promotionState: "raw",
						confidence: typeof draft?.confidence === "number" ? draft.confidence : lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: "raw",
							draft_candidate: true,
							title: draft?.title,
							// Explicit loop guards
							autoCaptureSkip: true,
							internalLifecycle: "distill_apply",
						},
					});
					result.draftsStored++;
				} catch (e) {
					console.error("[DistillApply] Failed to apply draft_update:", e);
				}
			}
		}

		// 6. Process Briefing Updates
		if (extracted.briefing_updates && extracted.briefing_updates.length > 0) {
			for (const briefing of extracted.briefing_updates) {
				const text = String(briefing?.text || "").trim();
				if (!text) continue;
				const namespace = normalizeNamespace(String(briefing?.namespace || "shared.project_context"), agentId);
				try {
					const lifecycle = resolvePromotionMetadata({
						namespace,
						sourceType: "auto_capture",
						promotionState: "distilled",
					});
					writeWikiMemoryCapture({
						text,
						namespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(namespace),
						memoryType: lifecycle.memoryType,
						promotionState: "distilled",
						confidence: typeof briefing?.confidence === "number" ? briefing.confidence : lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: "distilled",
							title: briefing?.title,
							// Explicit loop guards
							autoCaptureSkip: true,
							internalLifecycle: "distill_apply",
						},
					});
					result.briefingsStored++;
				} catch (e) {
					console.error("[DistillApply] Failed to apply briefing_update:", e);
				}
			}
		}

		// 7. Process Promotion Hints
		if (extracted.promotion_hints && extracted.promotion_hints.length > 0) {
			for (const hint of extracted.promotion_hints) {
				const text = String(hint?.text || "").trim();
				if (!text) continue;
				const namespace = normalizeNamespace(String(hint?.namespace || defaultNamespace), agentId);
				const promotionState = typeof hint?.promotion_state === "string" ? hint.promotion_state : "distilled";
				try {
					const lifecycle = resolvePromotionMetadata({
						namespace,
						sourceType: "auto_capture",
						promotionState,
						memoryType: typeof hint?.memory_type === "string" ? hint.memory_type : undefined,
						confidence: typeof hint?.confidence === "number" ? hint.confidence : undefined,
					});
					writeWikiMemoryCapture({
						text,
						namespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(namespace),
						memoryType: lifecycle.memoryType,
						promotionState: lifecycle.promotionState,
						confidence: typeof hint?.confidence === "number" ? hint.confidence : lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: lifecycle.promotionState,
							hint_memory_type: hint?.memory_type,
							// Explicit loop guards
							autoCaptureSkip: true,
							internalLifecycle: "distill_apply",
						},
					});
					result.hintsStored++;
				} catch (e) {
					console.error("[DistillApply] Failed to apply promotion_hint:", e);
				}
			}
		}

		return result;
	}
}
