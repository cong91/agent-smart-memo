import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSlotTools } from "../src/tools/slot-tools.js";
import { registerGraphTools } from "../src/tools/graph-tools.js";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any, ctx: any) => Promise<any>;
}

class MockApi {
  public tools = new Map<string, RegisteredTool>();

  registerTool(tool: any) {
    this.tools.set(tool.name, tool as RegisteredTool);
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

console.log("\n🧪 OpenClaw Tools + UseCase Integration Tests\n");

const TEST_ROOT = join(tmpdir(), `agent-memo-openclaw-tools-${Date.now()}`);
const STATE_DIR = join(TEST_ROOT, "state");
const SLOTDB_DIR = join(TEST_ROOT, "slotdb");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(SLOTDB_DIR)) mkdirSync(SLOTDB_DIR, { recursive: true });

const api = new MockApi();
registerSlotTools(api as any, [], { stateDir: STATE_DIR, slotDbDir: SLOTDB_DIR });
registerGraphTools(api as any, { stateDir: STATE_DIR, slotDbDir: SLOTDB_DIR });

const ctx = { sessionKey: "agent:assistant:test-user-openclaw" };

const slotSet = api.tools.get("memory_slot_set");
const slotGet = api.tools.get("memory_slot_get");
const slotList = api.tools.get("memory_slot_list");
const graphEntitySet = api.tools.get("memory_graph_entity_set");
const graphEntityGet = api.tools.get("memory_graph_entity_get");

assert(slotSet && slotGet && slotList && graphEntitySet && graphEntityGet, "required tools should be registered");

const setRes = await slotSet!.execute("1", {
  key: "project.current",
  value: "openclaw-usecase-port-wiring",
  source: "manual",
}, ctx);
assert(setRes?.isError !== true, "memory_slot_set should not fail");
assert(String(setRes?.content?.[0]?.text || "").includes("Slot \"project.current\""), "slot_set response should preserve compatibility text");

const getRes = await slotGet!.execute("2", { key: "project.current" }, ctx);
assert(getRes?.isError !== true, "memory_slot_get should not fail");
assert(String(getRes?.content?.[0]?.text || "").includes("project.current"), "slot_get should include key");
assert(String(getRes?.content?.[0]?.text || "").includes("openclaw-usecase-port-wiring"), "slot_get should include stored value");

const listRes = await slotList!.execute("3", { scope: "all" }, ctx);
assert(listRes?.isError !== true, "memory_slot_list should not fail");
assert(String(listRes?.content?.[0]?.text || "").includes("project.current"), "slot_list should include stored key");

const entitySetRes = await graphEntitySet!.execute("4", { name: "OpenClawToolPath", type: "project" }, ctx);
assert(entitySetRes?.isError !== true, "memory_graph_entity_set should not fail");
const entityText = String(entitySetRes?.content?.[0]?.text || "");
assert(entityText.includes("Entity created"), "graph_entity_set should return created message");
const idMatch = entityText.match(/"id":\s*"([^"]+)"/);
assert(idMatch?.[1], "graph_entity_set should include entity id in text payload");

const entityGetRes = await graphEntityGet!.execute("5", { id: idMatch![1] }, ctx);
assert(entityGetRes?.isError !== true, "memory_graph_entity_get should not fail");
assert(String(entityGetRes?.content?.[0]?.text || "").includes("OpenClawToolPath"), "graph_entity_get should return inserted entity");

try {
  rmSync(TEST_ROOT, { recursive: true, force: true });
} catch {}

console.log("✅ OpenClaw tools integration passed (anti-regression on legacy tool path)\n");
