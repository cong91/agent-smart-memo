#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { runInitOpenClaw } from "../scripts/init-openclaw.mjs";

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

export function createShellRunner(spawnImpl = spawnSync) {
  return (command, args = []) => {
    const result = spawnImpl(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    return {
      ok: result.status === 0 && !result.error,
      code: result.status ?? (result.error ? 1 : 0),
      stdout: text(result.stdout),
      stderr: text(result.stderr),
      error: result.error ? String(result.error.message || result.error) : "",
    };
  };
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

  if (first === "init-openclaw") {
    return { command: "init-openclaw", argv: args.slice(1) };
  }

  if (first === "init" && (args[1] || "") === "openclaw") {
    return { command: "init-openclaw", argv: args.slice(2) };
  }

  return { command: "unknown", argv: args };
}

export function printHelp(log = console.log) {
  log("asm - Agent Smart Memo CLI");
  log("");
  log("Usage:");
  log("  asm setup-openclaw [--yes]");
  log("  asm setup openclaw [--yes]");
  log("  asm init-openclaw [--non-interactive]");
  log("  asm init openclaw [--non-interactive]");
  log("  asm help");
  log("");
  log("Roadmap commands (not implemented yet):");
  log("  asm setup-paperclip");
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

  console.error(`[ASM-84] Unknown command: ${argv.join(" ") || "(empty)"}`);
  printHelp(console.error);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
