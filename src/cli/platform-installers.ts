import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { doctorAsmSharedConfig, getAsmSharedConfig, resolveAsmConfigPath } from "../shared/asm-config.ts";
import { runInitOpenClaw } from "../../scripts/init-openclaw.mjs";

export interface AsmShellResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  error: string;
}

export type AsmShellRunner = (command: string, args?: string[]) => AsmShellResult;

export interface AsmInstallContext {
  runner: AsmShellRunner;
  log: (line: string) => void;
  argv: string[];
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  initOpenClaw: typeof runInitOpenClaw;
}

export interface AsmInstallerDescriptor {
  id: string;
  displayName: string;
  status: "implemented" | "planned";
  summary: string;
  requiredSharedConfigKeys: string[];
  platformLocalConfigPaths: string[];
}

export interface AsmInstallerResult {
  ok: boolean;
  step: string;
  platform: string;
  details?: Record<string, unknown>;
}

export interface AsmPlatformInstaller {
  id: string;
  describe(): AsmInstallerDescriptor;
  install(ctx: AsmInstallContext): Promise<AsmInstallerResult>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function includesAsmPlugin(output: unknown): boolean {
  const haystack = String(output || "").toLowerCase();
  return haystack.includes("agent-smart-memo") || haystack.includes("@mrc2204/agent-smart-memo");
}

export function createShellRunner(spawnImpl = spawnSync): AsmShellRunner {
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

function parseNonInteractive(argv: string[] = []): { nonInteractive: boolean; autoApply: boolean } {
  const args = Array.isArray(argv) ? argv.map((item) => String(item).trim()).filter(Boolean) : [];
  const enabled = args.includes("--yes") || args.includes("-y") || args.includes("--non-interactive");
  return { nonInteractive: enabled, autoApply: enabled };
}

export async function runInitSetupFlow({
  log = console.log,
  env = process.env,
  homeDir = process.env.HOME,
  argv = [],
}: {
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  argv?: string[];
} = {}) {
  const mode = parseNonInteractive(argv);
  const path = resolveAsmConfigPath({ env, homeDir });
  const doctor = doctorAsmSharedConfig({ env, homeDir });
  const loaded = getAsmSharedConfig({ env, homeDir });

  const baseConfig = loaded.config || { schemaVersion: 1, core: {}, adapters: {} };
  const nextConfig = {
    schemaVersion: typeof baseConfig.schemaVersion === "number" ? baseConfig.schemaVersion : 1,
    ...baseConfig,
    core: {
      ...(baseConfig.core || {}),
      projectWorkspaceRoot: baseConfig.core?.projectWorkspaceRoot || "~/Work/projects",
      storage: {
        ...(baseConfig.core?.storage || {}),
        slotDbDir: baseConfig.core?.storage?.slotDbDir || "~/.local/share/asm/slotdb",
      },
    },
    adapters: {
      ...(baseConfig.adapters || {}),
      openclaw: {
        enabled: true,
        ...((baseConfig.adapters || {}).openclaw || {}),
      },
      paperclip: {
        enabled: true,
        ...((baseConfig.adapters || {}).paperclip || {}),
      },
      opencode: {
        enabled: true,
        mode: "read-only",
        ...((baseConfig.adapters || {}).opencode || {}),
      },
    },
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  log(`[ASM-104] init-setup ${doctor.exists ? "updated" : "created"} shared config at: ${path}`);

  return {
    ok: true,
    step: "init-setup",
    path,
    existed: doctor.exists,
    nonInteractive: mode.nonInteractive,
  };
}

async function runSetupOpenClawInstall(ctx: AsmInstallContext): Promise<AsmInstallerResult> {
  const { runner, initOpenClaw, log, argv } = ctx;
  log("[ASM-84] setup-openclaw: checking OpenClaw CLI ...");
  const openclawVersion = runner("openclaw", ["--version"]);
  if (!openclawVersion.ok) {
    log("[ASM-84] ❌ openclaw binary not found or not executable.");
    if (openclawVersion.stderr) log(`[ASM-84] details: ${openclawVersion.stderr}`);
    if (openclawVersion.error) log(`[ASM-84] error: ${openclawVersion.error}`);
    return { ok: false, step: "check-openclaw", platform: "openclaw" };
  }

  const tryJson = runner("openclaw", ["plugins", "list", "--json"]);
  let installed = false;
  if (tryJson.ok) {
    try {
      const parsed = JSON.parse(tryJson.stdout || "{}");
      const pool = [
        ...(Array.isArray(parsed) ? parsed : []),
        ...(Array.isArray(parsed?.plugins) ? parsed.plugins : []),
      ];
      installed = pool.some((item: any) => includesAsmPlugin(item?.name || item?.id || item?.package || item?.pluginId));
    } catch {
      installed = includesAsmPlugin(tryJson.stdout);
    }
  }
  if (!installed) {
    const tryText = runner("openclaw", ["plugins", "list"]);
    installed = tryText.ok && includesAsmPlugin(tryText.stdout);
  }

  if (!installed) {
    log("[ASM-84] plugin not detected. Installing: @mrc2204/agent-smart-memo");
    const install = runner("openclaw", ["plugins", "install", "@mrc2204/agent-smart-memo"]);
    if (!install.ok) {
      if (install.stderr) log(install.stderr);
      return { ok: false, step: "install-plugin", platform: "openclaw" };
    }
  }

  const mode = parseNonInteractive(argv);
  const initResult = await initOpenClaw({ interactive: !mode.nonInteractive, autoApply: mode.autoApply });
  return {
    ok: true,
    step: initResult?.applied ? "done" : "init-openclaw",
    platform: "openclaw",
    details: { applied: Boolean(initResult?.applied) },
  };
}

function createPlannedInstaller(
  id: "paperclip" | "opencode",
  summary: string,
  requiredSharedConfigKeys: string[],
  platformLocalConfigPaths: string[],
  detailLines: string[],
): AsmPlatformInstaller {
  return {
    id,
    describe() {
      return { id, displayName: id, status: "planned", summary, requiredSharedConfigKeys, platformLocalConfigPaths };
    },
    async install(ctx) {
      ctx.log(`[ASM-104] install ${id} is not implemented yet.`);
      for (const line of detailLines) ctx.log(line);
      return {
        ok: false,
        step: `install-${id}-not-implemented`,
        platform: id,
        details: { requiredSharedConfigKeys, platformLocalConfigPaths },
      };
    },
  };
}

const openclawInstaller: AsmPlatformInstaller = {
  id: "openclaw",
  describe() {
    return {
      id: "openclaw",
      displayName: "OpenClaw",
      status: "implemented",
      summary: "Installs ASM into OpenClaw and bootstraps openclaw.json using the shared ASM config.",
      requiredSharedConfigKeys: ["core.projectWorkspaceRoot", "core.storage.slotDbDir", "adapters.openclaw.enabled"],
      platformLocalConfigPaths: ["~/.openclaw/openclaw.json"],
    };
  },
  async install(ctx) {
    return runSetupOpenClawInstall(ctx);
  },
};

const paperclipInstaller = createPlannedInstaller(
  "paperclip",
  "Prepare/install Paperclip runtime or host plugin path using shared ASM config.",
  ["core.projectWorkspaceRoot", "core.storage.slotDbDir", "adapters.paperclip.enabled"],
  ["paperclip host/plugin config"],
  [
    "[ASM-104] Intended flow: prepare Paperclip runtime/plugin artifact, then guide/install into Paperclip host using shared ASM config.",
    "[ASM-104] Current local references: npm run package:paperclip, npm run package:paperclip:plugin-local, docs/testing/paperclip-local-install-debug-runbook.md",
  ],
);

const opencodeInstaller = createPlannedInstaller(
  "opencode",
  "Bootstrap OpenCode read-only/MCP integration using ASM shared config and ASM-106 retrieval contract.",
  ["core.projectWorkspaceRoot", "core.storage.slotDbDir", "adapters.opencode.enabled", "adapters.opencode.mode"],
  ["opencode config", "mcp config"],
  [
    "[ASM-104] Intended flow: bootstrap read-only/MCP integration and write OpenCode adapter config using ASM shared config.",
    "[ASM-104] Runtime retrieval contract is available via ASM-106; installer wiring remains to be implemented.",
  ],
);

const REGISTRY = new Map<string, AsmPlatformInstaller>([
  [openclawInstaller.id, openclawInstaller],
  [paperclipInstaller.id, paperclipInstaller],
  [opencodeInstaller.id, opencodeInstaller],
]);

export function getAsmPlatformInstaller(platform: string): AsmPlatformInstaller | null {
  const normalized = String(platform || "").trim().toLowerCase();
  return REGISTRY.get(normalized) || null;
}

export function listAsmPlatformInstallers(): AsmInstallerDescriptor[] {
  return Array.from(REGISTRY.values()).map((installer) => installer.describe());
}

export async function runInstallPlatformFlow({
  platform,
  runner,
  initOpenClaw,
  log,
  argv,
  env = process.env,
  homeDir = process.env.HOME,
}: {
  platform?: string;
  runner: AsmShellRunner;
  initOpenClaw: typeof runInitOpenClaw;
  log: (line: string) => void;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<AsmInstallerResult> {
  const installer = getAsmPlatformInstaller(String(platform || ""));
  if (!installer) {
    log(`[ASM-104] Unknown install target: ${String(platform || "(empty)").trim() || "(empty)"}`);
    log(`[ASM-104] Supported install targets right now: ${listAsmPlatformInstallers().map((item) => item.id).join(" | ")}`);
    return {
      ok: false,
      step: "unknown-install-target",
      platform: String(platform || "").trim().toLowerCase() || "unknown",
    };
  }

  return installer.install({
    runner,
    initOpenClaw,
    log,
    argv,
    env,
    homeDir,
  });
}
