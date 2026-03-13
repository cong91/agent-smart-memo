#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const PLUGIN_ID = "agent-smart-memo";
const EMBED_BACKENDS = ["ollama", "openai", "docker"];

export function resolveOpenClawConfigPath(env = process.env) {
  const explicit = String(env.OPENCLAW_CONFIG_PATH || env.OPENCLAW_RUNTIME_CONFIG || "").trim();
  if (explicit) return explicit;
  const stateDir = String(env.OPENCLAW_STATE_DIR || "").trim() || `${env.HOME}/.openclaw`;
  return join(stateDir, "openclaw.json");
}

function asObj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIntOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parseExistingConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return asObj(JSON.parse(raw));
  } catch {
    throw new Error(`Invalid JSON at ${path}`);
  }
}

function dedupeStringArray(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = String(item || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function yesNoNormalize(value, fallback = true) {
  const txt = String(value || "").trim().toLowerCase();
  if (!txt) return fallback;
  if (["y", "yes", "1", "true"].includes(txt)) return true;
  if (["n", "no", "0", "false"].includes(txt)) return false;
  return fallback;
}

function normalizeTelegramCommandName(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
}

function isValidTelegramCommandName(value) {
  return /^[a-z][a-z0-9_]{0,31}$/.test(String(value || ""));
}

function defaultTelegramCommandDescription(name) {
  if (name === "addproject") return "Add project onboarding";
  if (name === "linkjira") return "Link Jira mapping";
  if (name === "indexproject") return "Index registered project";
  return `Run /${name}`;
}

function mergeTelegramCustomCommands(existing, commandNames) {
  const current = Array.isArray(existing) ? existing : [];
  const out = [];
  const seen = new Set();

  for (const item of current) {
    const command = normalizeTelegramCommandName(item?.command);
    const description = String(item?.description || "").trim();
    if (!isValidTelegramCommandName(command) || seen.has(command)) continue;
    seen.add(command);
    out.push({ command, description: description || defaultTelegramCommandDescription(command) });
  }

  for (const rawName of commandNames || []) {
    const command = normalizeTelegramCommandName(rawName);
    if (!isValidTelegramCommandName(command) || seen.has(command)) continue;
    seen.add(command);
    out.push({ command, description: defaultTelegramCommandDescription(command) });
  }

  return out;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function detectTelegramCustomCommandTargets(telegramConfig) {
  const telegram = asObj(telegramConfig);
  const accounts = asObj(telegram.accounts);
  const accountKeys = Object.keys(accounts).filter((key) => key.trim().length > 0);

  if (!accountKeys.length) {
    return { mode: "single", accountKeys: [] };
  }

  const selected = new Set();
  const scalarSelectors = [
    telegram.account,
    telegram.accountId,
    telegram.activeAccount,
    telegram.currentAccount,
    telegram.defaultAccount,
    telegram.selectedAccount,
  ];

  for (const raw of scalarSelectors) {
    const key = String(raw || "").trim();
    if (key && accountKeys.includes(key)) selected.add(key);
  }

  const arraySelectors = [
    telegram.accountsEnabled,
    telegram.enabledAccounts,
    telegram.activeAccounts,
    telegram.usedAccounts,
    telegram.selectedAccounts,
  ];

  for (const arr of arraySelectors) {
    for (const key of asStringArray(arr)) {
      if (accountKeys.includes(key)) selected.add(key);
    }
  }

  for (const key of accountKeys) {
    const account = asObj(accounts[key]);
    if (
      account.enabled === true ||
      account.isEnabled === true ||
      account.active === true ||
      account.inUse === true ||
      account.selected === true ||
      account.default === true
    ) {
      selected.add(key);
    }
  }

  if (!selected.size) {
    if (accountKeys.length === 1) {
      selected.add(accountKeys[0]);
    } else {
      for (const key of accountKeys) {
        const account = asObj(accounts[key]);
        if (account.enabled !== false) selected.add(key);
      }
    }
  }

  return {
    mode: "multi",
    accountKeys: accountKeys.filter((key) => selected.has(key)),
  };
}

function collectTelegramCommandNames(config, answers) {
  const current = asObj(config);
  const commands = [
    ...(asObj(asObj(current.channels).telegram).customCommands || []),
  ].map((item) => normalizeTelegramCommandName(item?.command));

  const targets = detectTelegramCustomCommandTargets(asObj(asObj(current.channels).telegram));
  if (targets.mode === "multi") {
    const accounts = asObj(asObj(asObj(current.channels).telegram).accounts);
    for (const accountKey of targets.accountKeys) {
      commands.push(
        ...((asObj(accounts[accountKey]).customCommands || [])
          .map((item) => normalizeTelegramCommandName(item?.command))),
      );
    }
  }

  commands.push(...(Array.isArray(answers?.telegramOnboardingCommands) ? answers.telegramOnboardingCommands : []));
  return dedupeStringArray(commands.filter((name) => isValidTelegramCommandName(name)));
}

export function validateAnswers(answers) {
  const errors = [];

  if (!String(answers.qdrantHost || "").trim()) errors.push("qdrantHost is required");
  if (!Number.isInteger(answers.qdrantPort) || answers.qdrantPort <= 0) errors.push("qdrantPort must be a positive integer");
  if (!String(answers.qdrantCollection || "").trim()) errors.push("qdrantCollection is required");

  if (!String(answers.llmBaseUrl || "").trim()) errors.push("llmBaseUrl is required");
  if (!String(answers.llmModel || "").trim()) errors.push("llmModel is required");

  if (!String(answers.embedBackend || "").trim()) {
    errors.push("embedBackend is required");
  } else if (!EMBED_BACKENDS.includes(String(answers.embedBackend))) {
    errors.push(`embedBackend must be one of: ${EMBED_BACKENDS.join(", ")}`);
  }

  if (!String(answers.embedModel || "").trim()) errors.push("embedModel is required");
  if (!Number.isInteger(answers.embedDimensions) || answers.embedDimensions <= 0) {
    errors.push("embedDimensions must be a positive integer");
  }

  if (!String(answers.slotDbDir || "").trim()) errors.push("slotDbDir is required");

  const onboardingCommands = Array.isArray(answers.telegramOnboardingCommands)
    ? answers.telegramOnboardingCommands
    : [];
  for (const name of onboardingCommands) {
    const normalized = normalizeTelegramCommandName(name);
    if (!isValidTelegramCommandName(normalized)) {
      errors.push(`invalid telegram command name: ${String(name)}`);
    }
  }

  return errors;
}

export function buildPatchedConfig(existingConfig, answers, mapMemorySlot = true) {
  const root = asObj(existingConfig);
  const plugins = asObj(root.plugins);
  const entries = asObj(plugins.entries);
  const slots = asObj(plugins.slots);

  const allow = dedupeStringArray(plugins.allow);
  if (!allow.includes(PLUGIN_ID)) allow.push(PLUGIN_ID);

  const prevEntry = asObj(entries[PLUGIN_ID]);
  const prevEntryConfig = asObj(prevEntry.config);

  const entry = {
    ...prevEntry,
    enabled: true,
    config: {
      ...prevEntryConfig,
      qdrantHost: answers.qdrantHost,
      qdrantPort: answers.qdrantPort,
      qdrantCollection: answers.qdrantCollection,
      llmBaseUrl: answers.llmBaseUrl,
      llmModel: answers.llmModel,
      llmApiKey: answers.llmApiKey,
      embedBackend: answers.embedBackend,
      embedModel: answers.embedModel,
      embedDimensions: answers.embedDimensions,
      slotDbDir: answers.slotDbDir,
    },
  };

  const nextSlots = { ...slots };
  if (mapMemorySlot) {
    nextSlots.memory = PLUGIN_ID;
  } else if (nextSlots.memory === PLUGIN_ID) {
    delete nextSlots.memory;
  }

  const channels = asObj(root.channels);
  const telegram = asObj(channels.telegram);
  const targets = detectTelegramCustomCommandTargets(telegram);

  let nextTelegram;
  if (targets.mode === "single") {
    nextTelegram = {
      ...telegram,
      customCommands: mergeTelegramCustomCommands(
        telegram.customCommands,
        answers.telegramOnboardingCommands || [],
      ),
    };
  } else {
    const prevAccounts = asObj(telegram.accounts);
    const nextAccounts = { ...prevAccounts };

    for (const accountKey of targets.accountKeys) {
      const account = asObj(prevAccounts[accountKey]);
      nextAccounts[accountKey] = {
        ...account,
        customCommands: mergeTelegramCustomCommands(
          account.customCommands,
          answers.telegramOnboardingCommands || [],
        ),
      };
    }

    nextTelegram = {
      ...telegram,
      accounts: nextAccounts,
    };
  }

  return {
    ...root,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
    plugins: {
      ...plugins,
      allow,
      slots: nextSlots,
      entries: {
        ...entries,
        [PLUGIN_ID]: entry,
      },
    },
  };
}

export function buildBackupPath(configPath, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${configPath}.bak.${ts}`;
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isSameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifySummaryItem(summary, label, beforeValue, afterValue) {
  if (isSameValue(beforeValue, afterValue)) {
    summary.alreadyConfigured.push(label);
    return;
  }

  if (beforeValue === false && afterValue === true) {
    summary.willAdd.push(label);
    return;
  }

  if (typeof beforeValue === "undefined" && typeof afterValue !== "undefined") {
    summary.willAdd.push(label);
    return;
  }

  summary.willUpdate.push(label);
}

export function buildSetupSummary(currentConfig, answers, nextConfig) {
  const current = asObj(currentConfig);
  const next = asObj(nextConfig || buildPatchedConfig(current, answers, answers.mapMemorySlot));

  const currentPlugins = asObj(current.plugins);
  const nextPlugins = asObj(next.plugins);
  const currentEntries = asObj(currentPlugins.entries);
  const nextEntries = asObj(nextPlugins.entries);
  const currentEntry = asObj(currentEntries[PLUGIN_ID]);
  const nextEntry = asObj(nextEntries[PLUGIN_ID]);
  const currentEntryConfig = asObj(currentEntry.config);
  const nextEntryConfig = asObj(nextEntry.config);

  const summary = {
    alreadyConfigured: [],
    willAdd: [],
    willUpdate: [],
  };

  const currentAllowHasPlugin = dedupeStringArray(currentPlugins.allow).includes(PLUGIN_ID);
  const nextAllowHasPlugin = dedupeStringArray(nextPlugins.allow).includes(PLUGIN_ID);
  classifySummaryItem(summary, `plugins.allow includes ${PLUGIN_ID}`, currentAllowHasPlugin, nextAllowHasPlugin);

  classifySummaryItem(
    summary,
    `plugins.entries.${PLUGIN_ID} exists`,
    Object.keys(currentEntry).length > 0,
    Object.keys(nextEntry).length > 0,
  );

  const managedConfigKeys = [
    "qdrantHost",
    "qdrantPort",
    "qdrantCollection",
    "llmBaseUrl",
    "llmModel",
    "llmApiKey",
    "embedBackend",
    "embedModel",
    "embedDimensions",
    "slotDbDir",
  ];

  for (const key of managedConfigKeys) {
    classifySummaryItem(
      summary,
      `plugins.entries.${PLUGIN_ID}.config.${key}`,
      currentEntryConfig[key],
      nextEntryConfig[key],
    );
  }

  classifySummaryItem(
    summary,
    "plugins.slots.memory",
    asObj(currentPlugins.slots).memory,
    asObj(nextPlugins.slots).memory,
  );

  const currentTelegram = asObj(asObj(current.channels).telegram);
  const nextTelegram = asObj(asObj(next.channels).telegram);
  const currentTargets = detectTelegramCustomCommandTargets(currentTelegram);
  const nextTargets = detectTelegramCustomCommandTargets(nextTelegram);
  const commandNames = collectTelegramCommandNames(next, answers);

  if (nextTargets.mode === "single") {
    const currentTelegramCommands = dedupeStringArray(
      (currentTelegram.customCommands || [])
        .map((item) => normalizeTelegramCommandName(item?.command))
        .filter((name) => isValidTelegramCommandName(name)),
    );

    const nextTelegramCommands = dedupeStringArray(
      (nextTelegram.customCommands || [])
        .map((item) => normalizeTelegramCommandName(item?.command))
        .filter((name) => isValidTelegramCommandName(name)),
    );

    for (const commandName of commandNames) {
      classifySummaryItem(
        summary,
        `channels.telegram.customCommands includes /${commandName}`,
        currentTelegramCommands.includes(commandName),
        nextTelegramCommands.includes(commandName),
      );
    }
  } else {
    const accountKeys = dedupeStringArray(nextTargets.accountKeys);
    const currentAccounts = asObj(currentTelegram.accounts);
    const nextAccounts = asObj(nextTelegram.accounts);

    for (const accountKey of accountKeys) {
      const currentTelegramCommands = dedupeStringArray(
        (asObj(currentAccounts[accountKey]).customCommands || [])
          .map((item) => normalizeTelegramCommandName(item?.command))
          .filter((name) => isValidTelegramCommandName(name)),
      );

      const nextTelegramCommands = dedupeStringArray(
        (asObj(nextAccounts[accountKey]).customCommands || [])
          .map((item) => normalizeTelegramCommandName(item?.command))
          .filter((name) => isValidTelegramCommandName(name)),
      );

      for (const commandName of commandNames) {
        classifySummaryItem(
          summary,
          `channels.telegram.accounts.${accountKey}.customCommands includes /${commandName}`,
          currentTelegramCommands.includes(commandName),
          nextTelegramCommands.includes(commandName),
        );
      }
    }

    if (currentTargets.mode !== "multi" && accountKeys.length > 0) {
      summary.willUpdate.push("channels.telegram.customCommands scope switched to account fan-out");
    }
  }

  return summary;
}

export function formatSetupSummary(summary) {
  const sections = [
    ["already configured", summary.alreadyConfigured],
    ["will add", summary.willAdd],
    ["will update", summary.willUpdate],
  ];

  const lines = ["[ASM-83] Setup summary (before confirm):"];
  for (const [label, items] of sections) {
    lines.push(`- ${label} (${items.length})`);
    if (!items.length) {
      lines.push("  • (none)");
      continue;
    }

    for (const item of items) {
      lines.push(`  • ${item}`);
    }
  }

  return lines.join("\n");
}

function previewDiff(beforeText, afterText) {
  if (beforeText === afterText) return "(no change)";
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const max = Math.max(before.length, after.length);
  const lines = [];

  for (let i = 0; i < max; i += 1) {
    const b = before[i];
    const a = after[i];
    if (b === a) continue;
    if (typeof b === "string") lines.push(`- ${b}`);
    if (typeof a === "string") lines.push(`+ ${a}`);
    if (lines.length >= 160) {
      lines.push("... diff truncated ...");
      break;
    }
  }

  return lines.join("\n");
}

async function promptWizard(defaults) {
  const rl = createInterface({ input, output });
  const ask = async (label, current, secret = false) => {
    if (secret) {
      const answer = await rl.question(`${label} [hidden, press Enter to keep current]: `);
      if (!String(answer || "").trim()) return current;
      return String(answer).trim();
    }

    const answer = await rl.question(`${label} [${current ?? ""}]: `);
    return String(answer || "").trim() || current;
  };

  try {
    const qdrantHost = await ask("Qdrant host", defaults.qdrantHost);
    const qdrantPort = toIntOrDefault(await ask("Qdrant port", String(defaults.qdrantPort)), defaults.qdrantPort);
    const qdrantCollection = await ask("Qdrant collection", defaults.qdrantCollection);

    const llmBaseUrl = await ask("LLM base URL", defaults.llmBaseUrl);
    const llmModel = await ask("LLM model", defaults.llmModel);
    const llmApiKey = await ask("LLM API key", defaults.llmApiKey, true);

    const embedBackend = await ask(`Embedding backend (${EMBED_BACKENDS.join("/")})`, defaults.embedBackend);
    const embedModel = await ask("Embedding model", defaults.embedModel);
    const embedDimensions = toIntOrDefault(await ask("Embedding dimensions", String(defaults.embedDimensions)), defaults.embedDimensions);

    const slotDbDir = await ask("slotDbDir", defaults.slotDbDir);

    const mapMemorySlotRaw = await ask("Map plugins.slots.memory = agent-smart-memo? (y/n)", defaults.mapMemorySlot ? "y" : "n");
    const mapMemorySlot = yesNoNormalize(mapMemorySlotRaw, defaults.mapMemorySlot);

    const onboardingCommandsRaw = await ask(
      "Telegram custom onboarding commands (comma-separated)",
      (defaults.telegramOnboardingCommands || []).join(","),
    );
    const telegramOnboardingCommands = dedupeStringArray(
      String(onboardingCommandsRaw || "")
        .split(",")
        .map((item) => normalizeTelegramCommandName(item)),
    ).filter((name) => isValidTelegramCommandName(name));

    return {
      qdrantHost,
      qdrantPort,
      qdrantCollection,
      llmBaseUrl,
      llmModel,
      llmApiKey,
      embedBackend,
      embedModel,
      embedDimensions,
      slotDbDir,
      mapMemorySlot,
      telegramOnboardingCommands,
    };
  } finally {
    rl.close();
  }
}

export async function runInitOpenClaw({ env = process.env, interactive = true, autoApply = false } = {}) {
  const configPath = resolveOpenClawConfigPath(env);
  const current = parseExistingConfig(configPath);
  const pluginCfg = asObj(asObj(asObj(current.plugins).entries)[PLUGIN_ID]).config || {};

  const defaults = {
    qdrantHost: String(pluginCfg.qdrantHost || "localhost"),
    qdrantPort: toIntOrDefault(pluginCfg.qdrantPort, 6333),
    qdrantCollection: String(pluginCfg.qdrantCollection || "mrc_bot"),
    llmBaseUrl: String(pluginCfg.llmBaseUrl || "http://localhost:8317/v1"),
    llmModel: String(pluginCfg.llmModel || "gemini-2.5-flash"),
    llmApiKey: String(pluginCfg.llmApiKey || ""),
    embedBackend: String(pluginCfg.embedBackend || "ollama"),
    embedModel: String(pluginCfg.embedModel || "qwen3-embedding:0.6b"),
    embedDimensions: toIntOrDefault(pluginCfg.embedDimensions, 1024),
    slotDbDir: String(pluginCfg.slotDbDir || env.OPENCLAW_SLOTDB_DIR || `${env.HOME}/.openclaw/agent-memo`),
    mapMemorySlot: asObj(asObj(current.plugins).slots).memory === PLUGIN_ID,
    telegramOnboardingCommands: dedupeStringArray([
      "addproject",
      ...collectTelegramCommandNames(current, { telegramOnboardingCommands: [] }),
    ]),
  };

  const answers = interactive ? await promptWizard(defaults) : defaults;
  const errors = validateAnswers(answers);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }

  const next = buildPatchedConfig(current, answers, answers.mapMemorySlot);
  const summary = buildSetupSummary(current, answers, next);
  const beforeText = toJson(current);
  const afterText = toJson(next);

  console.log(`\n[ASM-83] Config path: ${configPath}`);
  if (!existsSync(configPath)) {
    console.log("[ASM-83] openclaw.json not found. A new file will be created.");
  }

  console.log(`\n${formatSetupSummary(summary)}\n`);

  console.log("[ASM-83] Preview diff:\n");
  console.log(previewDiff(beforeText, afterText));

  if (!autoApply) {
    const rl = createInterface({ input, output });
    try {
      const confirm = await rl.question("\nApply changes and write config? (y/N): ");
      if (!yesNoNormalize(confirm, false)) {
        console.log("[ASM-83] Aborted by user. No file written.");
        return { applied: false, configPath };
      }
    } finally {
      rl.close();
    }
  } else {
    console.log("\n[ASM-83] Auto-apply mode enabled. Writing config without confirmation prompt.");
  }

  mkdirSync(dirname(configPath), { recursive: true });

  let backupPath = null;
  if (existsSync(configPath)) {
    backupPath = buildBackupPath(configPath, new Date());
    copyFileSync(configPath, backupPath);
    console.log(`[ASM-83] Backup created: ${backupPath}`);
  }

  writeFileSync(configPath, afterText, "utf8");
  console.log(`[ASM-83] Config updated: ${configPath}`);

  console.log("\n[ASM-83] Next steps:");
  console.log("1) Restart OpenClaw runtime (if running)");
  console.log("2) Verify plugin is loaded: agent-smart-memo");
  console.log("3) Optional: run a memory tool smoke test (memory_slot_set/get)");

  return {
    applied: true,
    configPath,
    backupPath,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runInitOpenClaw({ interactive: true })
    .catch((error) => {
      console.error(`[ASM-83] Failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
