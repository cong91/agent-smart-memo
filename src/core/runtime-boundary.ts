import { resolveSlotDbDir } from "../shared/slotdb-path.js";

export interface MemoryRuntimeConfig {
  stateDir: string;
  slotDbDir: string;
}

export function createInitialRuntimeConfig(): MemoryRuntimeConfig {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return {
    stateDir,
    slotDbDir: resolveSlotDbDir({
      stateDir,
      env: process.env,
      homeDir: process.env.HOME,
    }),
  };
}

export function resolveSlotDbDirForContext(
  ctx: any,
  runtimeConfig: MemoryRuntimeConfig,
): string {
  const stateDir = ctx?.stateDir || runtimeConfig.stateDir;
  const configSlotDbDir = ctx?.pluginConfig?.slotDbDir || ctx?.config?.slotDbDir;
  return resolveSlotDbDir({
    stateDir,
    slotDbDir: configSlotDbDir,
    env: process.env,
    homeDir: process.env.HOME,
  });
}

export function parseSessionIdentity(sessionKey?: string): {
  userId: string;
  agentId: string;
} {
  const normalized = typeof sessionKey === "string" && sessionKey.trim().length > 0
    ? sessionKey.trim()
    : "agent:main:default";

  const parts = normalized.split(":");
  const agentId = parts.length >= 2 ? parts[1] : "main";
  const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";
  return { userId, agentId };
}

export function createToolTextResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { toolResult: { text } },
    isError,
  };
}
