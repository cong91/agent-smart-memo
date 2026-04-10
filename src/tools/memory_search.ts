import {
	normalizeSessionToken,
	resolveSessionMode,
} from "../core/retrieval-policy.js";
import { searchWikiMemory } from "../core/usecases/semantic-memory-usecase.js";
import {
	getAgentNamespaces,
	parseExplicitNamespace,
	toCoreAgent,
} from "../shared/memory-config.js";
import type { MemoryNamespace, SearchParams, ToolResult } from "../types.js";

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
		sessionMode: {
			type: "string",
			enum: ["strict", "soft"],
			description:
				"Session matching mode (default: soft). strict=hard filter, soft=score boost only",
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
		includeDrafts: {
			type: "boolean",
			description: "Include drafts layer in search candidates (default: false)",
		},
		includeRaw: {
			type: "boolean",
			description: "Include raw layer in search candidates (default: false)",
		},
		sourceAgent: {
			type: "string",
			description: "Filter by source agent ID",
		},
	},
	required: ["query"],
};

export function createMemorySearchTool(defaultNamespace: MemoryNamespace) {
	const createDetails = (
		text: string,
		extra: Record<string, unknown> = {},
	) => ({
		...extra,
		toolResult: { text },
	});

	return {
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search stored memories by semantic similarity. Returns most relevant past information.",
		parameters: memorySearchSchema,

		async execute(
			_id: string,
			params: SearchParams & { sourceAgent?: string; agentId?: string },
			_signal?: AbortSignal,
		): Promise<ToolResult> {
			try {
				// Validate
				if (!params.query || typeof params.query !== "string") {
					return {
						content: [{ type: "text", text: "Error: query is required" }],
						isError: true,
						details: createDetails("Error: query is required", {
							error: "Missing query parameter",
						}),
					};
				}

				const query = params.query.trim();
				if (query.length === 0) {
					return {
						content: [{ type: "text", text: "Error: query cannot be empty" }],
						isError: true,
						details: createDetails("Error: query cannot be empty", {
							error: "Empty query",
						}),
					};
				}

				const limit = Math.min(Math.max(params.limit || 5, 1), 20);
				const minScore = params.minScore ?? 0.7;
				const includeDrafts = Boolean((params as any).includeDrafts);
				const includeRaw = Boolean((params as any).includeRaw);
				const sessionMode = resolveSessionMode((params as any).sessionMode);
				const preferredSessionId = normalizeSessionToken(params.sessionId);

				// Determine namespaces to search (normalize user-facing aliases to canonical namespaces)
				const sourceAgent = resolveAgentFromRuntimeParams(params);
				const namespaces: MemoryNamespace[] = params.namespace
					? [parseExplicitNamespace(params.namespace as string, sourceAgent)]
					: getAgentNamespaces(sourceAgent);
				if (namespaces.length === 0) {
					namespaces.push(defaultNamespace);
				}

				const wikiResults = searchWikiMemory({
					query,
					limit,
					minScore,
					namespaces,
					sourceAgent,
					sessionMode,
					preferredSessionId,
					userId: params.userId,
					sourceAgentFilter: params.sourceAgent,
					includeDrafts,
					includeRaw,
				});

				if (wikiResults.length > 0) {
					const formatted = wikiResults
						.map((r, i) => {
							const date = r.timestamp
								? new Date(r.timestamp).toLocaleDateString()
								: "Unknown";
							const lines = [
								`[${i + 1}] Score: ${(r.score * 100).toFixed(1)}%`,
								`Namespace: ${r.namespace || "unknown"}`,
								`Text: ${r.text}`,
								`Date: ${date}`,
							];
							if (r.metadata && Object.keys(r.metadata).length > 0) {
								lines.push(`Metadata: ${JSON.stringify(r.metadata)}`);
							}
							return lines.join("\n");
						})
						.join("\n\n---\n\n");

					const textOut = `Found ${wikiResults.length} relevant memories for "${query}":\n\n${formatted}`;
					return {
						content: [{ type: "text", text: textOut }],
						details: createDetails(textOut, {
							count: wikiResults.length,
							query,
							results: wikiResults,
							source: "wiki",
						}),
					};
				}

				if (wikiResults.length === 0) {
					const textOut = "No relevant memories found.";
					return {
						content: [{ type: "text", text: textOut }],
						details: createDetails(textOut, { count: 0, query }),
					};
				}

				const textOut = "No relevant memories found.";
				return {
					content: [{ type: "text", text: textOut }],
					details: createDetails(textOut, { count: 0, query }),
				};
			} catch (error: any) {
				const textOut = `Error searching memories: ${error.message}`;
				return {
					content: [{ type: "text", text: textOut }],
					isError: true,
					details: createDetails(textOut, { error: error.message }),
				};
			}
		},
	};
}
