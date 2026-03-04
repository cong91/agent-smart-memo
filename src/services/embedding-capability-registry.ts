import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CapabilitySource = "docs" | "probe" | "error-feedback";

export interface EmbeddingModelCapability {
  seedMaxTokens: number;
  discoveredMaxTokens: number;
  safeRatio: number;
  reserveTokens: number;
  vectorDim: number;
  updatedAt: string;
  source: CapabilitySource;
}

interface RegistryFileSchema {
  version: 1;
  capabilities: Record<string, EmbeddingModelCapability>;
}

const EMPTY_REGISTRY: RegistryFileSchema = {
  version: 1,
  capabilities: {},
};

export class EmbeddingCapabilityRegistry {
  private readonly filePath: string;
  private readonly logger: any;
  private loaded = false;
  private data: RegistryFileSchema = { ...EMPTY_REGISTRY };

  constructor(stateDir: string, logger?: any) {
    this.filePath = join(stateDir, "plugin-data", "agent-smart-memo", "embedding-capabilities.json");
    this.logger = logger || console;
  }

  getPath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as RegistryFileSchema;
      if (parsed && parsed.version === 1 && parsed.capabilities && typeof parsed.capabilities === "object") {
        this.data = parsed;
      } else {
        this.data = { ...EMPTY_REGISTRY };
      }
    } catch {
      this.data = { ...EMPTY_REGISTRY };
    }

    this.loaded = true;
  }

  async get(modelKey: string): Promise<EmbeddingModelCapability | null> {
    await this.load();
    return this.data.capabilities[modelKey] || null;
  }

  async set(modelKey: string, capability: EmbeddingModelCapability): Promise<void> {
    await this.load();
    this.data.capabilities[modelKey] = capability;
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (error: any) {
      this.logger.warn?.(`[EmbeddingCapabilityRegistry] persist failed: ${error.message}`);
    }
  }
}
