import { MEMORY_FOUNDATION_SCHEMA_VERSION } from "../core/migrations/memory-foundation-migration.js";
import { writeWikiMemoryCapture } from "../core/usecases/semantic-memory-usecase.js";
import {
	evaluateNoiseV2,
	normalizeNamespace,
	parseExplicitNamespace,
	resolveDefaultConfidence,
	resolveMemoryScopeFromNamespace,
	resolveMemoryTypeFromNamespace,
	toCoreAgent,
} from "../shared/memory-config.js";
import type { MemoryNamespace, StoreParams, ToolResult } from "../types.js";

function resolveAgentFromRuntimeParams(params: {
	agentId?: string;
	sessionId?: string;
	namespace?: unknown;
}): string {
	const directAgentId =
		typeof params.agentId === "string" ? params.agentId.trim() : "";
	if (directAgentId) return toCoreAgent(directAgentId);

	const sessionId =
		typeof params.sessionId === "string" ? params.sessionId.trim() : "";
	if (sessionId) {
		const parts = sessionId.split(":");
		if (parts.length >= 2 && parts[0] === "agent") {
			const fromSession = parts[1]?.trim();
			if (fromSession) return toCoreAgent(fromSession);
		}
	}

	const namespace =
		typeof params.namespace === "string" ? params.namespace.trim() : "";
	const nsMatch =
		/^agent\.([a-z0-9][a-z0-9_-]*)\.(working_memory|lessons|decisions)$/i.exec(
			namespace,
		);
	if (nsMatch?.[1]) {
		return toCoreAgent(nsMatch[1]);
	}

	return "assistant";
}

export const memoryStoreSchema = {
	type: "object",
	properties: {
		text: {
			type: "string",
			description: "The content to remember",
		},
		namespace: {
			type: "string",
			description:
				"Namespace for organization (default: 'shared.project_context')",
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

export function createMemoryStoreTool(defaultNamespace: MemoryNamespace) {
	const createDetails = (
		text: string,
		extra: Record<string, unknown> = {},
	) => ({
		...extra,
		toolResult: { text },
	});

	return {
		name: "memory_store",
		label: "Memory Store",
		description:
			"Store a memory in ASM wiki memory. Automatically deduplicates by canonical grouped page.",
		parameters: memoryStoreSchema,

		async execute(
			_id: string,
			params: StoreParams & { agentId?: string },
			_signal?: AbortSignal,
		): Promise<ToolResult> {
			try {
				// Validate
				if (!params.text || typeof params.text !== "string") {
					return {
						content: [{ type: "text", text: "Error: text is required" }],
						isError: true,
						details: createDetails("Error: text is required", {
							error: "Missing text parameter",
						}),
					};
				}

				const text = params.text.trim();
				if (text.length === 0) {
					return {
						content: [{ type: "text", text: "Error: text cannot be empty" }],
						isError: true,
						details: createDetails("Error: text cannot be empty", {
							error: "Empty text",
						}),
					};
				}

				if (text.length > 10000) {
					return {
						content: [
							{
								type: "text",
								text: "Error: text exceeds 10000 character limit",
							},
						],
						isError: true,
						details: createDetails(
							"Error: text exceeds 10000 character limit",
							{
								error: "Text too long",
								length: text.length,
							},
						),
					};
				}

				// Namespace router + normalization policy (ASM-5)
				const sourceAgent = resolveAgentFromRuntimeParams(params);
				const requestedNamespace =
					typeof params.namespace === "string" &&
					params.namespace.trim().length > 0
						? params.namespace
						: `agent.${sourceAgent}.working_memory`;
				let namespace =
					typeof params.namespace === "string" &&
					params.namespace.trim().length > 0
						? parseExplicitNamespace(requestedNamespace, sourceAgent)
						: normalizeNamespace(requestedNamespace, sourceAgent);

				// Noise policy v2: quarantine noisy content into noise.filtered
				const noise = evaluateNoiseV2(text, "tool_call");
				if (noise.isNoise) {
					namespace = "noise.filtered" as MemoryNamespace;
				}
				const memoryScope = resolveMemoryScopeFromNamespace(namespace);
				const memoryType = resolveMemoryTypeFromNamespace(namespace);
				const promotionState = "raw" as const;
				const defaultConfidence = resolveDefaultConfidence("tool_call");

				const wikiWrite = writeWikiMemoryCapture({
					text,
					namespace,
					sourceAgent,
					sourceType: "tool_call",
					memoryScope,
					memoryType,
					confidence: defaultConfidence,
					sessionId: params.sessionId || undefined,
					userId: params.userId || undefined,
					metadata: {
						schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
						promotion_state: promotionState,
						noise_score: noise.score,
						noise_matched_patterns: noise.matchedPatterns,
						...(params.metadata || {}),
					},
				});

				const textOut = wikiWrite.updated
					? `Memory updated (duplicate detected, ID: ${wikiWrite.id})`
					: `Memory stored successfully (ID: ${wikiWrite.id})`;
				return {
					content: [{ type: "text", text: textOut }],
					details: createDetails(textOut, {
						id: wikiWrite.id,
						created: wikiWrite.created,
						updated: wikiWrite.updated,
						wiki: {
							rawPath: wikiWrite.rawPath,
							livePath: wikiWrite.livePath,
							briefingPath: wikiWrite.briefingPath,
						},
					}),
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
