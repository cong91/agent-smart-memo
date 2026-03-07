import { selectSemanticMemories } from "../src/hooks/auto-recall.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const ctx = {
  sessionKey: "agent:assistant:taa-thread-1",
  stateDir: "/tmp",
  userId: "u1",
  agentId: "assistant",
};

test("same-thread beats cross-thread", () => {
  const now = Date.now();
  const selected = selectSemanticMemories(
    [
      {
        score: 0.9,
        payload: {
          text: "Facebook planning milestone",
          namespace: "shared.project_context",
          sessionId: "fb-thread-9",
          project_tag: "facebook",
          timestamp: now - 4 * 24 * 60 * 60 * 1000,
        },
      },
      {
        score: 0.82,
        payload: {
          text: "TAA trade guardrail decision",
          namespace: "shared.project_context",
          sessionId: "taa-thread-1",
          project_tag: "taa",
          timestamp: now - 10 * 60 * 1000,
        },
      },
    ],
    ctx,
    {
      sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
      topicTags: new Set(["taa", "trading"]),
    },
  );

  assert(selected.memories.length > 0, "expected at least one recalled memory");
  assert(
    selected.memories[0].text.includes("TAA trade guardrail"),
    "same-thread memory should rank first",
  );
});

test("same-project beats cross-project", () => {
  const now = Date.now();
  const selected = selectSemanticMemories(
    [
      {
        score: 0.88,
        payload: {
          text: "Facebook roadmap checkpoint",
          namespace: "shared.project_context",
          project_tag: "facebook",
          timestamp: now - 20 * 60 * 1000,
        },
      },
      {
        score: 0.78,
        payload: {
          text: "TAA bypass tuning note",
          namespace: "shared.project_context",
          project_tag: "taa",
          timestamp: now - 20 * 60 * 1000,
        },
      },
    ],
    ctx,
    {
      sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
      topicTags: new Set(["taa", "trading"]),
    },
  );

  assert(selected.memories.length > 0, "expected at least one recalled memory");
  assert(
    selected.memories[0].text.includes("TAA bypass tuning"),
    "same-project memory should rank first",
  );
});

test("mixed-topic top hits are suppressed with low confidence", () => {
  const now = Date.now();
  const selected = selectSemanticMemories(
    [
      {
        score: 0.89,
        payload: {
          text: "Facebook sprint planning",
          namespace: "shared.project_context",
          project_tag: "facebook",
          timestamp: now - 30 * 60 * 1000,
        },
      },
      {
        score: 0.86,
        payload: {
          text: "Instagram ad experiment",
          namespace: "shared.project_context",
          project_tag: "instagram",
          timestamp: now - 45 * 60 * 1000,
        },
      },
      {
        score: 0.82,
        payload: {
          text: "Meta quarterly OKR",
          namespace: "shared.project_context",
          project_tag: "meta",
          timestamp: now - 50 * 60 * 1000,
        },
      },
    ],
    ctx,
    {
      sessionKeys: new Set(["agent:assistant:taa-thread-1", "taa-thread-1"]),
      topicTags: new Set(["taa", "trading"]),
    },
  );

  assert(selected.recallConfidence === "low", "recall confidence should be low");
  assert(selected.suppressed, "recall should be suppressed for mixed/cross-topic results");
  assert(selected.memories.length === 0, "suppressed recall should return zero semantic memories");
});

if (!process.exitCode) {
  console.log("\n🎉 auto-recall ranking tests passed");
}
