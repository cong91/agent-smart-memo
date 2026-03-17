import {
  detectPluginInstalled,
  parseAsmCliArgs,
  runSetupOpenClawFlow,
} from "../bin/asm.mjs";
import {
  createShellRunner,
  getAsmPlatformInstaller,
  listAsmPlatformInstallers,
  runInitSetupFlow,
  runInstallPlatformFlow,
} from "../src/cli/platform-installers.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
  }
}

function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ ${name}`);
    })
    .catch((error) => {
      console.error(`❌ ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

test("parseAsmCliArgs supports help, setup-openclaw, install <platform>, and init-openclaw", () => {
  assertEqual(parseAsmCliArgs([]), { command: "help", argv: [] }, "empty should map to help");
  assertEqual(parseAsmCliArgs(["--help"]), { command: "help", argv: [] }, "--help should map to help");
  assertEqual(
    parseAsmCliArgs(["setup-openclaw"]),
    { command: "setup-openclaw", argv: [] },
    "setup-openclaw should parse",
  );
  assertEqual(
    parseAsmCliArgs(["setup", "openclaw", "--x"]),
    { command: "setup-openclaw", argv: ["--x"] },
    "setup openclaw alias should parse",
  );
  assertEqual(
    parseAsmCliArgs(["install", "openclaw", "--yes"]),
    { command: "install-platform", platform: "openclaw", argv: ["--yes"] },
    "install openclaw should parse",
  );
  assertEqual(
    parseAsmCliArgs(["install", "paperclip"]),
    { command: "install-platform", platform: "paperclip", argv: [] },
    "install paperclip should parse",
  );
  assertEqual(
    parseAsmCliArgs(["init-setup", "--yes"]),
    { command: "init-setup", argv: ["--yes"] },
    "init-setup should parse",
  );
  assertEqual(
    parseAsmCliArgs(["mcp", "opencode"]),
    { command: "mcp-opencode", argv: [] },
    "mcp opencode should parse",
  );
  assertEqual(
    parseAsmCliArgs(["init-openclaw", "--non-interactive"]),
    { command: "init-openclaw", argv: ["--non-interactive"] },
    "init-openclaw should parse",
  );
  assertEqual(
    parseAsmCliArgs(["init", "openclaw", "--non-interactive"]),
    { command: "init-openclaw", argv: ["--non-interactive"] },
    "init openclaw alias should parse",
  );
});

test("createShellRunner normalizes process output", () => {
  const runner = createShellRunner((command: string, args: string[]) => {
    assertEqual(command, "openclaw", "command should pass through");
    assertEqual(args, ["--version"], "args should pass through");
    return { status: 0, stdout: " 1.2.3 \n", stderr: "" } as any;
  });

  const result = runner("openclaw", ["--version"]);
  assert(result.ok === true, "runner should mark ok when status=0");
  assertEqual(result.stdout, "1.2.3", "stdout should trim");
});

test("detectPluginInstalled supports list --json shape", () => {
  const calls: Array<string> = [];
  const runner = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args.includes("--json")) {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ plugins: [{ id: "agent-smart-memo" }] }),
        stderr: "",
        error: "",
      };
    }

    return { ok: false, code: 1, stdout: "", stderr: "", error: "" };
  };

  const state = detectPluginInstalled(runner as any);
  assertEqual(state.installed, true, "plugin should be detected from JSON");
  assert(calls[0]?.includes("plugins list --json"), "should call list --json first");
});

test("runSetupOpenClawFlow installs plugin when missing and runs init", async () => {
  const logLines: string[] = [];
  const calls: Array<string> = [];
  const runner = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);

    if (args[0] === "--version") {
      return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
    }

    if (args[0] === "plugins" && args[1] === "list" && args[2] === "--json") {
      return { ok: true, code: 0, stdout: JSON.stringify({ plugins: [] }), stderr: "", error: "" };
    }

    if (args[0] === "plugins" && args[1] === "list") {
      return { ok: true, code: 0, stdout: "", stderr: "", error: "" };
    }

    if (args[0] === "plugins" && args[1] === "install") {
      return { ok: true, code: 0, stdout: "installed", stderr: "", error: "" };
    }

    return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
  };

  let initCalled = 0;
  let initParams: any = null;
  const initOpenClaw = async (params?: any) => {
    initCalled += 1;
    initParams = params;
    return { applied: true };
  };

  const result = await runSetupOpenClawFlow({
    runner: runner as any,
    initOpenClaw,
    log: (line: string) => logLines.push(line),
  });

  assertEqual(result.ok, true, "flow should succeed");
  assertEqual(initCalled, 1, "init flow should be called once");
  assertEqual(initParams, { interactive: true, autoApply: false }, "default setup flow should remain interactive");
  assert(
    calls.some((line) => line.includes("plugins install @mrc2204/agent-smart-memo")),
    "should install plugin when missing",
  );
  assert(logLines.some((line) => line.includes("Setup summary (before execution)")), "should print setup summary header");
  assert(logLines.some((line) => line.includes("already configured")), "should print already configured section");
  assert(logLines.some((line) => line.includes("will add")), "should print will add section");
  assert(logLines.some((line) => line.includes("will update")), "should print will update section");
  assert(logLines.some((line) => line.includes("setup-openclaw completed")), "should print completion line");
});

