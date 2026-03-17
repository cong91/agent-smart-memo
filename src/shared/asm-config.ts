import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AsmSharedConfigCore {
  projectWorkspaceRoot?: string;
  qdrantHost?: string;
  qdrantPort?: number;
  qdrantCollection?: string;
  qdrantVectorSize?: number;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  embedBaseUrl?: string;
  embedBackend?: string;
  embedModel?: string;
  embedDimensions?: number;
  autoCaptureEnabled?: boolean;
  autoCaptureMinConfidence?: number;
  contextWindowMaxTokens?: number;
  summarizeEveryActions?: number;
  storage?: {
    slotDbDir?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type AsmSharedConfigAdapters = Record<string, Record<string, unknown>>;

export interface AsmSharedConfig {
  schemaVersion?: number;
  core?: AsmSharedConfigCore;
  adapters?: AsmSharedConfigAdapters;
  [key: string]: unknown;
}

export interface ResolveAsmConfigPathInput {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configPath?: string;
}

export interface ResolveAsmConfigPathInfo {
  path: string;
  source: "explicit" | "env" | "default";
  exists: boolean;
}

export interface LoadAsmSharedConfigInput extends ResolveAsmConfigPathInput {
  reload?: boolean;
}

export interface LoadAsmSharedConfigResult {
  path: string;
  config: AsmSharedConfig | null;
  lifecycle: {
    cache: "hit" | "miss" | "bypass";
    loadedAt: string;
    mtimeMs?: number;
    status: "ok" | "missing" | "invalid_json" | "invalid_shape" | "read_error";
    source: "explicit" | "env" | "default";
    warnings: string[];
    error?: string;
  };
}

export interface AsmSharedConfigDoctorResult {
  path: string;
  source: "explicit" | "env" | "default";
  exists: boolean;
  status: "ok" | "missing" | "invalid_json" | "invalid_shape" | "read_error";
  cache: "hit" | "miss" | "bypass";
  hasCore: boolean;
  adapterNames: string[];
  legacyKeys: {
    slotDbDir: boolean;
    projectWorkspaceRoot: boolean;
    storageSlotDbDir: boolean;
  };
  warnings: string[];
}

const DEFAULT_ASM_CONFIG_RELATIVE_PATH = ".config/asm/config.json";

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function expandHome(input: string, homeDir?: string): string {
  if (!input.startsWith("~")) return input;

  const home = firstNonEmptyString(homeDir, process.env.HOME);
  if (!home) return input;

  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function normalizePath(input: string): string {
  const expanded = expandHome(input);
  return resolve(expanded);
}

function normalizeAsmSharedConfig(raw: unknown): { config: AsmSharedConfig | null; warnings: string[]; invalidShape: boolean } {
  if (!isPlainObject(raw)) {
    return {
      config: null,
      warnings: ["config root must be a JSON object"],
      invalidShape: true,
    };
  }

  const config: AsmSharedConfig = {};
  const warnings: string[] = [];

  if (raw.schemaVersion != null) {
    if (typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)) {
      config.schemaVersion = raw.schemaVersion;
    } else {
      warnings.push("schemaVersion must be a finite number when provided");
    }
  }

  if (raw.core != null) {
    if (isPlainObject(raw.core)) {
      config.core = raw.core as AsmSharedConfigCore;
    } else {
      warnings.push("core must be an object when provided");
    }
  }

  if (raw.adapters != null) {
    if (isPlainObject(raw.adapters)) {
      const normalizedAdapters: AsmSharedConfigAdapters = {};
      for (const [adapterName, adapterValue] of Object.entries(raw.adapters)) {
        if (!isPlainObject(adapterValue)) {
          warnings.push(`adapters.${adapterName} ignored because value is not an object`);
          continue;
        }
        normalizedAdapters[adapterName] = adapterValue;
      }
      config.adapters = normalizedAdapters;
    } else {
      warnings.push("adapters must be an object when provided");
    }
  }

  // Keep additional keys for forward compatibility.
  for (const [key, value] of Object.entries(raw)) {
    if (key === "schemaVersion" || key === "core" || key === "adapters") continue;
    config[key] = value;
  }

  const invalidShape = warnings.some(
    (item) => item.includes("must be") && (item.startsWith("config root") || item.startsWith("core") || item.startsWith("adapters")),
  );

  return { config, warnings, invalidShape };
}

function resolveAsmConfigPathInfoInternal(input: ResolveAsmConfigPathInput = {}): ResolveAsmConfigPathInfo {
  const env = input.env || process.env;

  const explicitPath = firstNonEmptyString(input.configPath);
  if (explicitPath) {
    const path = normalizePath(explicitPath);
    return {
      path,
      source: "explicit",
      exists: existsSync(path),
    };
  }

  const envPath = firstNonEmptyString(env.ASM_CONFIG);
  if (envPath) {
    const path = normalizePath(envPath);
    return {
      path,
      source: "env",
      exists: existsSync(path),
    };
  }

  const home = firstNonEmptyString(input.homeDir, env.HOME, process.env.HOME, process.cwd()) || process.cwd();
  const path = resolve(home, DEFAULT_ASM_CONFIG_RELATIVE_PATH);
  return {
    path,
    source: "default",
    exists: existsSync(path),
  };
}

export function resolveAsmConfigPath(input: ResolveAsmConfigPathInput = {}): string {
  return resolveAsmConfigPathInfoInternal(input).path;
}

export function resolveAsmConfigPathInfo(input: ResolveAsmConfigPathInput = {}): ResolveAsmConfigPathInfo {
  return resolveAsmConfigPathInfoInternal(input);
}

let cache: {
  path: string;
  mtimeMs: number;
  config: AsmSharedConfig | null;
  warnings: string[];
  status: "ok" | "missing" | "invalid_json" | "invalid_shape" | "read_error";
} | null = null;

function readAsmSharedConfigFromDisk(path: string): {
  mtimeMs: number;
  config: AsmSharedConfig | null;
  warnings: string[];
  status: "ok" | "invalid_shape";
} {
  const mtimeMs = statSync(path).mtimeMs;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const normalized = normalizeAsmSharedConfig(parsed);
  return {
    mtimeMs,
    config: normalized.config,
    warnings: normalized.warnings,
    status: normalized.invalidShape ? "invalid_shape" : "ok",
  };
}

export function invalidateAsmSharedConfigCache(path?: string): void {
  if (!cache) return;
  if (!path || cache.path === resolve(path)) {
    cache = null;
  }
}

export function loadAsmSharedConfig(input: LoadAsmSharedConfigInput = {}): LoadAsmSharedConfigResult {
  const pathInfo = resolveAsmConfigPathInfoInternal(input);
  const path = pathInfo.path;

  if (!pathInfo.exists) {
    invalidateAsmSharedConfigCache(path);
    return {
      path,
      config: null,
      lifecycle: {
        cache: input.reload ? "bypass" : "miss",
        loadedAt: new Date().toISOString(),
        status: "missing",
        source: pathInfo.source,
        warnings: ["shared config file not found"],
      },
    };
  }

  try {
    const mtimeMs = statSync(path).mtimeMs;

    if (!input.reload && cache && cache.path === path && cache.mtimeMs === mtimeMs) {
      return {
        path,
        config: cache.config,
        lifecycle: {
          cache: "hit",
          loadedAt: new Date().toISOString(),
          mtimeMs,
          status: cache.status,
          source: pathInfo.source,
          warnings: [...cache.warnings],
        },
      };
    }

    const loaded = readAsmSharedConfigFromDisk(path);
    cache = {
      path,
      mtimeMs: loaded.mtimeMs,
      config: loaded.config,
      warnings: [...loaded.warnings],
      status: loaded.status,
    };
    return {
      path,
      config: loaded.config,
      lifecycle: {
        cache: input.reload ? "bypass" : "miss",
        loadedAt: new Date().toISOString(),
        mtimeMs: loaded.mtimeMs,
        status: loaded.status,
        source: pathInfo.source,
        warnings: [...loaded.warnings],
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.toLowerCase().includes("json") ? "invalid_json" : "read_error";
    return {
      path,
      config: null,
      lifecycle: {
        cache: input.reload ? "bypass" : "miss",
        loadedAt: new Date().toISOString(),
        status,
        source: pathInfo.source,
        warnings: ["failed to parse/read shared config file"],
        error: message,
      },
    };
  }
}

function resolveLegacySlotDbDir(config: AsmSharedConfig | null): string | undefined {
  return firstNonEmptyString(
    config?.core?.storage?.slotDbDir,
    (config?.storage as Record<string, unknown> | undefined)?.slotDbDir,
    config?.slotDbDir,
  );
}

export function resolveAsmCoreSlotDbDir(input: LoadAsmSharedConfigInput = {}): string | undefined {
  const { config } = loadAsmSharedConfig(input);
  const value = resolveLegacySlotDbDir(config);
  return value ? expandHome(value, input.homeDir || input.env?.HOME) : undefined;
}

export function resolveAsmCoreProjectWorkspaceRoot(input: LoadAsmSharedConfigInput = {}): string | undefined {
  const { config } = loadAsmSharedConfig(input);
  const value = firstNonEmptyString(
    config?.core?.projectWorkspaceRoot,
    config?.projectWorkspaceRoot,
  );
  return value ? expandHome(value, input.homeDir || input.env?.HOME) : undefined;
}

export function resolveAsmCoreConfigValue<T = unknown>(key: keyof AsmSharedConfigCore, input: LoadAsmSharedConfigInput = {}): T | undefined {
  const { config } = loadAsmSharedConfig(input);
  const core = config?.core as Record<string, unknown> | undefined;
  return core?.[String(key)] as T | undefined;
}

export function resolveAsmAdapterLocalConfig(
  adapterName: string,
  input: LoadAsmSharedConfigInput = {},
): Record<string, unknown> | undefined {
  const normalizedName = firstNonEmptyString(adapterName);
  if (!normalizedName) return undefined;

  const { config } = loadAsmSharedConfig(input);
  const adapterConfig = config?.adapters?.[normalizedName];
  return isPlainObject(adapterConfig) ? adapterConfig : undefined;
}

export function getAsmSharedConfig(input: LoadAsmSharedConfigInput = {}): LoadAsmSharedConfigResult {
  return loadAsmSharedConfig(input);
}

export function doctorAsmSharedConfig(input: LoadAsmSharedConfigInput = {}): AsmSharedConfigDoctorResult {
  const pathInfo = resolveAsmConfigPathInfo(input);
  const loaded = loadAsmSharedConfig(input);

  return {
    path: loaded.path,
    source: pathInfo.source,
    exists: pathInfo.exists,
    status: loaded.lifecycle.status,
    cache: loaded.lifecycle.cache,
    hasCore: isPlainObject(loaded.config?.core),
    adapterNames: Object.keys(loaded.config?.adapters || {}).sort((a, b) => a.localeCompare(b)),
    legacyKeys: {
      slotDbDir: typeof loaded.config?.slotDbDir === "string",
      projectWorkspaceRoot: typeof loaded.config?.projectWorkspaceRoot === "string",
      storageSlotDbDir: typeof (loaded.config?.storage as Record<string, unknown> | undefined)?.slotDbDir === "string",
    },
    warnings: [...loaded.lifecycle.warnings],
  };
}
