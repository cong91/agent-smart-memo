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

  return {
    ...root,
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
    };
  } finally {
    rl.close();
  }
}

export async function runInitOpenClaw({ env = process.env, interactive = true } = {}) {
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
  };

  const answers = interactive ? await promptWizard(defaults) : defaults;
  const errors = validateAnswers(answers);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }

  const next = buildPatchedConfig(current, answers, answers.mapMemorySlot);
  const beforeText = toJson(current);
  const afterText = toJson(next);

  console.log(`\n[ASM-83] Config path: ${configPath}`);
  if (!existsSync(configPath)) {
    console.log("[ASM-83] openclaw.json not found. A new file will be created.");
  }

  console.log("\n[ASM-83] Preview diff:\n");
  console.log(previewDiff(beforeText, afterText));

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
