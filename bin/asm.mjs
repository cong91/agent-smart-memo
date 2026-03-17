#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInitOpenClaw } from "../scripts/init-openclaw.mjs";
import { createShellRunner, runInitSetupFlow, runInstallPlatformFlow } from "../src/cli/platform-installers.ts";
import { runOpencodeMcpServer } from "./opencode-mcp-server.mjs";

const ASM_PLUGIN_PACKAGE = "@mrc2204/agent-smart-memo";
const ASM_PLUGIN_ID = "agent-smart-memo";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function includesAsmPlugin(output) {
  const haystack = String(output || "").toLowerCase();
  return (
    haystack.includes(ASM_PLUGIN_ID) ||
    haystack.includes(ASM_PLUGIN_PACKAGE.toLowerCase())
  );
}

export function parseAsmCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((x) => String(x)) : [];
  const first = args[0] || "";

  if (!first || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", argv: [] };
  }

  if (first === "setup-openclaw") {
    return { command: "setup-openclaw", argv: args.slice(1) };
  }

  if (first === "setup" && (args[1] || "") === "openclaw") {
    return { command: "setup-openclaw", argv: args.slice(2) };
  }

  if (first === "install" && (args[1] || "")) {
    return {
      command: "install-platform",
      platform: String(args[1] || "").trim().toLowerCase(),
      argv: args.slice(2),
    };
  }

  if (first === "init-setup") {
    return { command: "init-setup", argv: args.slice(1) };
  }

  if (first === "init" && (args[1] || "") === "setup") {
    return { command: "init-setup", argv: args.slice(2) };
  }

  if (first === "init-openclaw") {
    return { command: "init-openclaw", argv: args.slice(1) };
  }

  if (first === "init" && (args[1] || "") === "openclaw") {
    return { command: "init-openclaw", argv: args.slice(2) };
  }

  if (first === "project-event") {
    return { command: "project-event", argv: args.slice(1) };
  }

  if (first === "mcp" && (args[1] || "") === "opencode") {
    return { command: "mcp-opencode", argv: args.slice(2) };
  }

  return { command: "unknown", argv: args };
}

export function printHelp(log = console.log) {
  log("asm - Agent Smart Memo CLI");
  log("");
  log("Usage:");
  log("  asm setup-openclaw [--yes]");
  log("  asm setup openclaw [--yes]");
  log("  asm install openclaw [--yes]");
  log("  asm install paperclip");
  log("  asm install opencode");
  log("  asm init-setup [--yes]");
  log("  asm init setup [--yes]");
  log("  asm init-openclaw [--non-interactive]");
  log("  asm init openclaw [--non-interactive]");
  log("  asm project-event --project-id <id> --repo-root <path> [--event-type post_commit|post_merge|post_rewrite|manual] [--source-rev <sha>] [--changed-files a,b] [--deleted-files x,y] [--trusted-sync 0|1] [--full-snapshot 0|1]");
  log("  asm help");
  log("");
  log("Roadmap commands (not implemented yet):");
  log("  asm doctor");
  log("  asm test-openclaw");
}

export function detectPluginInstalled(runner = createShellRunner()) {
  const tryJson = runner("openclaw", ["plugins", "list", "--json"]);
  if (tryJson.ok) {
    try {
      const parsed = JSON.parse(tryJson.stdout || "{}");
      const pool = [
        ...(Array.isArray(parsed) ? parsed : []),
        ...(Array.isArray(parsed?.plugins) ? parsed.plugins : []),
      ];

      for (const item of pool) {
        const name = text(item?.name || item?.id || item?.package || item?.pluginId);
        if (!name) continue;
        if (includesAsmPlugin(name)) {
          return { installed: true, source: "list-json" };
        }
      }
    } catch {
      if (includesAsmPlugin(tryJson.stdout)) {
        return { installed: true, source: "list-json-text" };
      }
    }
  }

  const tryText = runner("openclaw", ["plugins", "list"]);
  if (tryText.ok && includesAsmPlugin(tryText.stdout)) {
    return { installed: true, source: "list-text" };
  }

  return { installed: false, source: "missing" };
}

function parseNonInteractiveFlags(argv = []) {
  const args = Array.isArray(argv) ? argv.map((x) => String(x).trim()).filter(Boolean) : [];
  const hasYes = args.includes("--yes") || args.includes("-y");
  const hasNonInteractive = args.includes("--non-interactive");

  return {
    nonInteractive: hasYes || hasNonInteractive,
    autoApply: hasYes || hasNonInteractive,
  };
}

function parseProjectEventArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((x) => String(x)) : [];
  const out = {
    projectId: "",
    repoRoot: "",
    sourceRev: "",
    eventType: "manual",
    changedFiles: [],
    deletedFiles: [],
    trustedSync: false,
    fullSnapshot: false,
  };
  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    const next = args[i + 1] || "";
    if (cur === "--project-id") { out.projectId = next; i++; continue; }
    if (cur === "--repo-root") { out.repoRoot = next; i++; continue; }
    if (cur === "--source-rev") { out.sourceRev = next; i++; continue; }
    if (cur === "--event-type") { out.eventType = next || "manual"; i++; continue; }
    if (cur === "--changed-files") { out.changedFiles = next ? next.split(",").map((s) => s.trim()).filter(Boolean) : []; i++; continue; }
    if (cur === "--deleted-files") { out.deletedFiles = next ? next.split(",").map((s) => s.trim()).filter(Boolean) : []; i++; continue; }
    if (cur === "--trusted-sync") { out.trustedSync = next === "1" || next === "true"; i++; continue; }
    if (cur === "--full-snapshot") { out.fullSnapshot = next === "1" || next === "true"; i++; continue; }
  }
  return out;
}

export async function runSetupOpenClawFlow({
  runner = createShellRunner(),
  initOpenClaw = runInitOpenClaw,
  log = console.log,
  argv = [],
} = {}) {
  log("[ASM-84] setup-openclaw: checking OpenClaw CLI ...");
  const openclawVersion = runner("openclaw", ["--version"]);
  if (!openclawVersion.ok) {
    log("[ASM-84] ❌ openclaw binary not found or not executable.");
    if (openclawVersion.stderr) log(`[ASM-84] details: ${openclawVersion.stderr}`);
    if (openclawVersion.error) log(`[ASM-84] error: ${openclawVersion.error}`);
    log("[ASM-84] Please install OpenClaw first, then re-run: asm setup-openclaw");
    return { ok: false, step: "check-openclaw" };
  }

  const pluginState = detectPluginInstalled(runner);
  const setupSummary = pluginState.installed
    ? {
        alreadyConfigured: [`plugin installed: ${ASM_PLUGIN_PACKAGE}`],
        willAdd: [],
        willUpdate: ["openclaw.json bootstrap via init-openclaw wizard"],
      }
    : {
        alreadyConfigured: [],
        willAdd: [`plugin install: ${ASM_PLUGIN_PACKAGE}`],
        willUpdate: ["openclaw.json bootstrap via init-openclaw wizard"],
      };

  log("[ASM-84] Setup summary (before execution):");
  log(`- already configured (${setupSummary.alreadyConfigured.length})`);
  if (!setupSummary.alreadyConfigured.length) log("  • (none)");
  for (const item of setupSummary.alreadyConfigured) log(`  • ${item}`);
  log(`- will add (${setupSummary.willAdd.length})`);
  if (!setupSummary.willAdd.length) log("  • (none)");
  for (const item of setupSummary.willAdd) log(`  • ${item}`);
  log(`- will update (${setupSummary.willUpdate.length})`);
  if (!setupSummary.willUpdate.length) log("  • (none)");
  for (const item of setupSummary.willUpdate) log(`  • ${item}`);

  if (pluginState.installed) {
    log(`[ASM-84] plugin already installed (${pluginState.source}).`);
  } else {
    log(`[ASM-84] plugin not detected. Installing: ${ASM_PLUGIN_PACKAGE}`);
    const install = runner("openclaw", ["plugins", "install", ASM_PLUGIN_PACKAGE]);
    if (!install.ok) {
      log("[ASM-84] ❌ failed to install plugin via OpenClaw CLI.");
      if (install.stdout) log(install.stdout);
      if (install.stderr) log(install.stderr);
      return { ok: false, step: "install-plugin" };
    }
    log("[ASM-84] plugin install command completed.");
  }

  const mode = parseNonInteractiveFlags(argv);
  if (mode.nonInteractive) {
    log("[ASM-84] non-interactive mode enabled; applying defaults/merged config without prompt.");
  }

  log("[ASM-84] launching init-openclaw bootstrap flow ...");
  const result = await initOpenClaw({ interactive: !mode.nonInteractive, autoApply: mode.autoApply });

  if (!result?.applied) {
    log("[ASM-84] setup-openclaw ended without changes (aborted or no write).");
    return { ok: true, step: "init-openclaw", applied: false };
  }

  log("[ASM-84] ✅ setup-openclaw completed.");
  log("[ASM-84] Next steps:");
  log("  1) Restart OpenClaw runtime");
  log("  2) Verify plugin loaded and memory tools available");
  log("  3) Run a quick smoke: memory_slot_set + memory_slot_get");

  return { ok: true, step: "done", applied: true };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseAsmCliArgs(argv);
  if (parsed.command === "help") {
    printHelp();
    return 0;
  }

  if (parsed.command === "setup-openclaw") {
    const result = await runSetupOpenClawFlow({ argv: parsed.argv });
    return result.ok ? 0 : 1;
  }

  if (parsed.command === "install-platform") {
    const result = await runInstallPlatformFlow({
      platform: parsed.platform,
      runner: createShellRunner(),
      initOpenClaw: runInitOpenClaw,
      log: console.log,
      argv: parsed.argv,
      env: process.env,
      homeDir: process.env.HOME,
    });
    return result.ok ? 0 : 1;
  }

  if (parsed.command === "init-setup") {
    const result = await runInitSetupFlow({ log: console.log, env: process.env, homeDir: process.env.HOME, argv: parsed.argv });
    return result.ok ? 0 : 1;
  }

  if (parsed.command === "init-openclaw") {
    const mode = parseNonInteractiveFlags(parsed.argv);
    try {
      const result = await runInitOpenClaw({ interactive: !mode.nonInteractive, autoApply: mode.autoApply });
      return result?.applied || mode.autoApply ? 0 : 0;
    } catch (error) {
      console.error(`[ASM-84] init-openclaw failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (parsed.command === "mcp-opencode") {
    await runOpencodeMcpServer();
    return 0;
  }

  if (parsed.command === "project-event") {
    const event = parseProjectEventArgs(parsed.argv);
    if (!event.projectId || !event.repoRoot) {
      console.error('[ASM-87] project-event requires --project-id and --repo-root');
      return 1;
    }
    const pluginId = 'agent-smart-memo';
    const cfgPath = resolve(process.env.HOME || '', '.openclaw', 'openclaw.json');
    let qdrantCollection = 'mrc_bot';
    let llmBaseUrl = 'http://localhost:8317/v1';
    let llmApiKey = 'proxypal-local';
    let llmModel = 'gpt-5.4';
    let embedModel = 'qwen3-embedding:0.6b';
    let embedDimensions = 1024;
    let slotDbDir = resolve(process.env.HOME || '', '.openclaw', 'agent-memo');
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const cfg = raw?.plugins?.entries?.[pluginId]?.config || {};
      qdrantCollection = cfg.qdrantCollection || qdrantCollection;
      llmBaseUrl = cfg.llmBaseUrl || llmBaseUrl;
      llmApiKey = cfg.llmApiKey || llmApiKey;
      llmModel = cfg.llmModel || llmModel;
      embedModel = cfg.embedModel || embedModel;
      embedDimensions = cfg.embedDimensions || embedDimensions;
      slotDbDir = cfg.slotDbDir || slotDbDir;
    } catch {}

    process.env.OPENCLAW_SLOTDB_DIR = slotDbDir;
    process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT = event.repoRoot;
    process.env.AGENT_MEMO_REPO_CLONE_ROOT = event.repoRoot;
    process.env.PROJECT_WORKSPACE_ROOT = event.repoRoot;
    process.env.REPO_CLONE_ROOT = event.repoRoot;
    process.env.QDRANT_COLLECTION = qdrantCollection;
    process.env.LLM_BASE_URL = llmBaseUrl;
    process.env.LLM_API_KEY = llmApiKey;
    process.env.LLM_MODEL = llmModel;
    process.env.EMBED_MODEL = embedModel;
    process.env.EMBEDDING_MODEL = embedModel;
    process.env.EMBEDDING_DIMENSIONS = String(embedDimensions);

    const { SlotDB } = await import('../dist/db/slot-db.js');
    const { DefaultMemoryUseCasePort } = await import('../dist/core/usecases/default-memory-usecase-port.js');
    const db = new SlotDB(slotDbDir);
    const usecase = new DefaultMemoryUseCasePort(db);
    try {
      const result = await usecase.run('project.index_event', {
        context: { userId: 'telegram:dm:5165741309', agentId: 'assistant', metadata: { projectWorkspaceRoot: event.repoRoot } },
        meta: { source: 'cli', toolName: 'asm.project-event', projectWorkspaceRoot: event.repoRoot },
        payload: {
          project_id: event.projectId,
          repo_root: event.repoRoot,
          source_rev: event.sourceRev || null,
          event_type: event.eventType,
          changed_files: event.changedFiles,
          deleted_files: event.deletedFiles,
          trusted_sync: event.trustedSync,
          full_snapshot: event.fullSnapshot,
        },
      });
      console.log(JSON.stringify(result, null, 2));
      db.close();
      return 0;
    } catch (error) {
      db.close();
      console.error(`[ASM-87] project-event failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  console.error(`[ASM-84] Unknown command: ${argv.join(" ") || "(empty)"}`);
  printHelp(console.error);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
