import { join } from "node:path";
import { resolveAsmCoreSlotDbDir } from "./asm-config.js";

export interface ResolveSlotDbDirInput {
  stateDir?: string;
  slotDbDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function expandHome(input: string, homeDir?: string): string {
  if (!input.startsWith("~")) return input;
  const home = homeDir || process.env.HOME || "";
  if (!home) return input;
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * Resolve SlotDB directory with priority:
 * 1) OPENCLAW_SLOTDB_DIR (runtime/env override)
 * 2) plugin config slotDbDir (runtime-local adapter config)
 * 3) ASM shared config core.storage.slotDbDir (~/.config/asm/config.json)
 * 4) legacy fallback: ${stateDir}/agent-memo
 */
export function resolveSlotDbDir(input: ResolveSlotDbDirInput): string {
  const env = input.env || process.env;
  const envSlotDbDir = env.OPENCLAW_SLOTDB_DIR?.trim();
  const configSlotDbDir = input.slotDbDir?.trim();

  const resolvedFromRuntime = envSlotDbDir || configSlotDbDir;
  if (resolvedFromRuntime) {
    return expandHome(resolvedFromRuntime, input.homeDir || env.HOME);
  }

  const sharedCoreSlotDbDir = resolveAsmCoreSlotDbDir({
    env,
    homeDir: input.homeDir || env.HOME,
  });
  if (sharedCoreSlotDbDir) {
    return expandHome(sharedCoreSlotDbDir, input.homeDir || env.HOME);
  }

  const stateDir = input.stateDir?.trim()
    || env.OPENCLAW_STATE_DIR?.trim()
    || `${env.HOME}/.openclaw`;

  return join(expandHome(stateDir, input.homeDir || env.HOME), "agent-memo");
}

/**
 * Backward compatibility resolver for legacy constructor usage:
 * - If the provided path already points to an `agent-memo` directory, use as-is.
 * - Otherwise treat it as OPENCLAW_STATE_DIR and append `agent-memo`.
 */
export function resolveLegacyStateDirInput(stateDirOrSlotDbDir: string): string {
  const expanded = expandHome(stateDirOrSlotDbDir);
  const normalized = expanded.replace(/\\+$/, "").replace(/\/+$/, "");

  if (normalized.endsWith("/agent-memo") || normalized.endsWith("\\agent-memo")) {
    return expanded;
  }

  return join(expanded, "agent-memo");
}
