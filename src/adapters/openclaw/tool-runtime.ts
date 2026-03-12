import { SlotDB } from "../../db/slot-db.js";
import {
  createInitialRuntimeConfig,
  createToolTextResult,
  parseSessionIdentity,
  resolveSlotDbDirForContext,
  type MemoryRuntimeConfig,
} from "../../core/runtime-boundary.js";

// OpenClaw runtime adapter state
let runtimeConfig: MemoryRuntimeConfig = createInitialRuntimeConfig();
const dbInstances = new Map<string, SlotDB>();

export function configureOpenClawRuntime(options?: {
  stateDir?: string;
  slotDbDir?: string;
}): MemoryRuntimeConfig {
  runtimeConfig = {
    stateDir: options?.stateDir || runtimeConfig.stateDir,
    slotDbDir: options?.slotDbDir || runtimeConfig.slotDbDir,
  };
  return runtimeConfig;
}

export function getSessionKey(ctx: any): string {
  return ctx?.sessionKey || "agent:main:default";
}

export function parseOpenClawSessionIdentity(sessionKey: string): {
  userId: string;
  agentId: string;
} {
  return parseSessionIdentity(sessionKey);
}

export function getSlotDBForContext(ctx: any): SlotDB {
  const slotDbDir = resolveSlotDbDirForContext(ctx, runtimeConfig);
  let db = dbInstances.get(slotDbDir);
  if (!db) {
    db = new SlotDB(runtimeConfig.stateDir, { slotDbDir });
    dbInstances.set(slotDbDir, db);
  }
  return db;
}

export function createOpenClawResult(text: string, isError = false) {
  return createToolTextResult(text, isError);
}
