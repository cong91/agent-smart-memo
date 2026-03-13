import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";

const TEST_DIR = join(tmpdir(), `agent-memo-project-legacy-backfill-test-${Date.now()}`);

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
  console.log("\n🧪 Project Legacy Compatibility Backfill Tests (ASM-81)\n");

  const db = new SlotDB(TEST_DIR);
  const usecase = new DefaultMemoryUseCasePort(db);

  const ctx = {
    context: { userId: "telegram:dm:5165741309", agentId: "assistant" },
    meta: { source: "test" as const },
  };

  const project = await usecase.run<any, any>("project.register", {
    ...ctx,
    payload: {
      project_alias: "legacy-memo",
      project_name: "Legacy Memo",
      repo_root: "/Users/mrcagents/Work/projects/legacy-memo",
      repo_remote: "git@github.com:cong91/agent-smart-memo.git",
      active_version: "5.1",
    },
  });

  const projectId = project.project.project_id as string;

  await usecase.run<any, any>("project.task_registry_upsert", {
    ...ctx,
    payload: {
      task_id: "ASM-81",
      project_id: projectId,
      task_title: "Legacy compatibility migration and backfill",
      tracker_issue_key: "ASM-81",
      files_touched: ["src/db/slot-db.ts"],
      decision_notes: "backfill aliases + tracker mappings with non-destructive policy",
    },
  });

  await test("project.legacy_backfill dry_run reports candidates without writing", async () => {
    const result = await usecase.run<any, any>("project.legacy_backfill", {
      ...ctx,
      payload: {
        mode: "dry_run",
        source: "mixed",
      },
    });

    assertEqual(result.mode, "dry_run", "mode should be dry_run");
    assert(result.candidates >= 1, "should have at least one candidate");
    assertEqual(result.updated_aliases, 0, "dry run must not write aliases");
    assertEqual(result.updated_tracker_mappings, 0, "dry run must not write trackers");
    assertEqual(result.migration_state_upserts, 0, "dry run must not upsert migration_state");
    assert(result.items.some((i: any) => i.project_id === projectId), "result must include seeded project");
  });

  await test("project.legacy_backfill apply backfills alias/tracker and upserts migration_state", async () => {
    const result = await usecase.run<any, any>("project.legacy_backfill", {
      ...ctx,
      payload: {
        mode: "apply",
        source: "mixed",
        only_project_ids: [projectId],
      },
    });

    assertEqual(result.mode, "apply", "mode should be apply");
    assertEqual(result.candidates, 1, "only selected project should be processed");
    assert(result.updated_aliases >= 1, "apply should backfill at least one alias");
    assert(result.updated_tracker_mappings >= 1, "apply should backfill tracker mapping from task/repo evidence");
    assertEqual(result.migration_state_upserts, 1, "migration_state should be upserted once");

    const listed = await usecase.run<any, any[]>("project.list", {
      ...ctx,
      payload: {},
    });

    const row = listed.find((r: any) => r.project.project_id === projectId);
    assert(Boolean(row), "project should still exist after backfill");
    assert((row!.aliases || []).length >= 2, "backfill should add inferred alias while preserving original alias");

    const tracker = db.getProjectTrackerMapping(ctx.context.userId, ctx.context.agentId, projectId, "jira");
    assert(Boolean(tracker), "jira mapping should be inferred from task_registry issue keys");
    assertEqual(tracker!.tracker_space_key, "ASM", "jira space should infer from ASM-81");
  });

  await test("project.legacy_backfill can target by alias selector", async () => {
    const result = await usecase.run<any, any>("project.legacy_backfill", {
      ...ctx,
      payload: {
        mode: "dry_run",
        source: "repo_root",
        only_aliases: ["legacy-memo"],
      },
    });

    assertEqual(result.candidates, 1, "alias filter should isolate one project");
    assert(result.items[0].project_id === projectId, "selected item should be projectId");
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
