import { SlotDB } from "../../db/slot-db.js";
import { DefaultMemoryUseCasePort } from "../../core/usecases/default-memory-usecase-port.js";
import type { MemoryUseCasePort } from "../../core/contracts/adapter-contracts.js";
import type { SemanticMemoryUseCase } from "../../core/usecases/semantic-memory-usecase.js";
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
let semanticUseCaseFactory: ((slotDbDir: string) => SemanticMemoryUseCase | undefined) | undefined;

export function configureOpenClawRuntime(options?: {
  stateDir?: string;
  slotDbDir?: string;
  semanticUseCaseFactory?: (slotDbDir: string) => SemanticMemoryUseCase | undefined;
}): MemoryRuntimeConfig {
  runtimeConfig = {
    stateDir: options?.stateDir || runtimeConfig.stateDir,
    slotDbDir: options?.slotDbDir || runtimeConfig.slotDbDir,
  };
  if (options?.semanticUseCaseFactory) {
    semanticUseCaseFactory = options.semanticUseCaseFactory;
  }
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
    const semanticUseCase = semanticUseCaseFactory ? semanticUseCaseFactory(slotDbDir) : undefined;
    port = new DefaultMemoryUseCasePort(db, semanticUseCase);
    useCasePortInstances.set(slotDbDir, port);
  }
  return port;
}

export function createOpenClawResult(text: string, isError = false) {
  return createToolTextResult(text, isError);
}
