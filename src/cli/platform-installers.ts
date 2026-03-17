import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function resolveOpencodeConfigPath(homeDir?: string): string {
  const home = homeDir || process.env.HOME || process.cwd();
  return join(home, ".config", "opencode", "config.json");
}

function ensureOpencodeConfig(
  opencodeConfigPath: string,
  asmConfigPath: string,
): { existed: boolean; config: Record<string, unknown> } {
  const existed = existsSync(opencodeConfigPath);
  let current: Record<string, unknown> = {};
  if (existed) {
    try {
      const parsed = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      current = {};
    }
  }

  const currentMcp = current.mcp || {};
  const currentServers = (currentMcp as Record<string, unknown>).servers || {};
  const next = {
    ...current,
    mcp: {
      ...(currentMcp as Record<string, unknown>),
      servers: {
        ...(currentServers as Record<string, unknown>),
        asm: {
          type: "local",
          command: ["asm", "mcp", "opencode"],
          enabled: true,
          environment: {
            ASM_CONFIG: asmConfigPath,
            ASM_MCP_AGENT_ID: "opencode",
          },
        },
      },
    },
  };

  mkdirSync(dirname(opencodeConfigPath), { recursive: true });
  writeFileSync(opencodeConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { existed, config: next };
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

function deriveRepoRoot(homeDir?: string): string {
  return homeDir ? join(homeDir, "Work", "projects") : process.cwd();
}

function packageArtifactExists(repoRoot: string, relativePath: string): string | null {
  const full = join(repoRoot, relativePath);
  return existsSync(full) ? full : null;
}

const paperclipInstaller: AsmPlatformInstaller = {
  id: "paperclip",
  describe() {
    return {
      id: "paperclip",
      displayName: "Paperclip",
      status: "implemented",
      summary: "Prepare Paperclip runtime/plugin-local artifacts and print host install guidance using shared ASM config.",
      requiredSharedConfigKeys: ["core.projectWorkspaceRoot", "core.storage.slotDbDir", "adapters.paperclip.enabled"],
      platformLocalConfigPaths: ["artifacts/paperclip-plugin-local", "paperclip host/plugin config"],
    };
  },
  async install(ctx) {
    const initSetup = await runInitSetupFlow({ log: ctx.log, env: ctx.env, homeDir: ctx.homeDir, argv: ["--yes"] });
    const asmConfigPath = String(initSetup.path);
    const repoRoot = deriveRepoRoot(ctx.homeDir ? undefined : undefined);

    const packageRuntime = ctx.runner("npm", ["run", "package:paperclip"]);
    if (!packageRuntime.ok) {
      return { ok: false, step: "package-paperclip-runtime-failed", platform: "paperclip", details: { stderr: packageRuntime.stderr, stdout: packageRuntime.stdout } };
    }

    const packageLocal = ctx.runner("npm", ["run", "package:paperclip:plugin-local"]);
    if (!packageLocal.ok) {
      return { ok: false, step: "package-paperclip-plugin-local-failed", platform: "paperclip", details: { stderr: packageLocal.stderr, stdout: packageLocal.stdout } };
    }

    const artifactDir = packageArtifactExists(process.cwd(), "artifacts/paperclip-plugin-local") || join(process.cwd(), "artifacts", "paperclip-plugin-local");
    const runtimeDir = packageArtifactExists(process.cwd(), "artifacts/npm/paperclip") || join(process.cwd(), "artifacts", "npm", "paperclip");

    const installCommand = `paperclipai plugin install ${artifactDir}`;
    ctx.log(`[ASM-104] install paperclip prepared local plugin artifact at: ${artifactDir}`);
    ctx.log(`[ASM-104] install paperclip prepared runtime package at: ${runtimeDir}`);
    ctx.log(`[ASM-104] Next step on Paperclip host: ${installCommand}`);
    ctx.log(`[ASM-104] ASM shared config remains source-of-truth at: ${asmConfigPath}`);

    return {
      ok: true,
      step: "install-paperclip",
      platform: "paperclip",
      details: {
        asmConfigPath,
        artifactDir,
        runtimeDir,
        installCommand,
      },
    };
  },
};

const opencodeInstaller: AsmPlatformInstaller = {
  id: "opencode",
  describe() {
    return {
      id: "opencode",
      displayName: "OpenCode",
      status: "implemented",
      summary: "Bootstrap OpenCode read-only/MCP integration using ASM shared config and ASM-106 retrieval contract.",
      requiredSharedConfigKeys: ["core.projectWorkspaceRoot", "core.storage.slotDbDir", "adapters.opencode.enabled", "adapters.opencode.mode"],
      platformLocalConfigPaths: ["~/.config/opencode/config.json"],
    };
  },
  async install(ctx) {
    const initSetup = await runInitSetupFlow({ log: ctx.log, env: ctx.env, homeDir: ctx.homeDir, argv: ["--yes"] });
    const asmConfigPath = String(initSetup.path);
    const opencodeConfigPath = resolveOpencodeConfigPath(ctx.homeDir);
    const ensured = ensureOpencodeConfig(opencodeConfigPath, asmConfigPath);
    ctx.log(`[ASM-104] install opencode ${ensured.existed ? "updated" : "created"} config at: ${opencodeConfigPath}`);
    ctx.log("[ASM-104] OpenCode MCP/read-only integration now points to ASM shared config and should use ASM-106 retrieval contract.");
    return {
      ok: true,
      step: "install-opencode",
      platform: "opencode",
      details: {
        asmConfigPath,
        opencodeConfigPath,
        existed: ensured.existed,
      },
    };
  },
};

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
