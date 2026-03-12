import { SlotDB } from "../../db/slot-db.js";
import { resolveSlotDbDir } from "../../shared/slotdb-path.js";
import { DefaultMemoryUseCasePort } from "../../core/usecases/default-memory-usecase-port.js";
import { PaperclipAdapter } from "./paperclip-adapter.js";

export interface PaperclipRuntimeOptions {
  stateDir?: string;
  slotDbDir?: string;
}

export interface PaperclipRuntime {
  adapter: PaperclipAdapter;
  slotDb: SlotDB;
  useCasePort: DefaultMemoryUseCasePort;
}

export function createPaperclipRuntime(options?: PaperclipRuntimeOptions): PaperclipRuntime {
  const stateDir = options?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  const slotDbDir = resolveSlotDbDir({
    stateDir,
    slotDbDir: options?.slotDbDir,
    env: process.env,
    homeDir: process.env.HOME,
  });

  const slotDb = new SlotDB(stateDir, { slotDbDir });
  const useCasePort = new DefaultMemoryUseCasePort(slotDb);
  const adapter = new PaperclipAdapter(useCasePort);

  return {
    adapter,
    slotDb,
    useCasePort,
  };
}
