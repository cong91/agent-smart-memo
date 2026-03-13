import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";

const TEST_DIR = join(tmpdir(), `agent-memo-project-reindex-test-${Date.now()}`);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.log(`  ❌ ${name}`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

async function main() {
  console.log("\n🧪 Project Reindex Diff Tests (ASM-78)\n");

  const db = new SlotDB(TEST_DIR);
  const usecase = new DefaultMemoryUseCasePort(db);

  const ctx = {
    context: { userId: "telegram:dm:5165741309", agentId: "assistant" },
    meta: { source: "test" as const },
  };

  const project = await usecase.run<any, any>("project.register", {
    ...ctx,
    payload: {
      project_alias: "agent-smart-memo",
      project_name: "Agent Smart Memo",
      repo_root: "/Users/mrcagents/Work/projects/agent-smart-memo",
    },
  });

  const projectId = project.project.project_id as string;

  await test("project.reindex_diff bootstrap marks all incoming paths as changed", async () => {
    const result = await usecase.run<any, any>("project.reindex_diff", {
      ...ctx,
      payload: {
        project_id: projectId,
        source_rev: "abc123",
        trigger_type: "bootstrap",
        paths: [
          { relative_path: "src/index.ts", checksum: "c1", module: "src", language: "ts" },
          { relative_path: "src/db/slot-db.ts", checksum: "c2", module: "src/db", language: "ts" },
        ],
      },
    });

    assertEqual(result.trigger_type, "bootstrap", "trigger type should persist");
    assertEqual(result.changed.sort(), ["src/db/slot-db.ts", "src/index.ts"], "all files should be changed on first run");
    assertEqual(result.unchanged, [], "unchanged should be empty on first run");
    assertEqual(result.deleted, [], "deleted should be empty on first run");
    assertEqual(result.run_state, "indexed", "run should complete indexed");
  });

  await test("project.reindex_diff incremental returns unchanged when checksum does not change", async () => {
    const result = await usecase.run<any, any>("project.reindex_diff", {
      ...ctx,
      payload: {
        project_id: projectId,
        source_rev: "abc124",
        trigger_type: "incremental",
        paths: [
          { relative_path: "src/index.ts", checksum: "c1", module: "src", language: "ts" },
          { relative_path: "src/db/slot-db.ts", checksum: "c2", module: "src/db", language: "ts" },
        ],
      },
    });

    assertEqual(result.changed, [], "changed should be empty when checksums stable");
    assertEqual(result.unchanged.sort(), ["src/db/slot-db.ts", "src/index.ts"], "both files should be unchanged");
    assertEqual(result.deleted, [], "no deleted file expected");
  });

  await test("project.reindex_diff detects changed and deleted files + updates watch state", async () => {
    const result = await usecase.run<any, any>("project.reindex_diff", {
      ...ctx,
      payload: {
        project_id: projectId,
        source_rev: "abc125",
        trigger_type: "incremental",
        paths: [
          { relative_path: "src/index.ts", checksum: "c1-updated", module: "src", language: "ts" },
        ],
      },
    });

    assertEqual(result.changed, ["src/index.ts"], "index.ts should be changed");
    assertEqual(result.unchanged, [], "unchanged should be empty");
    assertEqual(result.deleted, ["src/db/slot-db.ts"], "slot-db.ts should be detected as deleted");

    const watch = await usecase.run<any, any>("project.index_watch_get", {
      ...ctx,
      payload: { project_id: projectId },
    });

    assertEqual(watch.project_id, projectId, "watch state must bind correct project_id");
    assertEqual(watch.last_source_rev, "abc125", "watch state should move to latest source rev");
    assertEqual(
      Object.keys(watch.last_checksum_snapshot).sort(),
      ["src/index.ts"],
      "watch checksum snapshot should reflect latest file-set",
    );
    assertEqual(watch.last_checksum_snapshot["src/index.ts"], "c1-updated", "watch checksum should persist latest checksum");
  });

  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (failed > 0) process.exit(1);
  console.log("🎉 All tests passed!\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
