import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";

const TEST_DIR = join(tmpdir(), `agent-memo-project-registry-test-${Date.now()}`);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
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
  console.log("\n🧪 Project Registry Tests (ASM-75)\n");

  const db = new SlotDB(TEST_DIR);
  const usecase = new DefaultMemoryUseCasePort(db);

  const ctx = {
    context: { userId: "telegram:dm:5165741309", agentId: "assistant" },
    meta: { source: "test" as const },
  };

  await test("project.register creates project + alias + registration state", async () => {
    const result = await usecase.run<any, any>("project.register", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo",
        project_name: "Agent Smart Memo",
        repo_root: "/Users/mrcagents/Work/projects/agent-smart-memo",
        repo_remote: "git@github.com:cong91/agent-smart-memo.git",
        active_version: "5.1",
      },
    });

    assert(Boolean(result.project.project_id), "project_id should be generated");
    assertEqual(result.alias.project_alias, "agent-smart-memo", "alias should be normalized");
    assertEqual(result.registration.registration_status, "registered", "registration_status should be registered");
    assertEqual(result.registration.validation_status, "ok", "validation_status should be ok");
    assert(result.registration.completeness_score >= 80, "completeness should be high");
  });

  await test("project.get by alias returns project and registration", async () => {
    const result = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo",
      },
    });

    assert(Boolean(result.project.project_id), "should return project_id");
    assertEqual(result.alias.project_alias, "agent-smart-memo", "alias should match");
    assertEqual(result.registration.validation_status, "ok", "registration state should be returned");
  });

  await test("project.set_tracker_mapping upserts Jira mapping", async () => {
    const current = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: { project_alias: "agent-smart-memo" },
    });

    const mapping = await usecase.run<any, any>("project.set_tracker_mapping", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        tracker_type: "jira",
        tracker_space_key: "ASM",
        default_epic_key: "ASM-69",
        active_version: "5.1",
      },
    });

    assertEqual(mapping.tracker_type, "jira", "tracker type should be jira");
    assertEqual(mapping.tracker_space_key, "ASM", "space key should be ASM");
    assertEqual(mapping.default_epic_key, "ASM-69", "default epic should persist");
  });

  await test("project.set_registration_state updates lifecycle validation state", async () => {
    const current = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: { project_alias: "agent-smart-memo" },
    });

    const state = await usecase.run<any, any>("project.set_registration_state", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        registration_status: "validated",
        validation_status: "ok",
        validation_notes: "registry validated by asm-75 tests",
        completeness_score: 96,
        missing_required_fields: [],
      },
    });

    assertEqual(state.registration_status, "validated", "registration state should become validated");
    assertEqual(state.completeness_score, 96, "completeness score should be updated");
  });

  await test("project.register_command supports tracker mapping envelope", async () => {
    const result = await usecase.run<any, any>("project.register_command", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        project_name: "Agent Smart Memo Cmd",
        repo_root: "/tmp/agent-smart-memo-cmd",
        tracker: {
          tracker_type: "jira",
          tracker_space_key: "ASM",
          default_epic_key: "ASM-69",
        },
        options: {
          trigger_index: false,
        },
      },
    });

    assert(Boolean(result.project_id), "register_command should return project_id");
    assertEqual(result.project_alias, "agent-smart-memo-cmd", "alias should be normalized");
    assertEqual(result.tracker_mapping.tracker_type, "jira", "tracker mapping should be linked");
    assertEqual(result.index_trigger.requested, false, "trigger flag should be false");
  });

  await test("project.link_tracker attaches Jira mapping by alias", async () => {
    const linked = await usecase.run<any, any>("project.link_tracker", {
      ...ctx,
      payload: {
        project_ref: { project_alias: "agent-smart-memo-cmd" },
        tracker: {
          tracker_type: "jira",
          tracker_space_key: "ASM",
          default_epic_key: "ASM-80",
        },
      },
    });

    assertEqual(linked.project_id.length > 0, true, "linked response should contain project_id");
    assertEqual(linked.tracker_mapping.default_epic_key, "ASM-80", "default epic should update");
    assertEqual(linked.validation_status, "ok", "link tracker validation should be ok");
  });

  await test("project.trigger_index accepts and executes when paths provided", async () => {
    const triggered = await usecase.run<any, any>("project.trigger_index", {
      ...ctx,
      payload: {
        project_ref: { project_alias: "agent-smart-memo-cmd" },
        mode: "bootstrap",
        reason: "post_registration",
        source_rev: "asm-80-test",
        paths: [
          { relative_path: "src/tools/project-tools.ts", checksum: "asm80-c1", module: "tools", language: "ts" },
        ],
      },
    });

    assertEqual(triggered.accepted, true, "trigger should be accepted");
    assertEqual(triggered.enqueued, true, "trigger should enqueue run when paths exist");
    assert(Boolean(triggered.run_id), "trigger should return run_id");
  });

  await test("project.link_tracker validates jira space/epic mapping", async () => {
    let thrown = false;
    try {
      await usecase.run<any, any>("project.link_tracker", {
        ...ctx,
        payload: {
          project_ref: { project_alias: "agent-smart-memo-cmd" },
          tracker: {
            tracker_type: "jira",
            tracker_space_key: "asm",
            default_epic_key: "WRONG-80",
          },
        },
      });
    } catch {
      thrown = true;
    }
    assertEqual(thrown, true, "invalid jira mapping should throw");
  });

  await test("project.telegram_onboarding preview validates jira mapping and returns summary card", async () => {
    const preview = await usecase.run<any, any>("project.telegram_onboarding", {
      ...ctx,
      payload: {
        command: "/project",
        repo_url: "git@github.com:cong91/agent-smart-memo.git",
        project_alias: "asm-telegram-preview",
        jira_space_key: "asm",
        default_epic_key: "WRONG-82",
        index_now: false,
        mode: "preview",
      },
    });

    assertEqual(preview.status, "validation_error", "preview should fail invalid jira mapping");
    assert(Array.isArray(preview.errors) && preview.errors.length >= 1, "preview should return inline errors");
    assert(Boolean(preview.summary_card), "preview should return summary card");
  });

  await test("project.telegram_onboarding confirm bridges to ASM-80 command layer", async () => {
    const committed = await usecase.run<any, any>("project.telegram_onboarding", {
      ...ctx,
      payload: {
        command: "/project",
        repo_url: "git@github.com:cong91/agent-smart-memo.git",
        repo_root: "/tmp/asm-telegram-onboarding",
        project_alias: "asm-telegram-onboarding",
        jira_space_key: "ASM",
        default_epic_key: "ASM-82",
        index_now: true,
        mode: "confirm",
      },
    });

    assertEqual(committed.status, "committed", "confirm should commit onboarding");
    assert(Boolean(committed.project_id), "confirm should return project_id");
    assertEqual(committed.project_alias, "asm-telegram-onboarding", "alias should persist");
    assertEqual(committed.tracker_mapping.tracker_type, "jira", "jira mapping should be linked");
    assertEqual(committed.index_trigger.requested, true, "index_now should propagate");
  });

  await test("project.list returns registry entries", async () => {
    const rows = await usecase.run<any, any[]>("project.list", {
      ...ctx,
      payload: {},
    });

    assert(rows.length >= 1, "project list should not be empty");
    assert(rows.some((r) => r.aliases.some((a: any) => a.project_alias === "agent-smart-memo")), "primary alias should be present");
  });

  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("🎉 All tests passed!\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
