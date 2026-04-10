import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ASM_WIKI_FIRST_BLOCK_VERSION } from "../src/core/usecases/reinforcement-patch.ts";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function assertEqual(
	actual: unknown,
	expected: unknown,
	message: string,
): void {
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
	assertEqual(
		parseAsmCliArgs([]),
		{ command: "help", argv: [] },
		"empty should map to help",
	);
	assertEqual(
		parseAsmCliArgs(["--help"]),
		{ command: "help", argv: [] },
		"--help should map to help",
	);
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
	assertEqual(
		parseAsmCliArgs(["project-event", "--project-id", "p1"]),
		{ command: "project-event", argv: ["--project-id", "p1"] },
		"project-event should parse",
	);
	assertEqual(
		parseAsmCliArgs([
			"migrate-memory-foundation",
			"plan",
			"--preflight-limit",
			"10",
		]),
		{
			command: "migrate-memory-foundation",
			argv: ["plan", "--preflight-limit", "10"],
		},
		"migrate-memory-foundation command should parse",
	);
	assertEqual(
		parseAsmCliArgs(["memory", "migrate", "verify"]),
		{ command: "migrate-memory-foundation", argv: ["verify"] },
		"memory migrate alias should parse",
	);
	assertEqual(
		parseAsmCliArgs(["check-memory-foundation", "--preflight-limit", "5"]),
		{ command: "check-memory-foundation", argv: ["--preflight-limit", "5"] },
		"check-memory-foundation should parse",
	);
	assertEqual(
		parseAsmCliArgs(["memory", "check", "--preflight-limit", "5"]),
		{ command: "check-memory-foundation", argv: ["--preflight-limit", "5"] },
		"memory check alias should parse",
	);
});

test("createShellRunner normalizes process output", () => {
	const runner = createShellRunner(((command: string, args: string[]) => {
		assertEqual(command, "openclaw", "command should pass through");
		assertEqual(args, ["--version"], "args should pass through");
		return { status: 0, stdout: " 1.2.3 \n", stderr: "" } as any;
	}) as any);

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
	assert(
		calls[0]?.includes("plugins list --json"),
		"should call list --json first",
	);
});

