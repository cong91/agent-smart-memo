import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SlotDB } from "../src/db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";

const TEST_DIR = join(tmpdir(), `agent-memo-project-hybrid-lineage-test-${Date.now()}`);

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
  console.log("\n🧪 Project Hybrid Retrieval + Task Lineage Tests (ASM-79)\n");

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
      active_version: "5.1",
    },
  });
  const projectId = project.project.project_id as string;

  await usecase.run<any, any>("project.reindex_diff", {
    ...ctx,
    payload: {
      project_id: projectId,
      source_rev: "asm79-seed",
      trigger_type: "bootstrap",
      paths: [
        { relative_path: "src/tools/project-tools.ts", checksum: "h1", module: "tools", language: "ts" },
        { relative_path: "src/core/usecases/default-memory-usecase-port.ts", checksum: "h2", module: "core", language: "ts" },
      ],
    },
  });

  // Seed symbol registry directly (ASM-79 scope uses existing table; no parser wiring yet)
  const raw = db as any;
  raw.db
    .prepare(
      `INSERT INTO symbol_registry (
        symbol_id, scope_user_id, scope_agent_id, project_id, relative_path, module, language,
        symbol_name, symbol_fqn, symbol_kind, signature_hash, index_state, active, tombstone_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${projectId}::project_hybrid_search`,
      ctx.context.userId,
      ctx.context.agentId,
      projectId,
      "src/tools/project-tools.ts",
      "tools",
      "ts",
      "project_hybrid_search",
      "registerProjectTools.project_hybrid_search",
      "function",
      "sig-1",
      "indexed",
      1,
      null,
      new Date().toISOString(),
    );

  await usecase.run<any, any>("project.task_registry_upsert", {
    ...ctx,
    payload: {
      task_id: "ASM-79",
      project_id: projectId,
      task_title: "Hybrid retrieval and lineage context assembly",
      task_type: "implementation",
      task_status: "in_progress",
      tracker_issue_key: "ASM-79",
      files_touched: [
        "src/tools/project-tools.ts",
        "src/core/usecases/default-memory-usecase-port.ts",
      ],
      symbols_touched: ["project_hybrid_search", "project_task_lineage_context"],
      commit_refs: ["abc123"],
      decision_notes: "keep code_light and avoid queue wiring",
    },
  });

  await usecase.run<any, any>("project.task_registry_upsert", {
    ...ctx,
    payload: {
      task_id: "ASM-78",
      project_id: projectId,
      task_title: "Incremental reindex diff checksum watch state",
      task_status: "done",
      related_task_ids: ["ASM-79"],
      tracker_issue_key: "ASM-78",
      files_touched: ["src/db/slot-db.ts"],
      symbols_touched: ["reindexProjectByDiff"],
      commit_refs: ["d543cb5"],
      decision_notes: "stabilize watch-state primitive first",
    },
  });

  await usecase.run<any, any>("project.task_registry_upsert", {
    ...ctx,
    payload: {
      task_id: "ASM-70",
      project_id: projectId,
      task_title: "Master architecture spec for project memory",
      task_status: "done",
      tracker_issue_key: "ASM-70",
      related_task_ids: ["ASM-79"],
      files_touched: ["docs/architecture/ASM-70-master-architecture-spec-project-memory-v5.1.md"],
      symbols_touched: [],
      decision_notes: "hybrid retrieval must blend task lineage + code scope",
    },
  });

  // Link parent/related
  await usecase.run<any, any>("project.task_registry_upsert", {
    ...ctx,
    payload: {
      task_id: "ASM-79",
      project_id: projectId,
      task_title: "Hybrid retrieval and lineage context assembly",
      parent_task_id: "ASM-70",
      related_task_ids: ["ASM-78"],
      tracker_issue_key: "ASM-79",
      files_touched: ["src/tools/project-tools.ts", "src/core/usecases/default-memory-usecase-port.ts"],
      symbols_touched: ["project_hybrid_search", "project_task_lineage_context"],
      commit_refs: ["abc123"],
      decision_notes: "blend lexical + lineage weighting",
    },
  });

  await test("project.task_lineage_context assembles focus + parent + related + touched scope", async () => {
    const result = await usecase.run<any, any>("project.task_lineage_context", {
      ...ctx,
      payload: {
        project_id: projectId,
        tracker_issue_key: "ASM-79",
      },
    });

    assertEqual(result.focus.task_id, "ASM-79", "focus should resolve by tracker key");
    assert(result.parent_chain.some((t: any) => t.task_id === "ASM-70"), "parent chain should include ASM-70");
    assert(result.related_tasks.some((t: any) => t.task_id === "ASM-78"), "related tasks should include ASM-78");
    assert(result.touched_files.includes("src/tools/project-tools.ts"), "touched files should aggregate focus scope");
    assert(result.decision_notes.some((n: string) => n.includes("hybrid")), "decision notes should aggregate lineage decisions");
  });

  await test("project.hybrid_search ranks file/symbol/task with lineage context", async () => {
    const result = await usecase.run<any, any>("project.hybrid_search", {
      ...ctx,
      payload: {
        project_id: projectId,
        query: "hybrid search lineage",
        limit: 10,
        task_context: {
          tracker_issue_key: "ASM-79",
          include_related: true,
          include_parent_chain: true,
        },
      },
    });

    assertEqual(result.project_id, projectId, "hybrid search should bind project_id");
    assert(result.count > 0, "hybrid search should return results");
    assert(Boolean(result.task_lineage_context), "hybrid search should include lineage context");
    assert(result.results.some((r: any) => r.source === "task_registry" && r.task_id === "ASM-79"), "task result should include ASM-79");
    assert(result.results.some((r: any) => r.source === "file_index_state" && r.relative_path === "src/tools/project-tools.ts"), "file result should include touched file");
    assert(result.results.some((r: any) => r.source === "symbol_registry" && r.symbol_name === "project_hybrid_search"), "symbol result should include seeded symbol");

    for (let i = 1; i < result.results.length; i++) {
      assert(result.results[i - 1].score >= result.results[i].score, "results must be ranked descending by score");
    }
  });

  await test("project.hybrid_search supports lexical filters", async () => {
    const result = await usecase.run<any, any>("project.hybrid_search", {
      ...ctx,
      payload: {
        project_id: projectId,
        query: "project",
        path_prefix: ["src/core/"],
      },
    });

    assert(
      result.results
        .filter((r: any) => r.source === "file_index_state")
        .every((r: any) => String(r.relative_path || "").startsWith("src/core/")),
      "file results must honor path_prefix filter",
    );
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
