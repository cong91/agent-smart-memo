import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { resolveLegacyStateDirInput, resolveSlotDbDir } from "../src/shared/slotdb-path.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const TEST_ROOT = join(tmpdir(), `agent-memo-slotdb-path-${Date.now()}`);
const STATE_DIR = join(TEST_ROOT, ".openclaw");
const TARGET_SLOTDB_DIR = join(TEST_ROOT, "agent-memo");

console.log("\n🧪 SlotDB Path Resolution Tests\n");

try {
  const resolvedFromEnv = resolveSlotDbDir({
    stateDir: STATE_DIR,
    slotDbDir: "/should/not/win",
    env: { ...process.env, OPENCLAW_SLOTDB_DIR: TARGET_SLOTDB_DIR },
    homeDir: process.env.HOME,
  });
  assert(resolvedFromEnv === TARGET_SLOTDB_DIR, "env must override config/state fallback");
  console.log("✅ env priority over config");

  const resolvedFromConfig = resolveSlotDbDir({
    stateDir: STATE_DIR,
    slotDbDir: TARGET_SLOTDB_DIR,
    env: { ...process.env, OPENCLAW_SLOTDB_DIR: "" },
    homeDir: process.env.HOME,
  });
  assert(resolvedFromConfig === TARGET_SLOTDB_DIR, "config slotDbDir must be used when env absent");
  console.log("✅ config priority over legacy fallback");

  const resolvedLegacy = resolveSlotDbDir({
    stateDir: STATE_DIR,
    env: { ...process.env, OPENCLAW_SLOTDB_DIR: "" },
    homeDir: process.env.HOME,
  });
  assert(resolvedLegacy === join(STATE_DIR, "agent-memo"), "legacy fallback must append agent-memo once");
  console.log("✅ legacy fallback appends agent-memo once");

  const legacyCtorTarget = resolveLegacyStateDirInput(TARGET_SLOTDB_DIR);
  assert(legacyCtorTarget === TARGET_SLOTDB_DIR, "legacy resolver must not double-append when path already ends with agent-memo");
  console.log("✅ legacy ctor input avoids nested agent-memo path");

  const db = new SlotDB(STATE_DIR, { slotDbDir: TARGET_SLOTDB_DIR });
  db.set("u", "a", { key: "project.current", value: "slotdb-path-test" });
  db.close();

  const expectedDbPath = join(TARGET_SLOTDB_DIR, "slots.db");
  const nestedDbPath = join(TARGET_SLOTDB_DIR, "agent-memo", "slots.db");
  assert(existsSync(expectedDbPath), "slots.db must exist directly inside target slotDbDir");
  assert(!existsSync(nestedDbPath), "must not create nested agent-memo/agent-memo/slots.db");
  console.log("✅ SlotDB writes to target dir without nested path");

  console.log("\n🎉 SlotDB path resolution tests passed\n");
} finally {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}