test("runSetupOpenClawFlow bootstraps config, wiki files, and openclaw binding", async () => {
	const logLines: string[] = [];
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-setup-openclaw-"));
	const workspaceRoot = path.join(home, "Work", "projects");
	const repoRoot = path.join(workspaceRoot, "demo-repo");
	fs.mkdirSync(repoRoot, { recursive: true });

	const calls: Array<string> = [];
	const runner = (command: string, args: string[]) => {
		calls.push(`${command} ${args.join(" ")}`);

		if (args[0] === "--version") {
			return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
		}

		if (args[0] === "plugins" && args[1] === "install") {
			return { ok: true, code: 0, stdout: "installed", stderr: "", error: "" };
		}

		return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
	};

	const originalHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const result = await runSetupOpenClawFlow({
			runner: runner as any,
			initOpenClaw: async () => ({
				applied: true,
				configPath: "~/.openclaw/openclaw.json",
			}),
			log: (line: string) => logLines.push(line),
			env: { ...process.env, HOME: home },
			homeDir: home,
			cwd: repoRoot,
			argv: ["--yes"] as any,
		} as any);

		assertEqual(result.ok, true, "flow should succeed");
		assert(
			calls.some((line) =>
				line.includes("plugins install @mrc2204/agent-smart-memo"),
			),
			"should install plugin during setup",
		);
		assert(
			logLines.some((line) => line.includes("setup-openclaw result: pass")),
			"should report pass summary",
		);

		const asmConfigPath = path.join(home, ".config", "asm", "config.json");
		const openclawConfigPath = path.join(home, ".openclaw", "openclaw.json");
		const agentsPath = path.join(repoRoot, "AGENTS.md");
		const asmConfig = JSON.parse(fs.readFileSync(asmConfigPath, "utf8"));
		const wikiDir = path.resolve(
			home,
			String(asmConfig.core.wikiDir).replace(/^~\//, ""),
		);
		assert(existsSync(asmConfigPath), "shared config should be created");
		assert(existsSync(openclawConfigPath), "openclaw config should be created");
		assert(existsSync(agentsPath), "AGENTS.md should be created when missing");
		assert(
			existsSync(path.join(wikiDir, "index.md")),
			"wiki index should be created",
		);
		assert(
			existsSync(path.join(wikiDir, "schema.md")),
			"wiki schema should be created",
		);
		assert(
			existsSync(path.join(wikiDir, "log.md")),
			"wiki log should be created",
		);

		const agentsContent = fs.readFileSync(agentsPath, "utf8");
		assert(
			agentsContent.includes("reinforcement-only, not full project memory"),
			"AGENTS managed block should remain reinforcement-only",
		);
		assert(
			agentsContent.includes(`version=${ASM_WIKI_FIRST_BLOCK_VERSION}`),
			"AGENTS managed block should track current block version",
		);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("runSetupOpenClawFlow supports non-interactive --yes mode", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "asm-setup-openclaw-noninteractive-"),
	);
	const repoRoot = path.join(home, "Work", "projects", "demo-repo");
	fs.mkdirSync(repoRoot, { recursive: true });
	const originalHome = process.env.HOME;
	process.env.HOME = home;

	const runner = (_command: string, args: string[]) => {
		if (args[0] === "--version") {
			return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
		}

		if (args[0] === "plugins" && args[1] === "install") {
			return { ok: true, code: 0, stdout: "installed", stderr: "", error: "" };
		}

		return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
	};

	try {
		const result = (await runSetupOpenClawFlow({
			runner: runner as any,
			initOpenClaw: async () => ({
				applied: true,
				configPath: "~/.openclaw/openclaw.json",
			}),
			env: { ...process.env, HOME: home },
			homeDir: home,
			cwd: repoRoot,
			argv: ["--yes"] as any,
			log: () => {},
		} as any)) as any;

		assertEqual(result.ok, true, "flow should succeed in --yes mode");
		assertEqual(
			JSON.stringify(result.details?.report?.status),
			JSON.stringify("pass"),
			"--yes should still perform setup and report pass",
		);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("installer registry exposes openclaw/opencode descriptors", () => {
	const installers = listAsmPlatformInstallers();
	assert(
		installers.some(
			(item) => item.id === "openclaw" && item.status === "implemented",
		),
		"openclaw installer descriptor should exist",
	);
	assert(
		installers.some((item) => item.id === "opencode"),
		"opencode installer descriptor should exist",
	);
	assertEqual(
		Boolean(getAsmPlatformInstaller("openclaw")),
		true,
		"installer lookup should resolve openclaw",
	);
});

test("runInstallPlatformFlow routes openclaw to setup-openclaw flow", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-openclaw-install-"));
	const asmConfigPath = path.join(home, ".config", "asm", "config.json");
	fs.mkdirSync(path.dirname(asmConfigPath), { recursive: true });
	fs.writeFileSync(
		asmConfigPath,
		JSON.stringify(
			{
				schemaVersion: 1,
				core: {
					projectWorkspaceRoot: "~/Work/projects",
					slotDbDir: "~/.local/share/asm/slotdb",
					wikiDir: "~/Work/projects/agent-smart-memo/memory/wiki",
					qdrantHost: "localhost",
					qdrantPort: 6333,
					qdrantCollection: "mrc_bot",
					qdrantVectorSize: 1024,
					embedBaseUrl: "http://localhost:11434",
					embedBackend: "ollama",
					embedModel: "qwen3-embedding:0.6b",
					embedDimensions: 1024,
					autoCaptureEnabled: true,
					autoCaptureMinConfidence: 0.7,
					contextWindowMaxTokens: 32000,
					summarizeEveryActions: 6,
				},
			},
			null,
			2,
		) + "\n",
	);

	let called = 0;
	const result = await runInstallPlatformFlow({
		platform: "openclaw",
		runner: ((command: string, args: string[] = []) => {
			if (command === "openclaw" && args[0] === "--version") {
				return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
			}
			if (
				command === "openclaw" &&
				args[0] === "plugins" &&
				args[1] === "install"
			) {
				return {
					ok: true,
					code: 0,
					stdout: "installed",
					stderr: "",
					error: "",
				};
			}
			return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
		}) as any,
		initOpenClaw: async (params?: any) => {
			called += 1;
			return {
				applied: Boolean(params),
				configPath: "~/.openclaw/openclaw.json",
			};
		},
		log: () => {},
		argv: ["--yes"],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});

	assertEqual(
		result.ok,
		true,
		"install openclaw should bind openclaw config to shared asm config",
	);
	assertEqual(
		result.step,
		"bind-openclaw-config",
		"install openclaw should bind required runtime fields",
	);
	assertEqual(called, 0, "install openclaw must not run init-openclaw wizard");

	const openclawPath = path.join(home, ".openclaw", "openclaw.json");
	const written = JSON.parse(fs.readFileSync(openclawPath, "utf8"));
	const writtenConfig = written.plugins.entries["agent-smart-memo"].config;
	assertEqual(
		Object.keys(writtenConfig).sort(),
		["projectWorkspaceRoot", "slotDbDir", "wikiDir"],
		"openclaw config should expose required 3-field runtime contract",
	);
	assertEqual(
		writtenConfig.projectWorkspaceRoot,
		path.resolve(home, "Work", "projects"),
		"openclaw config should bind projectWorkspaceRoot from shared config",
	);
	assertEqual(
		writtenConfig.slotDbDir,
		path.resolve(home, ".local", "share", "asm", "slotdb"),
		"openclaw config should bind slotDbDir from shared config",
	);
	assertEqual(
		writtenConfig.wikiDir,
		path.resolve(
			home,
			"Work",
			"projects",
			"agent-smart-memo",
			"memory",
			"wiki",
		),
		"openclaw config should bind wikiDir from shared config",
	);
});

test("runInstallPlatformFlow openclaw fails clearly when shared config missing", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "asm-openclaw-missing-shared-"),
	);

	const result = await runInstallPlatformFlow({
		platform: "openclaw",
		runner: ((command: string, args: string[] = []) => {
			if (command === "openclaw" && args[0] === "--version") {
				return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
			}
			if (
				command === "openclaw" &&
				args[0] === "plugins" &&
				args[1] === "install"
			) {
				return {
					ok: true,
					code: 0,
					stdout: "installed",
					stderr: "",
					error: "",
				};
			}
			return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
		}) as any,
		initOpenClaw: async () =>
			({ applied: true, configPath: "~/.openclaw/openclaw.json" }) as any,
		log: () => {},
		argv: ["--yes"],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});

	assertEqual(
		result.ok,
		false,
		"install openclaw should fail when shared config is missing",
	);
	assertEqual(
		result.step,
		"missing-shared-config",
		"missing shared config should return explicit failure step",
	);
});

