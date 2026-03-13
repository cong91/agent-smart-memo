import {
  createShellRunner,
  detectPluginInstalled,
  parseAsmCliArgs,
  runSetupOpenClawFlow,
} from "../bin/asm.mjs";

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

test("parseAsmCliArgs supports help and setup-openclaw", () => {
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
  const initOpenClaw = async () => {
    initCalled += 1;
    return { applied: true };
  };

  const result = await runSetupOpenClawFlow({
    runner: runner as any,
    initOpenClaw,
    log: (line: string) => logLines.push(line),
  });

  assertEqual(result.ok, true, "flow should succeed");
  assertEqual(initCalled, 1, "init flow should be called once");
  assert(
    calls.some((line) => line.includes("plugins install @mrc2204/agent-smart-memo")),
    "should install plugin when missing",
  );
  assert(logLines.some((line) => line.includes("setup-openclaw completed")), "should print completion line");
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
