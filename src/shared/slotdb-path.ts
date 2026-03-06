import { join } from "node:path";

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
 * 1) OPENCLAW_SLOTDB_DIR
 * 2) plugin config slotDbDir
 * 3) legacy fallback: ${stateDir}/agent-memo
 */
export function resolveSlotDbDir(input: ResolveSlotDbDirInput): string {
  const env = input.env || process.env;
  const envSlotDbDir = env.OPENCLAW_SLOTDB_DIR?.trim();
  const configSlotDbDir = input.slotDbDir?.trim();

  const resolvedFromConfig = envSlotDbDir || configSlotDbDir;
  if (resolvedFromConfig) {
    return expandHome(resolvedFromConfig, input.homeDir || env.HOME);
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
