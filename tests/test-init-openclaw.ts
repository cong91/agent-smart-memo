import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const mod = await import("../scripts/init-openclaw.mjs");
const originalLog = console.log;

const ROOT = mkdtempSync(join(tmpdir(), "agent-smart-memo-init-openclaw-"));
const stateDir = join(ROOT, ".openclaw");
mkdirSync(stateDir, { recursive: true });
const configPath = join(stateDir, "openclaw.json");

writeFileSync(
  configPath,
  JSON.stringify(
    {
      some_unrelated_top_level: {
        keep_me: true,
      },
      plugins: {
        allow: ["other-plugin"],
        slots: {
          default: "other-plugin",
        },
        entries: {
          "other-plugin": {
            enabled: true,
            config: {
              x: 1,
            },
          },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

test("resolveOpenClawConfigPath prefers OPENCLAW_STATE_DIR/openclaw.json", () => {
  const resolved = mod.resolveOpenClawConfigPath({ HOME: ROOT, OPENCLAW_STATE_DIR: stateDir });
  assertEqual(resolved, configPath, "should resolve config path from OPENCLAW_STATE_DIR");
});

test("buildPatchedConfig merges plugin block without dropping unrelated fields", () => {
  const existing = mod.parseExistingConfig(configPath);
  const next = mod.buildPatchedConfig(
    existing,
    {
      qdrantHost: "localhost",
      qdrantPort: 6333,
      qdrantCollection: "mrc_bot",
      llmBaseUrl: "http://localhost:8317/v1",
      llmModel: "gemini-2.5-flash",
      llmApiKey: "hidden",
      embedBackend: "ollama",
      embedModel: "qwen3-embedding:0.6b",
      embedDimensions: 1024,
      slotDbDir: join(stateDir, "agent-memo"),
      telegramOnboardingCommands: ["addproject"],
    },
    true,
  );

  assert(next.some_unrelated_top_level?.keep_me === true, "unrelated top-level field must be preserved");
  assert(next.plugins.entries["other-plugin"].enabled === true, "existing plugin entries must remain");
  assert(next.plugins.allow.includes("other-plugin"), "existing allow item must remain");
  assert(next.plugins.allow.includes("agent-smart-memo"), "agent-smart-memo must be added to plugins.allow");
  assertEqual(next.plugins.slots.memory, "agent-smart-memo", "plugins.slots.memory should map to agent-smart-memo");
  assert(Array.isArray(next.channels?.telegram?.customCommands), "telegram customCommands should be created");
  assert(
    next.channels.telegram.customCommands.some((item: any) => item.command === "addproject"),
    "addproject should be present in telegram customCommands",
  );

  const entry = next.plugins.entries["agent-smart-memo"];
  assert(entry && entry.enabled === true, "agent-smart-memo entry should be enabled");
  assertEqual(entry.config.embedDimensions, 1024, "embedDimensions should be set");
});

test("buildPatchedConfig keeps single-account telegram merge at channels.telegram.customCommands", () => {
  const existing = {
    channels: {
      telegram: {
        customCommands: [{ command: "legacy", description: "Legacy command" }],
      },
    },
    plugins: {
      allow: [],
      slots: {},
      entries: {},
    },
  };

  const next = mod.buildPatchedConfig(
    existing,
    {
      qdrantHost: "localhost",
      qdrantPort: 6333,
      qdrantCollection: "mrc_bot",
      llmBaseUrl: "http://localhost:8317/v1",
      llmModel: "gemini-2.5-flash",
      llmApiKey: "",
      embedBackend: "ollama",
      embedModel: "qwen3-embedding:0.6b",
      embedDimensions: 1024,
      slotDbDir: join(stateDir, "agent-memo"),
      telegramOnboardingCommands: ["addproject", "legacy", "addproject"],
    },
    true,
  );

  const commands = (next.channels.telegram.customCommands || []).map((item: any) => item.command);
  assertEqual(commands, ["legacy", "addproject"], "single-account merge should preserve + dedupe at root telegram customCommands");
});

test("buildPatchedConfig fans out onboarding commands to enabled telegram accounts in multi-account mode", () => {
  const existing = {
    channels: {
      telegram: {
        accounts: {
          ops: {
            enabled: true,
            customCommands: [{ command: "legacyops", description: "Legacy ops" }],
          },
          growth: {
            enabled: true,
            customCommands: [{ command: "addproject", description: "Add project onboarding" }],
          },
          disabled: {
            enabled: false,
            customCommands: [{ command: "legacydisabled", description: "Disabled" }],
          },
        },
      },
    },
    plugins: {
      allow: [],
      slots: {},
      entries: {},
    },
  };

  const next = mod.buildPatchedConfig(
    existing,
    {
      qdrantHost: "localhost",
      qdrantPort: 6333,
      qdrantCollection: "mrc_bot",
      llmBaseUrl: "http://localhost:8317/v1",
      llmModel: "gemini-2.5-flash",
      llmApiKey: "",
      embedBackend: "ollama",
      embedModel: "qwen3-embedding:0.6b",
      embedDimensions: 1024,
      slotDbDir: join(stateDir, "agent-memo"),
      telegramOnboardingCommands: ["addproject"],
    },
    true,
  );

  const opsCommands = (next.channels.telegram.accounts.ops.customCommands || []).map((item: any) => item.command);
  const growthCommands = (next.channels.telegram.accounts.growth.customCommands || []).map((item: any) => item.command);
  const disabledCommands = (next.channels.telegram.accounts.disabled.customCommands || []).map((item: any) => item.command);

  assertEqual(opsCommands, ["legacyops", "addproject"], "enabled account ops should receive /addproject with preserve+dedupe");
  assertEqual(growthCommands, ["addproject"], "enabled account with existing /addproject should be deduped");
  assertEqual(disabledCommands, ["legacydisabled"], "disabled account should remain unchanged");
  assert(
    !Array.isArray(next.channels.telegram.customCommands),
    "multi-account mode should not force root-level channels.telegram.customCommands",
  );
});

test("validateAnswers returns explicit errors for invalid inputs", () => {
  const errors = mod.validateAnswers({
    qdrantHost: "",
    qdrantPort: 0,
    qdrantCollection: "",
    llmBaseUrl: "",
    llmModel: "",
    embedBackend: "invalid",
    embedModel: "",
    embedDimensions: -1,
    slotDbDir: "",
    telegramOnboardingCommands: ["$bad"],
  });

  assert(errors.length >= 5, "should return multiple validation errors");
});

test("buildSetupSummary classifies already configured / will add / will update", () => {
  const current = {
    channels: {
      telegram: {
        customCommands: [{ command: "addproject", description: "Add project onboarding" }],
      },
    },
    plugins: {
      allow: ["agent-smart-memo"],
      slots: { memory: "agent-smart-memo" },
      entries: {
        "agent-smart-memo": {
          enabled: true,
          config: {
            qdrantHost: "localhost",
            qdrantPort: 6333,
            qdrantCollection: "mrc_bot",
            llmBaseUrl: "http://localhost:8317/v1",
            llmModel: "gemini-2.5-flash",
            llmApiKey: "",
            embedBackend: "ollama",
            embedModel: "qwen3-embedding:0.6b",
            embedDimensions: 1024,
            slotDbDir: join(stateDir, "agent-memo"),
          },
        },
      },
    },
  };

  const answers = {
    qdrantHost: "localhost",
    qdrantPort: 6333,
    qdrantCollection: "mrc_bot",
    llmBaseUrl: "http://localhost:8317/v1",
    llmModel: "gemini-2.5-flash",
    llmApiKey: "new-secret",
    embedBackend: "ollama",
    embedModel: "qwen3-embedding:0.6b",
    embedDimensions: 1024,
    slotDbDir: join(stateDir, "agent-memo"),
    mapMemorySlot: true,
    telegramOnboardingCommands: ["addproject", "indexproject"],
  };

  const next = mod.buildPatchedConfig(current, answers, true);
  const summary = mod.buildSetupSummary(current, answers, next);

  assert(summary.alreadyConfigured.includes("plugins.allow includes agent-smart-memo"), "plugin allow should be already configured");
  assert(summary.willUpdate.includes("plugins.entries.agent-smart-memo.config.llmApiKey"), "llmApiKey should be will update");
  assert(
    summary.willAdd.includes("channels.telegram.customCommands includes /indexproject"),
    "indexproject should be classified as will add",
  );
});

test("formatSetupSummary renders required operator sections", () => {
  const output = mod.formatSetupSummary({
    alreadyConfigured: ["plugins.allow includes agent-smart-memo"],
    willAdd: ["channels.telegram.customCommands includes /indexproject"],
    willUpdate: ["plugins.entries.agent-smart-memo.config.llmApiKey"],
  });

  assert(output.includes("already configured"), "must include already configured section");
  assert(output.includes("will add"), "must include will add section");
  assert(output.includes("will update"), "must include will update section");
});

test("buildBackupPath uses .bak timestamp suffix", () => {
  const sample = mod.buildBackupPath(configPath, new Date("2026-03-13T10:11:12Z"));
  assert(sample.includes(".bak."), "backup suffix should include .bak.");
});

test("runInitOpenClaw supports non-interactive auto-apply write path", async () => {
  const env = {
    HOME: ROOT,
    OPENCLAW_STATE_DIR: stateDir,
  };

  const logs: string[] = [];
  console.log = (...args: any[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };

  try {
    const result = await mod.runInitOpenClaw({ env, interactive: false, autoApply: true });
    assertEqual(result.applied, true, "auto-apply should write config");

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    const commands =
      updated?.channels?.telegram?.customCommands?.map((item: any) => item.command) || [];

    assert(commands.includes("addproject"), "auto-apply should include /addproject in telegram customCommands");
    assert(logs.some((line) => line.includes("Auto-apply mode enabled")), "should log auto-apply mode");
  } finally {
    console.log = originalLog;
  }
});

process.on("exit", () => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log("\n🎉 init-openclaw tests passed");
  }
}, 0);