test("runInitSetupFlow creates shared ASM config with platform defaults", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-init-setup-"));
	const result = await runInitSetupFlow({
		env: { ...process.env, HOME: home },
		homeDir: home,
		argv: ["--yes"],
		log: () => {},
	});
	const written = JSON.parse(fs.readFileSync(result.path, "utf8"));

	assertEqual(result.ok, true, "init-setup should succeed");
	assertEqual(
		written.core.projectWorkspaceRoot,
		"~/Work/projects",
		"init-setup should ensure default shared workspace root",
	);
	assertEqual(
		written.core.qdrantHost,
		"localhost",
		"init-setup should write qdrantHost into shared core config",
	);
	assertEqual(
		written.core.embedModel,
		"qwen3-embedding:0.6b",
		"init-setup should write embedModel into shared core config",
	);
	assertEqual(
		written.core.slotDbDir,
		"~/.local/share/asm/slotdb",
		"init-setup should write core.slotDbDir into shared core config",
	);
	assertEqual(
		written.core.wikiDir,
		"~/Work/projects/agent-smart-memo/memory/wiki",
		"init-setup should write wikiDir into shared core config",
	);
	assertEqual(
		written.adapters.opencode.mode,
		"read-only",
		"init-setup should enforce read-only default for opencode adapter",
	);
	assertEqual(
		written.adapters.openclaw.installOrchestration.blockVersion,
		ASM_WIKI_FIRST_BLOCK_VERSION,
		"init-setup should record install orchestration managed state",
	);
});

