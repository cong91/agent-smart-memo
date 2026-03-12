import { SlotDB } from "../../db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../../core/usecases/default-memory-usecase-port.js";
import type { MemoryUseCasePort } from "../../core/contracts/adapter-contracts.js";
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
const useCasePortInstances = new Map<string, MemoryUseCasePort>();

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

export function getMemoryUseCasePortForContext(ctx: any): MemoryUseCasePort {
  const slotDbDir = resolveSlotDbDirForContext(ctx, runtimeConfig);
  let port = useCasePortInstances.get(slotDbDir);
  if (!port) {
    const db = getSlotDBForContext(ctx);
    port = new DefaultMemoryUseCasePort(db);
    useCasePortInstances.set(slotDbDir, port);
  }
  return port;
}

export function createOpenClawResult(text: string, isError = false) {
  return createToolTextResult(text, isError);
}