test("runSetupOpenClawFlow supports non-interactive --yes mode", async () => {
  const runner = (_command: string, args: string[]) => {
    if (args[0] === "--version") {
      return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
    }

    if (args[0] === "plugins" && args[1] === "list" && args[2] === "--json") {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ plugins: [{ id: "agent-smart-memo" }] }),
        stderr: "",
        error: "",
      };
    }

    if (args[0] === "plugins" && args[1] === "list") {
      return { ok: true, code: 0, stdout: "", stderr: "", error: "" };
    }

    return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
  };

  let initParams: any = null;
  const result = await runSetupOpenClawFlow({
    runner: runner as any,
    initOpenClaw: async (params?: any) => {
      initParams = params;
      return { applied: true };
    },
    argv: ["--yes"],
    log: () => {},
  });

  assertEqual(result.ok, true, "flow should succeed in --yes mode");
  assertEqual(initParams, { interactive: false, autoApply: true }, "--yes should force non-interactive apply");
});

test("installer registry exposes openclaw/paperclip/opencode descriptors", () => {
  const installers = listAsmPlatformInstallers();
  assert(installers.some((item) => item.id === "openclaw" && item.status === "implemented"), "openclaw installer descriptor should exist");
  assert(installers.some((item) => item.id === "paperclip"), "paperclip installer descriptor should exist");
  assert(installers.some((item) => item.id === "opencode"), "opencode installer descriptor should exist");
  assertEqual(Boolean(getAsmPlatformInstaller("openclaw")), true, "installer lookup should resolve openclaw");
});

test("runInstallPlatformFlow routes openclaw to setup-openclaw flow", async () => {
  let called = 0;
  const result = await runInstallPlatformFlow({
    platform: "openclaw",
    runner: (() => ({ ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" })) as any,
    initOpenClaw: async (params?: any) => {
      called += 1;
      return { applied: Boolean(params) };
    },
    log: () => {},
    argv: ["--yes"],
  });

  assertEqual(result.ok, true, "install openclaw should route through existing setup flow");
  assertEqual(called, 1, "install openclaw should invoke bootstrap path once");
});

test("runInitSetupFlow creates shared ASM config with platform defaults", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-init-setup-"));
  const result = await runInitSetupFlow({ env: { ...process.env, HOME: home }, homeDir: home, argv: ["--yes"], log: () => {} });
  const written = JSON.parse(fs.readFileSync(result.path, "utf8"));

  assertEqual(result.ok, true, "init-setup should succeed");
  assertEqual(written.core.projectWorkspaceRoot, "~/Work/projects", "init-setup should ensure default shared workspace root");
  assertEqual(written.adapters.opencode.mode, "read-only", "init-setup should enforce read-only default for opencode adapter");
});

test("runInstallPlatformFlow returns not-implemented contract for paperclip and implemented path for opencode", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-opencode-install-"));
  const paperclip = await runInstallPlatformFlow({
    platform: "paperclip",
    runner: createShellRunner(),
    initOpenClaw: async () => ({ applied: true }) as any,
    log: () => {},
    argv: [],
    env: { ...process.env, HOME: home },
    homeDir: home,
  });
  const opencode = await runInstallPlatformFlow({
    platform: "opencode",
    runner: createShellRunner(),
    initOpenClaw: async () => ({ applied: true }) as any,
    log: () => {},
    argv: [],
    env: { ...process.env, HOME: home },
    homeDir: home,
  });

  assertEqual(paperclip.ok, false, "paperclip install should still be contract-only for now");
  assertEqual(paperclip.step, "install-paperclip-not-implemented", "paperclip should return structured not-implemented step");
  assertEqual(opencode.ok, true, "opencode install should now be implemented");
  assertEqual(opencode.step, "install-opencode", "opencode should return implemented install step");
  const written = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "config.json"), "utf8"));
  assertEqual(written.mcp.servers.asm.type, "local", "opencode config should register local MCP server");
  assertEqual(JSON.stringify(written.mcp.servers.asm.command), JSON.stringify(["asm", "mcp", "opencode"]), "opencode config should spawn asm mcp opencode");
  assertEqual(written.mcp.servers.asm.environment.ASM_MCP_AGENT_ID, "opencode", "opencode config should scope MCP agent id");
  assertEqual(written.mcp.servers.asm.enabled, true, "opencode config should enable ASM MCP server");
});

test("runSetupOpenClawFlow fails early when openclaw missing", async () => {
  const runner = (_command: string, _args: string[]) => ({
    ok: false,
    code: 127,
    stdout: "",
    stderr: "command not found",
    error: "spawn ENOENT",
  });

  let initCalled = 0;
  const result = await runSetupOpenClawFlow({
    runner: runner as any,
    initOpenClaw: async () => {
      initCalled += 1;
      return { applied: true };
    },
    log: () => {},
  });

  assertEqual(result.ok, false, "flow should fail if openclaw is missing");
  assertEqual(initCalled, 0, "init flow must not run when openclaw missing");
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log("\n🎉 asm cli tests passed");
  }
}, 0);
