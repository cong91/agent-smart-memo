export interface RecallBenchmarkFixture {
	id: string;
	description: string;
	ctx: {
		sessionKey: string;
		stateDir: string;
		userId: string;
		agentId: string;
	};
	hints: {
		sessionKeys: Set<string>;
		topicTags: Set<string>;
		graphTags: Set<string>;
	};
	results: Array<{ score: number; payload: Record<string, unknown> }>;
	expectations: {
		recallSuppressed: boolean;
		recallConfidence?: "high" | "medium" | "low";
		minMemories?: number;
		maxMemories?: number;
		mustIncludeTextFragments?: string[];
		mustExcludeNamespacePrefixes?: string[];
	};
}

export const recallBenchmarkFixtures: RecallBenchmarkFixture[] = [
	{
		id: "generic-path-suppresses-trader-tactical",
		description:
			"generic assistant recall should suppress trader tactical memory even with high semantic score",
		ctx: {
			sessionKey: "agent:assistant:taa-thread-1",
			stateDir: "/tmp",
			userId: "u1",
			agentId: "assistant",
		},
		hints: {
			sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(["risk", "guardrail"]),
		},
		results: [
			{
				score: 0.93,
				payload: {
					text: "Trader tactical entry timing after fake breakout",
					namespace: "agent.trader.decisions",
					domain: "trader_tactical",
					source_agent: "trader",
					sessionId: "taa-thread-1",
					project_tag: "taa",
				},
			},
			{
				score: 0.81,
				payload: {
					text: "TAA runbook: risk gate checklist",
					namespace: "shared.runbooks",
					sessionId: "taa-thread-1",
					project_tag: "taa",
				},
			},
		],
		expectations: {
			recallSuppressed: false,
			recallConfidence: "high",
			minMemories: 1,
			mustIncludeTextFragments: ["risk gate checklist"],
			mustExcludeNamespacePrefixes: ["agent.trader."],
		},
	},
	{
		id: "trader-owner-path-allows-tactical",
		description:
			"trader owner path should keep tactical memory and not suppress high-relevance hits",
		ctx: {
			sessionKey: "agent:trader:taa-thread-2",
			stateDir: "/tmp",
			userId: "u1",
			agentId: "trader",
		},
		hints: {
			sessionKeys: new Set(["agent:trader:taa-thread-2", "taa-thread-2"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set(["reclaim", "failed_reclaim"]),
		},
		results: [
			{
				score: 0.87,
				payload: {
					text: "Trader tactical: failed reclaim should reduce size",
					namespace: "agent.trader.decisions",
					domain: "trader_tactical",
					source_agent: "trader",
					sessionId: "taa-thread-2",
					project_tag: "taa",
					timestamp: Date.now() - 5 * 60 * 1000,
				},
			},
		],
		expectations: {
			recallSuppressed: false,
			recallConfidence: "high",
			minMemories: 1,
			mustIncludeTextFragments: ["failed reclaim should reduce size"],
		},
	},
	{
		id: "mixed-cross-topic-suppressed",
		description:
			"cross-topic top hits with no session/project anchor should be suppressed",
		ctx: {
			sessionKey: "agent:assistant:taa-thread-3",
			stateDir: "/tmp",
			userId: "u1",
			agentId: "assistant",
		},
		hints: {
			sessionKeys: new Set(["agent:assistant:taa-thread-3", "taa-thread-3"]),
			topicTags: new Set(["taa", "trading"]),
			graphTags: new Set([]),
		},
		results: [
			{
				score: 0.9,
				payload: {
					text: "Facebook planning checkpoint",
					namespace: "shared.project_context",
					project_tag: "facebook",
					sessionId: "fb-thread-1",
				},
			},
			{
				score: 0.86,
				payload: {
					text: "Instagram experiment note",
					namespace: "shared.project_context",
					project_tag: "instagram",
					sessionId: "ig-thread-1",
				},
			},
		],
		expectations: {
			recallSuppressed: true,
			recallConfidence: "low",
			maxMemories: 0,
		},
	},
];