test("runInstallPlatformFlow openclaw patches reinforcement surfaces and remains idempotent", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "asm-openclaw-reinforce-"),
	);
	const workspaceRoot = path.join(home, "Work", "projects");
	const repoRoot = path.join(workspaceRoot, "demo-repo");
	fs.mkdirSync(repoRoot, { recursive: true });
	const agentsPath = path.join(repoRoot, "AGENTS.md");
	fs.writeFileSync(
		agentsPath,
		"# Repo Instructions\n\nExisting guidance.\n",
		"utf8",
	);
	fs.mkdirSync(path.join(home, ".config", "asm"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".config", "asm", "config.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				core: {
					projectWorkspaceRoot: workspaceRoot,
					slotDbDir: path.join(home, ".local", "share", "asm", "slotdb"),
					wikiDir: path.join(
						home,
						"Work",
						"projects",
						"agent-smart-memo",
						"memory",
						"wiki",
					),
				},
				adapters: {
					openclaw: { enabled: true },
				},
			},
			null,
			2,
		) + "\n",
		"utf8",
	);

	const runner = ((command: string, args: string[] = []) => {
		if (command === "openclaw" && args[0] === "--version") {
			return { ok: true, code: 0, stdout: "1.0.0", stderr: "", error: "" };
		}
		if (
			command === "openclaw" &&
			args[0] === "plugins" &&
			args[1] === "install"
		) {
			return { ok: true, code: 0, stdout: "installed", stderr: "", error: "" };
		}
		return { ok: false, code: 1, stdout: "", stderr: "unknown", error: "" };
	}) as any;

	const first = await runInstallPlatformFlow({
		platform: "openclaw",
		runner,
		initOpenClaw: async () =>
			({ applied: true, configPath: "~/.openclaw/openclaw.json" }) as any,
		log: () => {},
		argv: ["--yes"],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});
	const firstAgents = fs.readFileSync(agentsPath, "utf8");
	assert(
		firstAgents.includes("ASM wiki-first bootstrap (managed by ASM)"),
		"first install should patch AGENTS.md with managed reinforcement block",
	);
	assert(
		firstAgents.includes("reinforcement-only, not full project memory"),
		"managed AGENTS block should state reinforcement-only boundary",
	);
	assert(
		fs.existsSync(
			path.join(
				home,
				"Work",
				"projects",
				"agent-smart-memo",
				"memory",
				"wiki",
				"index.md",
			),
		),
		"install flow should ensure wiki bootstrap index",
	);

	const second = await runInstallPlatformFlow({
		platform: "openclaw",
		runner,
		initOpenClaw: async () =>
			({ applied: true, configPath: "~/.openclaw/openclaw.json" }) as any,
		log: () => {},
		argv: ["--yes"],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});
	const secondAgents = fs.readFileSync(agentsPath, "utf8");
	assertEqual(second.ok, true, "second install rerun should succeed");
	assertEqual(
		secondAgents,
		firstAgents,
		"rerun should keep AGENTS.md unchanged once patched",
	);
	assertEqual(
		first.details?.surfacesPatched,
		[agentsPath],
		"first run should report patched reinforcement target",
	);
	assertEqual(
		second.details?.surfacesPatched,
		[],
		"second run should report no new reinforcement patches",
	);
	const shared = JSON.parse(
		fs.readFileSync(path.join(home, ".config", "asm", "config.json"), "utf8"),
	);
	assert(
		shared.adapters.openclaw.installOrchestration.patchedSurfaces.some(
			(item: { path: string }) =>
				item.path === "~/Work/projects/demo-repo/AGENTS.md",
		),
		"managed state should include repo AGENTS.md as a patched reinforcement target",
	);
	assertEqual(
		shared.adapters.openclaw.installOrchestration.blockVersion,
		ASM_WIKI_FIRST_BLOCK_VERSION,
		"managed state should track reinforcement block version",
	);
	assertEqual(
		((first.details as any)?.wikiFilesCreated || []).length,
		3,
		"first run should create wiki bootstrap entry files",
	);
	assertEqual(
		(second.details as any)?.wikiFilesCreated,
		[],
		"rerun should not recreate wiki bootstrap entry files",
	);
	assertEqual(first.ok, true, "first install should succeed");
});

test("runInstallPlatformFlow implements opencode installer and rejects paperclip target", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "asm-opencode-install-"));

	const paperclip = await runInstallPlatformFlow({
		platform: "paperclip",
		runner: createShellRunner(),
		initOpenClaw: async () =>
			({ applied: true, configPath: "~/.openclaw/openclaw.json" }) as any,
		log: () => {},
		argv: [],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});
	const opencode = await runInstallPlatformFlow({
		platform: "opencode",
		runner: createShellRunner(),
		initOpenClaw: async () =>
			({ applied: true, configPath: "~/.openclaw/openclaw.json" }) as any,
		log: () => {},
		argv: [],
		env: { ...process.env, HOME: home },
		homeDir: home,
	});

	assertEqual(paperclip.ok, false, "paperclip target should be rejected");
	assertEqual(
		paperclip.step,
		"unknown-install-target",
		"paperclip target should resolve as unknown-install-target",
	);
	assertEqual(opencode.ok, true, "opencode install should now be implemented");
	assertEqual(
		opencode.step,
		"install-opencode",
		"opencode should return implemented install step",
	);
	const written = JSON.parse(
		fs.readFileSync(
			path.join(home, ".config", "opencode", "config.json"),
			"utf8",
		),
	);
	assertEqual(
		written.mcp.asm.type,
		"local",
		"opencode config should register local MCP server at mcp.<name>",
	);
	assert(
		Array.isArray(written.mcp.asm.command),
		"opencode config should store command array",
	);
	assertEqual(
		written.mcp.asm.command[0],
		process.execPath,
		"opencode config should invoke node runtime explicitly",
	);
	assert(
		typeof written.mcp.asm.command[1] === "string" &&
			written.mcp.asm.command[1].endsWith("/bin/asm.mjs"),
		"opencode config should point to local asm CLI script",
	);
	assertEqual(
		JSON.stringify(written.mcp.asm.command.slice(2)),
		JSON.stringify(["mcp", "opencode"]),
		"opencode config should forward mcp opencode args",
	);
	assertEqual(
		written.mcp.asm.environment.ASM_MCP_AGENT_ID,
		"opencode",
		"opencode config should scope MCP agent id",
	);
	assertEqual(
		written.mcp.asm.enabled,
		true,
		"opencode config should enable ASM MCP server",
	);
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
			return { applied: true, configPath: "~/.openclaw/openclaw.json" };
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
