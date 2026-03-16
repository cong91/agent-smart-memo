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
    assertEqual(triggered.detached, true, "trigger should be detached/background friendly");
    assert(Boolean(triggered.job_id), "trigger should return background job_id");
    assertEqual(triggered.run_id, null, "trigger should not block for foreground run_id");
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

  await test("project.feature_pack.generate builds onboarding/registration/indexing pack", async () => {
    const current = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: { project_alias: "agent-smart-memo-cmd" },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-onboarding-1",
        project_id: current.project.project_id,
        task_title: "Project onboarding registration indexing flow",
        tracker_issue_key: "ASM-93",
        task_status: "done",
        files_touched: ["src/tools/project-tools.ts", "src/core/usecases/default-memory-usecase-port.ts"],
        symbols_touched: ["project.register_command", "project.trigger_index"],
      },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-retrieval-1",
        project_id: current.project.project_id,
        task_title: "Code aware retrieval hybrid search and symbol graph",
        tracker_issue_key: "ASM-92",
        task_status: "done",
        files_touched: ["src/db/slot-db.ts", "src/tools/project-tools.ts"],
        symbols_touched: ["project.hybrid_search", "graph.code.chain"],
      },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-health-1",
        project_id: current.project.project_id,
        task_title: "Runtime health integrity and heartbeat watch state",
        tracker_issue_key: "ASM-78",
        task_status: "done",
        files_touched: ["src/db/slot-db.ts"],
        symbols_touched: ["project.index_watch_get", "project.trigger_index"],
      },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-impact-1",
        project_id: current.project.project_id,
        task_title: "Change aware impact via reindex diff and task lineage",
        tracker_issue_key: "ASM-78",
        task_status: "done",
        files_touched: ["src/db/slot-db.ts", "src/core/usecases/default-memory-usecase-port.ts"],
        symbols_touched: ["project.reindex_diff", "project.task_lineage_context"],
      },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-post-entry-1",
        project_id: current.project.project_id,
        task_title: "Post-entry review decision support trace coverage",
        tracker_issue_key: "TAA-123",
        task_status: "done",
        files_touched: ["src/trading/post-entry-review.service.ts"],
        symbols_touched: ["PostEntryReviewService.reviewOutcome"],
      },
    });

    await usecase.run<any, any>("project.reindex_diff", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        source_rev: "asm-93-pack-test",
        trigger_type: "bootstrap",
        paths: [
          {
            relative_path: "src/tools/project-tools.ts",
            module: "tools",
            language: "ts",
            content: "export function registerProjectTools() {}\nexport async function project_hybrid_search() {}",
          },
          {
            relative_path: "src/commands/telegram-addproject-command.ts",
            module: "commands",
            language: "ts",
            content: "export function registerTelegramAddProjectCommand() {}",
          },
          {
            relative_path: "src/db/slot-db.ts",
            module: "db",
            language: "ts",
            content: "export function getProjectFeaturePackProjectOnboardingIndexingSnapshot() {}\nexport function hybridSearchProjectContext() {}",
          },
        ],
      },
    });

    const onboardingPack = await usecase.run<any, any>("project.feature_pack.generate", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "project_onboarding_registration_indexing",
      },
    });

    assertEqual(onboardingPack.feature_key, "project_onboarding_registration_indexing", "feature key should match");
    assert(onboardingPack.primary_files.includes("src/tools/project-tools.ts"), "pack should include project tool file");
    assert(onboardingPack.primary_symbols.includes("project.register_command"), "pack should include registration symbol");
    assert(onboardingPack.flow_steps.length >= 4, "pack should include minimal flow steps");
    assert(onboardingPack.related_tasks.includes("ASM-93") || onboardingPack.related_tasks.includes("task-onboarding-1"), "pack should include related task evidence");
    assert(onboardingPack.evidence.some((item: any) => item.type === "index"), "pack should include index evidence");

    const retrievalPack = await usecase.run<any, any>("project.feature_pack.generate", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "code_aware_retrieval",
      },
    });
    assertEqual(retrievalPack.feature_key, "code_aware_retrieval", "retrieval feature key should match");
    assert(retrievalPack.primary_symbols.includes("project.hybrid_search"), "retrieval pack should include hybrid search symbol");

    const heartbeatPack = await usecase.run<any, any>("project.feature_pack.generate", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "heartbeat_health_runtime_integrity",
      },
    });
    assertEqual(heartbeatPack.feature_key, "heartbeat_health_runtime_integrity", "heartbeat feature key should match");
    assert(heartbeatPack.evidence.some((item: any) => item.type === "registration" || item.type === "index"), "heartbeat pack should include integrity evidence");

    const impactPack = await usecase.run<any, any>("project.feature_pack.generate", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "change_aware_impact",
      },
    });
    assertEqual(impactPack.feature_key, "change_aware_impact", "impact feature key should match");
    assert(impactPack.primary_symbols.includes("project.reindex_diff"), "impact pack should include reindex diff symbol");

    const postEntryPack = await usecase.run<any, any>("project.feature_pack.generate", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "post_entry_review_decision_support",
      },
    });
    assertEqual(postEntryPack.feature_key, "post_entry_review_decision_support", "post-entry feature key should match");
    assert(postEntryPack.related_tasks.includes("TAA-123") || postEntryPack.related_tasks.includes("task-post-entry-1"), "post-entry pack should include decision-support task evidence");

    const queryByKey = await usecase.run<any, any>("project.feature_pack.query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_key: "code_aware_retrieval",
      },
    });
    assertEqual(queryByKey.feature_key, "code_aware_retrieval", "query by key should resolve retrieval pack");
    assertEqual(queryByKey.pack.feature_key, "code_aware_retrieval", "query result pack should align with key");

    const queryByName = await usecase.run<any, any>("project.feature_pack.query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        feature_name: "post entry review decision support",
      },
    });
    assertEqual(queryByName.feature_key, "post_entry_review_decision_support", "query by feature_name should normalize selector");
    assertEqual(queryByName.pack.feature_key, "post_entry_review_decision_support", "query by name should return post-entry pack");
  });

  await test("project.developer_query benchmark/hardening covers 5 developer query groups", async () => {
    const locate = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        query: "project_hybrid_search",
        intent: "locate",
        limit: 5,
      },
    });

    assertEqual(locate.intent, "locate", "locate intent should be preserved");
    assert(Array.isArray(locate.primary_results) && locate.primary_results.length >= 1, "locate should return primary results");
    assert(Array.isArray(locate.files), "locate response should expose files[] contract");
    assert(Array.isArray(locate.symbols), "locate response should expose symbols[] contract");
    assertEqual(locate.generator_version, "asm-109-slice1", "locate response generator should match asm-109 slice1");
    assert(Array.isArray(locate.assembly_sources), "locate response should expose assembly_sources");
    assert(locate.assembly_sources.includes("file") || locate.assembly_sources.includes("symbol"), "locate should include file/symbol assembly source");
    assertEqual(locate.answer_template, "locate", "locate should use locate template");
    assert(typeof locate.answer_summary === "string" && locate.answer_summary.length > 0, "locate should expose answer_summary");
    assert(Array.isArray(locate.answer_points) && locate.answer_points.length >= 1, "locate should expose answer_points");
    assert(locate.confidence.reason.includes("intent=locate"), "locate confidence reason should include intent marker");
    assert(typeof locate.explainability === "object" && Array.isArray(locate.explainability.ranking_rules), "locate should expose explainability");

    const traceFlow = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        query: "trace flow ASM-78 from reindex to overlay",
        intent: "trace_flow",
      },
    });

    assertEqual(traceFlow.intent, "trace_flow", "trace_flow intent should be preserved");
    assert(traceFlow.assembly_sources.includes("change_overlay"), "trace_flow should include change_overlay assembly source");
    assert(traceFlow.change_context.includes("ASM-78"), "trace_flow should include tracker issue context");
    assert(traceFlow.why_this_result.some((line: string) => line.includes("task_context applied")), "trace_flow should apply task_context when possible");

    const impact = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        query: "impact of ASM-78 reindex diff changes",
        intent: "impact",
      },
    });

    assertEqual(impact.intent, "impact", "impact intent should be preserved");
    assert(Array.isArray(impact.feature_packs) && impact.feature_packs.length >= 1, "impact should attach at least one feature pack");
    assertEqual(impact.feature_packs[0].feature_key, "change_aware_impact", "impact should default to change_aware_impact pack");
    assert(impact.assembly_sources.includes("change_overlay"), "impact should include overlay source");

    const changeAware = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        query: "change-aware lookup for ASM-78 overlay",
        intent: "change_aware_lookup",
      },
    });

    assertEqual(changeAware.intent, "change_aware_lookup", "change-aware intent should be preserved");
    assert(changeAware.assembly_sources.includes("change_overlay"), "change-aware lookup should include change_overlay source");
    assert(changeAware.assembly_sources.includes("feature_pack"), "change-aware lookup should include feature_pack source");
    assert(changeAware.primary_results.some((item: any) => item.type === "symbol"), "change-aware lookup should prioritize symbol-level results");

    const feature = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        query: "code aware retrieval",
        intent: "feature_understanding",
      },
    });

    assertEqual(feature.intent, "feature_understanding", "feature intent should be preserved");
    assert(Array.isArray(feature.feature_packs) && feature.feature_packs.length === 1, "feature query should return one feature pack");
    assertEqual(feature.feature_packs[0].feature_key, "code_aware_retrieval", "feature query should resolve retrieval pack");
    assert(Array.isArray(feature.primary_results) && feature.primary_results[0]?.type === "feature_pack", "feature query primary result should be feature_pack");
    assertEqual(feature.generator_version, "asm-109-slice1", "feature response generator should match asm-109 slice1");
    assert(Array.isArray(feature.assembly_sources), "feature response should expose assembly_sources");
    assert(feature.assembly_sources.includes("feature_pack"), "feature response should include feature_pack assembly source");
    assertEqual(feature.answer_template, "feature_understanding", "feature response should use feature template");
    assert(typeof feature.answer_summary === "string" && feature.answer_summary.length > 0, "feature response should expose answer_summary");
    assert(Array.isArray(feature.answer_points) && feature.answer_points.length >= 1, "feature response should expose answer_points");
    assert(typeof feature.explainability === "object" && feature.explainability.top_n?.primary_results === 12, "feature response should expose explainability top_n");

    const typedLocateSymbol = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        intent: "locate_symbol",
        symbol_name: "project_hybrid_search",
      },
    });
    assertEqual(typedLocateSymbol.intent, "locate", "typed locate_symbol should map to legacy locate response intent");
    assert(
      typedLocateSymbol.explainability.ranking_rules.some((rule: string) => rule.includes("typed query parser")),
      "typed locate_symbol should expose parser rule in explainability",
    );
    assert(
      typedLocateSymbol.explainability.ranking_rules.some((rule: string) => rule.includes("retrieval plan locate_symbol")),
      "typed locate_symbol should apply locate_symbol retrieval plan",
    );

    const typedLocateFile = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        intent: "locate_file",
        relative_path: "src/tools/project-tools.ts",
      },
    });
    assertEqual(typedLocateFile.intent, "locate", "typed locate_file should map to legacy locate response intent");
    assert(typedLocateFile.files.includes("src/tools/project-tools.ts"), "typed locate_file should include requested path");
    assert(
      typedLocateFile.why_this_result.some((line: string) => line.includes("path_prefix hint")),
      "typed locate_file should include path_prefix hint for file-first retrieval",
    );

    const typedFeatureLookup = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        intent: "feature_lookup",
        query: "code aware retrieval",
      },
    });
    assertEqual(typedFeatureLookup.intent, "feature_understanding", "typed feature_lookup should map to feature_understanding");
    assertEqual(typedFeatureLookup.feature_packs[0].feature_key, "code_aware_retrieval", "typed feature lookup should resolve pack deterministically");
    assert(
      typedFeatureLookup.primary_results[0]?.type === "feature_pack",
      "typed feature_lookup should prefer feature pack in primary results",
    );
    assert(
      typedFeatureLookup.explainability.ranking_rules.some((rule: string) => rule.includes("retrieval plan feature_lookup")),
      "typed feature_lookup should apply feature_lookup retrieval plan",
    );

    const typedChangeLookup = await usecase.run<any, any>("project.developer_query", {
      ...ctx,
      payload: {
        project_alias: "agent-smart-memo-cmd",
        intent: "change_lookup",
        tracker_issue_key: "ASM-78",
        query: "overlay for asm-78",
      },
    });
    assertEqual(typedChangeLookup.intent, "change_aware_lookup", "typed change_lookup should map to change_aware_lookup");
    assert(typedChangeLookup.assembly_sources.includes("change_overlay"), "typed change_lookup should include overlay source");
    assert(
      typedChangeLookup.why_this_result.some((line: string) => line.includes("intent-aware task_context applied")),
      "typed change_lookup should apply task-context retrieval plan",
    );
    assert(
      typedChangeLookup.explainability.ranking_rules.some((rule: string) => rule.includes("retrieval plan change_lookup")),
      "typed change_lookup should apply change_lookup retrieval plan",
    );
  });

  await test("project.change_overlay.query maps overlay -> feature packs with confidence ordering", async () => {
    const current = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: { project_alias: "agent-smart-memo-cmd" },
    });

    await usecase.run<any, any>("project.task_registry_upsert", {
      ...ctx,
      payload: {
        task_id: "task-overlay-1",
        project_id: current.project.project_id,
        task_title: "Change aware impact via reindex diff and task lineage",
        tracker_issue_key: "ASM-78",
        task_status: "done",
        files_touched: ["src/tools/project-tools.ts", "src/db/slot-db.ts"],
        symbols_touched: ["project.change_overlay.query", "queryProjectChangeOverlay"],
        commit_refs: ["abc1234"],
      },
    });

    await usecase.run<any, any>("project.reindex_diff", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        source_rev: "asm-94-overlay-test",
        trigger_type: "incremental",
        paths: [
          {
            relative_path: "src/tools/project-tools.ts",
            module: "tools",
            language: "ts",
            content: "export function registerProjectTools() {}\nexport async function project_change_overlay_query() {}",
          },
          {
            relative_path: "src/db/slot-db.ts",
            module: "db",
            language: "ts",
            content: "export function queryProjectChangeOverlay() {}",
          },
        ],
      },
    });

    const overlay = await usecase.run<any, any>("project.change_overlay.query", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        tracker_issue_key: "ASM-78",
      },
    });

    assertEqual(overlay.generator_version, "asm-94-slice3", "overlay version should match ASM-94 slice3");
    assertEqual(overlay.focus.tracker_issue_key, "ASM-78", "focus tracker should match");
    assert(overlay.changed_files.includes("src/tools/project-tools.ts"), "overlay should include changed file from task lineage");
    assert(overlay.related_symbols.some((s: any) => s.symbol_name === "queryProjectChangeOverlay"), "overlay should include related symbols");
    assert(overlay.related_symbols.length >= 1, "overlay should expose at least one related symbol");
    assert(overlay.commit_refs.includes("abc1234"), "overlay should expose commit refs");
    assert(Array.isArray(overlay.feature_packs), "overlay should include feature pack matches");
    assert(overlay.feature_packs.some((p: any) => p.feature_key === "change_aware_impact"), "overlay should map to change_aware_impact when evidence exists");
    assert(overlay.feature_packs.every((p: any) => Number(p.confidence) >= 0.25), "feature pack matches should be confidence-scored");
    assert(typeof overlay.confidence?.overall === "number" && overlay.confidence.overall > 0, "overlay should expose overall confidence");
    assert(
      overlay.related_symbols.every((s: any) => typeof s.confidence === "number"),
      "related symbols should be enriched with confidence",
    );
    const symbolConfidences = overlay.related_symbols.map((s: any) => Number(s.confidence || 0));
    for (let i = 1; i < symbolConfidences.length; i += 1) {
      assert(symbolConfidences[i - 1] >= symbolConfidences[i], "related symbols should be sorted by confidence desc");
    }

    const overlayByFeatureKey = await usecase.run<any, any>("project.change_overlay.query", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        tracker_issue_key: "ASM-78",
        feature_key: "change_aware_impact",
      },
    });
    assertEqual(overlayByFeatureKey.feature_packs.length, 1, "feature_key should narrow overlay to one matched feature pack");
    assertEqual(overlayByFeatureKey.feature_packs[0].feature_key, "change_aware_impact", "feature_key selection should be applied");

    const overlayByFeatureName = await usecase.run<any, any>("project.change_overlay.query", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        tracker_issue_key: "ASM-78",
        feature_name: "change aware impact",
      },
    });
    assertEqual(overlayByFeatureName.feature_packs.length, 1, "feature_name should narrow overlay to one matched feature pack");
    assertEqual(overlayByFeatureName.feature_packs[0].feature_key, "change_aware_impact", "feature_name normalization should be applied");
  });

  await test("project.change_overlay.query returns controlled empty overlay when selector does not resolve", async () => {
    const current = await usecase.run<any, any>("project.get", {
      ...ctx,
      payload: { project_alias: "agent-smart-memo-cmd" },
    });

    const overlay = await usecase.run<any, any>("project.change_overlay.query", {
      ...ctx,
      payload: {
        project_id: current.project.project_id,
        tracker_issue_key: "ASM-DOES-NOT-EXIST",
      },
    });

    assertEqual(overlay.project_id, current.project.project_id, "overlay should keep project id");
    assertEqual(overlay.status, "selector_not_resolved", "overlay should return structured unresolved status");
    assertEqual(overlay.reason, "task lineage focus not found for provided selector", "overlay should include unresolved reason");
    assertEqual(overlay.recoverable, true, "unresolved selector should be recoverable");
    assertEqual(overlay.selector?.tracker_issue_key, "ASM-DOES-NOT-EXIST", "overlay should echo unresolved selector");
    assertEqual(overlay.focus.tracker_issue_key, "ASM-DOES-NOT-EXIST", "overlay should echo unresolved tracker selector");
    assert(Array.isArray(overlay.changed_files) && overlay.changed_files.length === 0, "overlay should gracefully return empty changed_files");
    assert(Array.isArray(overlay.related_symbols) && overlay.related_symbols.length === 0, "overlay should gracefully return empty related_symbols");
    assert(Array.isArray(overlay.commit_refs) && overlay.commit_refs.length === 0, "overlay should gracefully return empty commit_refs");
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
