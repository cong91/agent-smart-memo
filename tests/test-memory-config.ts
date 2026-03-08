import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
  }
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

const ROOT = mkdtempSync(join(tmpdir(), "agent-smart-memo-memory-config-"));
const stateDir = join(ROOT, ".openclaw");
mkdirSync(stateDir, { recursive: true });
const configPath = join(stateDir, "openclaw.json");

process.env.OPENCLAW_STATE_DIR = stateDir;
delete process.env.OPENCLAW_CONFIG_PATH;
delete process.env.OPENCLAW_RUNTIME_CONFIG;

writeFileSync(
  configPath,
  JSON.stringify(
    {
      agents: {
        list: [
          { id: "assistant" },
          { id: "scrum" },
          { id: "fullstack" },
          { id: "trader" },
          { id: "creator" },
          { id: "researcher" },
          { id: "ops-bot" },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);

const {
  getRegisteredAgentIds,
  resolveOpenClawConfigPath,
  resolveAgentId,
  toCoreAgent,
  getAgentNamespaces,
  getAutoCaptureNamespace,
  getNamespaceWeight,
  normalizeNamespace,
  isRegisteredAgent,
} = await import("../src/shared/memory-config.js");

test("reads dynamic agent registry from OpenClaw runtime config", () => {
  const ids = getRegisteredAgentIds();
  assert(ids.includes("assistant"), "should include default assistant");
  assert(ids.includes("researcher"), "should include dynamic agent researcher");
  assert(ids.includes("ops-bot"), "should include dynamic agent ops-bot");
});

test("config source resolves from OPENCLAW_STATE_DIR/openclaw.json by default", () => {
  assertEqual(resolveOpenClawConfigPath(), configPath, "should resolve runtime config path");
});

test("does not fallback non-core registry agent to assistant", () => {
  assertEqual(resolveAgentId("researcher"), "researcher", "resolveAgentId should preserve researcher");
  assertEqual(toCoreAgent("researcher"), "researcher", "toCoreAgent compat alias should preserve researcher");
});

test("dynamic namespaces are generated per agentId", () => {
  assertEqual(
    getAgentNamespaces("researcher"),
    [
      "agent.researcher.working_memory",
      "agent.researcher.lessons",
      "agent.researcher.decisions",
      "shared.project_context",
      "shared.rules_slotdb",
      "shared.runbooks",
    ],
    "should build dynamic namespaces for researcher",
  );
});

test("auto-capture routes dynamic agents into dynamic namespaces", () => {
  assertEqual(
    getAutoCaptureNamespace("researcher", "We learned a painful lesson from this root cause"),
    "agent.researcher.lessons",
    "learning content should route to researcher lessons",
  );
  assertEqual(
    getAutoCaptureNamespace("ops-bot", "Approved the rollout decision after review"),
    "agent.ops-bot.decisions",
    "decision content should route to ops-bot decisions",
  );
});

test("normalizeNamespace accepts dynamic agent namespace strings as-is", () => {
  assertEqual(
    normalizeNamespace("agent.researcher.working_memory", "assistant"),
    "agent.researcher.working_memory",
    "dynamic namespace should be preserved",
  );
  assertEqual(
    normalizeNamespace(undefined, "researcher"),
    "agent.researcher.working_memory",
    "fallback namespace should use provided agentId",
  );
});

test("namespace weighting works for dynamic agent namespaces", () => {
  assertEqual(getNamespaceWeight("researcher", "agent.researcher.decisions"), 1.25, "decision weight should match policy");
  assertEqual(getNamespaceWeight("researcher", "agent.researcher.lessons"), 1.2, "lesson weight should match policy");
  assertEqual(getNamespaceWeight("researcher", "agent.researcher.working_memory"), 1.1, "working memory weight should match policy");
});

test("unknown-but-present dynamic agent is recognized as registered", () => {
  assertEqual(isRegisteredAgent("researcher"), true, "researcher should be registered");
  assertEqual(isRegisteredAgent("ghost-agent"), false, "ghost-agent should not be registered");
});

process.on("exit", () => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

if (!process.exitCode) {
  console.log("\n🎉 memory-config dynamic registry tests passed");
}
