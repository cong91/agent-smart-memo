import { SlotDB } from "../../db/slot-db.js";
import { resolveSlotDbDir } from "../../shared/slotdb-path.js";
import { DefaultMemoryUseCasePort } from "../../core/usecases/default-memory-usecase-port.js";
import { PaperclipAdapter } from "./paperclip-adapter.js";
import { QdrantClient } from "../../services/qdrant.js";
import { EmbeddingClient } from "../../services/embedding.js";
import { DeduplicationService } from "../../services/dedupe.js";
import { SemanticMemoryUseCase } from "../../core/usecases/semantic-memory-usecase.js";

export interface PaperclipRuntimeOptions {
  stateDir?: string;
  slotDbDir?: string;
  qdrantHost?: string;
  qdrantPort?: number;
  qdrantCollection?: string;
  qdrantVectorSize?: number;
  embedBaseUrl?: string;
  embedBackend?: "ollama" | "openai" | "docker";
  embedModel?: string;
  embedDimensions?: number;
  semanticUseCase?: SemanticMemoryUseCase;
}

export interface PaperclipRuntime {
  adapter: PaperclipAdapter;
  slotDb: SlotDB;
  useCasePort: DefaultMemoryUseCasePort;
  semanticUseCase: SemanticMemoryUseCase;
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

  const semanticUseCase = options?.semanticUseCase || (() => {
    const qdrant = new QdrantClient({
      host: options?.qdrantHost || process.env.AGENT_MEMO_QDRANT_HOST || "localhost",
      port: Number(options?.qdrantPort || process.env.AGENT_MEMO_QDRANT_PORT || 6333),
      collection: options?.qdrantCollection || process.env.AGENT_MEMO_QDRANT_COLLECTION || "mrc_bot",
      vectorSize: Number(options?.qdrantVectorSize || process.env.AGENT_MEMO_QDRANT_VECTOR_SIZE || 1024),
    });

    const embedding = new EmbeddingClient({
      embeddingApiUrl: options?.embedBaseUrl || process.env.AGENT_MEMO_EMBED_BASE_URL || "http://localhost:11434",
      backend: options?.embedBackend,
      model: options?.embedModel || process.env.AGENT_MEMO_EMBED_MODEL || "qwen3-embedding:0.6b",
      dimensions: Number(options?.embedDimensions || process.env.AGENT_MEMO_EMBED_DIMENSIONS || 1024),
      stateDir,
    });

    const dedupe = new DeduplicationService(0.95, console);
    return new SemanticMemoryUseCase(qdrant, embedding, dedupe);
  })();
  const useCasePort = new DefaultMemoryUseCasePort(slotDb, semanticUseCase);
  const adapter = new PaperclipAdapter(useCasePort);

  return {
    adapter,
    slotDb,
    useCasePort,
    semanticUseCase,
  };
}
