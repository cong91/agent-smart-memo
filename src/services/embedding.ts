import { EmbeddingCapabilityRegistry, type EmbeddingModelCapability, type CapabilitySource } from "./embedding-capability-registry.js";

export interface EmbeddingMetadata {
  embedding_chunked: boolean;
  embedding_chunks_count: number;
  embedding_chunking_strategy: "array_batch_weighted_avg";
  embedding_model: string;
  embedding_model_key: string;
  embedding_provider: "openai" | "ollama" | "auto";
  embedding_max_tokens: number;
  embedding_safe_chunk_tokens: number;
  embedding_source: CapabilitySource;
  embedding_fallback_hash: boolean;
}

export interface EmbeddingResult {
  vector: number[];
  metadata: EmbeddingMetadata;
}

class EmbeddingHttpError extends Error {
  status: number;
  bodyPreview: string;

  constructor(status: number, bodyPreview: string, message?: string) {
    super(message || `Embedding API error: ${status}`);
    this.name = "EmbeddingHttpError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

interface EmbeddingDefaults {
  seedMaxTokens: number;
  safeRatio: number;
  reserveTokens: number;
  vectorDim: number;
}

const MODEL_DEFAULTS: Record<string, EmbeddingDefaults> = {
  "text-embedding-3-small": { seedMaxTokens: 8192, safeRatio: 0.82, reserveTokens: 64, vectorDim: 1536 },
  "text-embedding-3-large": { seedMaxTokens: 8192, safeRatio: 0.82, reserveTokens: 64, vectorDim: 3072 },
  "qwen3-embedding:0.6b": { seedMaxTokens: 8192, safeRatio: 0.76, reserveTokens: 80, vectorDim: 1024 },
  "qwen3-embedding:4b": { seedMaxTokens: 8192, safeRatio: 0.72, reserveTokens: 128, vectorDim: 2560 },
};

/**
 * Embedding service client with runtime capability calibration + persistence
 */
export class EmbeddingClient {
  private config: {
    embeddingApiUrl: string;
    timeout: number;
    model: string;
    dimensions: number;
    stateDir: string;
  };
  private logger: any;

  private registry: EmbeddingCapabilityRegistry;
  private capability!: EmbeddingModelCapability;
  private activeEndpoint = "";
  private provider: "openai" | "ollama" | "auto" = "auto";
  private modelKey = "";
  private readonly ready: Promise<void>;

  constructor(config: { embeddingApiUrl?: string; timeout?: number; dimensions?: number; model?: string; stateDir?: string }, logger?: any) {
    const model = config.model || "qwen3-embedding:0.6b";
    const defaults = MODEL_DEFAULTS[model] || { seedMaxTokens: 4096, safeRatio: 0.72, reserveTokens: 96, vectorDim: config.dimensions || 1024 };

    this.config = {
      embeddingApiUrl: config.embeddingApiUrl || "http://localhost:11434",
      timeout: config.timeout || 30000,
      model,
      dimensions: config.dimensions || defaults.vectorDim,
      stateDir: config.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`,
    };
    this.logger = logger || console;
    this.registry = new EmbeddingCapabilityRegistry(this.config.stateDir, this.logger);
    this.ready = this.initializeCapabilities();
  }

  private resolveEmbeddingEndpoints(rawBaseUrl: string): string[] {
    const base = (rawBaseUrl || "").trim();
    const normalizedBase = (base || "http://localhost:11434").replace(/\/+$/, "");

    if (/(\/v1\/embeddings|\/api\/embeddings)\/?$/i.test(normalizedBase)) {
      return [normalizedBase];
    }

    return [`${normalizedBase}/v1/embeddings`, `${normalizedBase}/api/embeddings`];
  }

  private detectProvider(endpoint: string): "openai" | "ollama" | "auto" {
    if (/\/v1\/embeddings\/?$/i.test(endpoint)) return "openai";
    if (/\/api\/embeddings\/?$/i.test(endpoint)) return "ollama";
    return "auto";
  }

  private getDefaults(): EmbeddingDefaults {
    return MODEL_DEFAULTS[this.config.model] || {
      seedMaxTokens: 4096,
      safeRatio: 0.72,
      reserveTokens: 96,
      vectorDim: this.config.dimensions,
    };
  }

  private buildModelKey(provider: string, endpoint: string): string {
    return `${provider}::${endpoint}::${this.config.model}`;
  }

  private tokenBudget(): number {
    const discovered = Math.max(256, this.capability.discoveredMaxTokens || this.capability.seedMaxTokens);
    const rawBudget = Math.floor(discovered * this.capability.safeRatio) - this.capability.reserveTokens;
    return Math.max(128, rawBudget);
  }

  // conservative estimator: whitespace tokens + char heuristic safeguard
  private estimateTokens(text: string): number {
    const whitespaceTokens = text.trim() ? text.trim().split(/\s+/).length : 0;
    const charTokens = Math.ceil(text.length / 4);
    return Math.max(1, Math.max(whitespaceTokens, charTokens));
  }

  private normalizeInput(input: string | string[]): string[] {
    if (Array.isArray(input)) {
      return input
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0);
    }

    if (typeof input === "string") {
      const trimmed = input.trim();
      return trimmed ? [trimmed] : [];
    }

    return [];
  }

  private splitIntoSentences(text: string): string[] {
    return text
      .split(/(?<=[\n\.!?;])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private chunkTextByTokenBudget(text: string, tokenBudget: number): string[] {
    if (this.estimateTokens(text) <= tokenBudget) return [text];

    const sentences = this.splitIntoSentences(text);
    if (sentences.length === 0) return [text.slice(0, Math.max(64, tokenBudget * 4))];

    const chunks: string[] = [];
    let current = "";

    const pushCurrent = () => {
      const trimmed = current.trim();
      if (trimmed.length > 0) chunks.push(trimmed);
      current = "";
    };

    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (this.estimateTokens(next) <= tokenBudget) {
        current = next;
        continue;
      }

      if (current) pushCurrent();

      if (this.estimateTokens(sentence) <= tokenBudget) {
        current = sentence;
        continue;
      }

      // ultra-long sentence fallback: split by words with hard guard
      const words = sentence.split(/\s+/).filter(Boolean);
      let wordChunk = "";
      for (const word of words) {
        const candidate = wordChunk ? `${wordChunk} ${word}` : word;
        if (this.estimateTokens(candidate) <= tokenBudget) {
          wordChunk = candidate;
        } else {
          if (wordChunk) chunks.push(wordChunk);
          wordChunk = word;
        }
      }
      if (wordChunk) chunks.push(wordChunk);
    }

    if (current) pushCurrent();
    return chunks.filter((c) => this.estimateTokens(c) <= tokenBudget + 2);
  }

  private l2Normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (!Number.isFinite(norm) || norm === 0) return vector;
    return vector.map((v) => v / norm);
  }

  private weightedAverage(vectors: number[][], weights: number[]): number[] {
    if (vectors.length === 0) return [];

    const dim = vectors[0].length;
    const out = new Array<number>(dim).fill(0);
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i];
      const w = weights[i] || 1;
      for (let d = 0; d < dim; d++) {
        out[d] += vec[d] * w;
      }
    }

    for (let d = 0; d < dim; d++) {
      out[d] /= weightSum;
    }

    return this.l2Normalize(out);
  }

  private isContextLengthError(error: unknown): error is EmbeddingHttpError {
    if (!(error instanceof EmbeddingHttpError)) return false;
    if (![400, 413, 422, 500].includes(error.status)) return false;
    return /context length|maximum context|too many tokens|exceed|token limit|8192|input length/i.test(error.bodyPreview || "");
  }

  private extractTokenLimitFromError(errorText: string): number | null {
    const normalized = errorText || "";
    const patterns = [
      /(?:context length|maximum context|token(?:s)? limit)[^\d]*(\d{3,6})/i,
      /exceeds[^\d]*(\d{3,6})/i,
      /max(?:imum)?[^\d]*(\d{3,6})\s*tokens?/i,
    ];

    for (const p of patterns) {
      const m = normalized.match(p);
      if (m?.[1]) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed) && parsed >= 128) return parsed;
      }
    }

    return null;
  }

  private async updateCapabilityFromContextError(error: EmbeddingHttpError): Promise<void> {
    const parsed = this.extractTokenLimitFromError(error.bodyPreview || "");
    const current = this.capability.discoveredMaxTokens || this.capability.seedMaxTokens;
    const fallback = Math.floor(current * 0.85);
    const discovered = Math.max(128, parsed ? Math.min(current, parsed) : fallback);

    if (discovered < current) {
      this.capability = {
        ...this.capability,
        discoveredMaxTokens: discovered,
        updatedAt: new Date().toISOString(),
        source: "error-feedback",
      };
      await this.registry.set(this.modelKey, this.capability);
      this.logger.warn(`[Embedding] capability refined from error-feedback: ${current} -> ${discovered} (modelKey=${this.modelKey})`);
    }
  }

  private async initializeCapabilities(): Promise<void> {
    const endpoints = this.resolveEmbeddingEndpoints(this.config.embeddingApiUrl);
    const endpoint = endpoints[0];
    const provider = this.detectProvider(endpoint);
    this.activeEndpoint = endpoint;
    this.provider = provider;
    this.modelKey = this.buildModelKey(provider, endpoint);

    const defaults = this.getDefaults();
    const existing = await this.registry.get(this.modelKey);

    this.capability = existing || {
      seedMaxTokens: defaults.seedMaxTokens,
      discoveredMaxTokens: defaults.seedMaxTokens,
      safeRatio: defaults.safeRatio,
      reserveTokens: defaults.reserveTokens,
      vectorDim: defaults.vectorDim,
      updatedAt: new Date().toISOString(),
      source: "docs",
    };

    if (!existing) {
      await this.registry.set(this.modelKey, this.capability);
    }

    // light startup calibration (max 1/day)
    const ageMs = Date.now() - new Date(this.capability.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
      await this.calibrateRuntimeCapability();
    }
  }

  private async readEndpointMetadata(): Promise<Partial<EmbeddingModelCapability>> {
    const endpoint = this.activeEndpoint;
    const provider = this.detectProvider(endpoint);

    try {
      if (provider === "ollama") {
        const base = endpoint.replace(/\/api\/embeddings\/?$/i, "");
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return {};
        const json = await res.json();
        const models = Array.isArray(json?.models) ? json.models : [];
        const modelInfo = models.find((m: any) => m?.model === this.config.model || m?.name === this.config.model);
        const dimFromModel = Number(modelInfo?.details?.embedding_length || modelInfo?.details?.dimensions || 0);
        return {
          vectorDim: dimFromModel > 0 ? dimFromModel : undefined,
        };
      }
    } catch {
      // best effort metadata
    }

    return {};
  }

  private async probeWithinBudget(tokenTarget: number): Promise<boolean> {
    const sample = Array(tokenTarget).fill("t").join(" ");
    try {
      await this.embedChunksFromApi([sample]);
      return true;
    } catch (error) {
      if (this.isContextLengthError(error)) return false;
      throw error;
    }
  }

  private async probeContextWindow(seed: number): Promise<number> {
    const clamp = (n: number) => Math.max(128, Math.floor(n));
    let low = 256;
    let high = clamp(seed);

    // stepped exploration (safe / low spam)
    const steps = [0.5, 0.75, 1, 1.1].map((x) => clamp(seed * x));
    for (const s of steps) {
      let ok = false;
      try {
        ok = await this.probeWithinBudget(s);
      } catch {
        continue;
      }

      if (ok) {
        low = Math.max(low, s);
        high = Math.max(high, s);
      } else {
        high = Math.min(high, s);
        break;
      }
    }

    // binary search refinement, max 5 probes
    for (let i = 0; i < 5 && high - low > 96; i++) {
      const mid = clamp((low + high) / 2);
      const ok = await this.probeWithinBudget(mid);
      if (ok) low = mid;
      else high = mid;
    }

    return clamp(low);
  }

  async calibrateRuntimeCapability(force = false): Promise<void> {
    await this.ready;

    if (!force) {
      const ageMs = Date.now() - new Date(this.capability.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 30 * 60 * 1000) return;
    }

    const metadata = await this.readEndpointMetadata();
    const seed = Math.max(256, metadata.discoveredMaxTokens || metadata.seedMaxTokens || this.capability.seedMaxTokens);

    let discovered = this.capability.discoveredMaxTokens;
    try {
      discovered = await this.probeContextWindow(seed);
    } catch (error: any) {
      this.logger.warn(`[Embedding] calibration probe skipped: ${error.message}`);
    }

    this.capability = {
      ...this.capability,
      discoveredMaxTokens: Math.max(128, discovered || seed),
      vectorDim: metadata.vectorDim || this.capability.vectorDim,
      updatedAt: new Date().toISOString(),
      source: "probe",
    };

    await this.registry.set(this.modelKey, this.capability);

    this.logger.info(
      `[Embedding] calibrated capability modelKey=${this.modelKey} maxTokens=${this.capability.discoveredMaxTokens} vectorDim=${this.capability.vectorDim}`
    );
  }

  async getVectorDimensionHint(): Promise<number> {
    await this.ready;
    return this.capability.vectorDim || this.config.dimensions;
  }

  async getModelKey(): Promise<string> {
    await this.ready;
    return this.modelKey;
  }

  /**
   * Backward-compatible method
   */
  async embed(text: string | string[]): Promise<number[]> {
    const result = await this.embedDetailed(text);
    return result.vector;
  }

  /**
   * New method with calibration-aware adaptive chunking + metadata
   */
  async embedDetailed(text: string | string[]): Promise<EmbeddingResult> {
    await this.ready;

    const normalizedInput = this.normalizeInput(text);

    if (normalizedInput.length === 0) {
      this.logger.warn("[Embedding] Skip API call: empty input after trim/filter");
      return {
        vector: this.embedFromHash(""),
        metadata: {
          embedding_chunked: false,
          embedding_chunks_count: 0,
          embedding_chunking_strategy: "array_batch_weighted_avg",
          embedding_model: this.config.model,
          embedding_model_key: this.modelKey,
          embedding_provider: this.provider,
          embedding_max_tokens: this.capability.discoveredMaxTokens,
          embedding_safe_chunk_tokens: this.tokenBudget(),
          embedding_source: this.capability.source,
          embedding_fallback_hash: true,
        },
      };
    }

    const mergedText = normalizedInput.join("\n\n");
    const baseBudget = this.tokenBudget();

    // retry policy with progressive budget reduction
    const safetyMultipliers = [1, 0.8, 0.65, 0.5, 0.4, 0.3];

    for (const mul of safetyMultipliers) {
      const safeChunkTokens = Math.max(128, Math.floor(baseBudget * mul));
      const chunks = this.chunkTextByTokenBudget(mergedText, safeChunkTokens);
      const chunkWeights = chunks.map((c) => this.estimateTokens(c));

      // hard guard: never send chunk above discovered budget
      if (chunks.some((chunk) => this.estimateTokens(chunk) > safeChunkTokens + 2)) {
        continue;
      }

      try {
        const vectors = await this.embedChunksFromApi(chunks);

        const vector = vectors.length === 1
          ? this.l2Normalize(vectors[0])
          : this.weightedAverage(vectors, chunkWeights);

        return {
          vector,
          metadata: {
            embedding_chunked: chunks.length > 1,
            embedding_chunks_count: chunks.length,
            embedding_chunking_strategy: "array_batch_weighted_avg",
            embedding_model: this.config.model,
            embedding_model_key: this.modelKey,
            embedding_provider: this.provider,
            embedding_max_tokens: this.capability.discoveredMaxTokens,
            embedding_safe_chunk_tokens: safeChunkTokens,
            embedding_source: this.capability.source,
            embedding_fallback_hash: false,
          },
        };
      } catch (error: any) {
        if (this.isContextLengthError(error)) {
          await this.updateCapabilityFromContextError(error);
          this.logger.warn(
            `[Embedding] context-length detected. retry with smaller chunk budget=${safeChunkTokens} modelKey=${this.modelKey}`
          );
          continue;
        }

        // non context-length error -> fallback hash immediately
        this.logger.error(`[Embedding][HIGH] API failed; fallback to hash embedding. reason=${error.message} modelKey=${this.modelKey}`);
        return {
          vector: this.embedFromHash(mergedText),
          metadata: {
            embedding_chunked: chunks.length > 1,
            embedding_chunks_count: chunks.length,
            embedding_chunking_strategy: "array_batch_weighted_avg",
            embedding_model: this.config.model,
            embedding_model_key: this.modelKey,
            embedding_provider: this.provider,
            embedding_max_tokens: this.capability.discoveredMaxTokens,
            embedding_safe_chunk_tokens: safeChunkTokens,
            embedding_source: this.capability.source,
            embedding_fallback_hash: true,
          },
        };
      }
    }

    // exhausted retries
    this.logger.error(`[Embedding][CRITICAL] exhausted context retries; fallback hash modelKey=${this.modelKey}`);
    return {
      vector: this.embedFromHash(mergedText),
      metadata: {
        embedding_chunked: true,
        embedding_chunks_count: Math.max(1, this.chunkTextByTokenBudget(mergedText, Math.max(128, Math.floor(baseBudget * 0.3))).length),
        embedding_chunking_strategy: "array_batch_weighted_avg",
        embedding_model: this.config.model,
        embedding_model_key: this.modelKey,
        embedding_provider: this.provider,
        embedding_max_tokens: this.capability.discoveredMaxTokens,
        embedding_safe_chunk_tokens: Math.max(128, Math.floor(baseBudget * 0.3)),
        embedding_source: this.capability.source,
        embedding_fallback_hash: true,
      },
    };
  }

  private async embedChunksFromApi(chunks: string[]): Promise<number[][]> {
    if (chunks.length === 0) {
      throw new Error("No chunks to embed");
    }

    const endpoints = this.resolveEmbeddingEndpoints(this.config.embeddingApiUrl);
    let lastError: Error | null = null;

    for (const url of endpoints) {
      const useOpenAiFormat = /\/v1\/embeddings\/?$/i.test(url);

      try {
        this.activeEndpoint = url;
        this.provider = this.detectProvider(url);
        this.modelKey = this.buildModelKey(this.provider, this.activeEndpoint);

        if (!useOpenAiFormat && chunks.length > 1) {
          // Ollama /api/embeddings: sequential requests
          const vectors: number[][] = [];
          for (const c of chunks) {
            vectors.push(await this.embedSingle(url, false, c));
          }
          return vectors;
        }

        const vectors = await this.embedBatch(url, useOpenAiFormat, chunks);
        if (vectors.length !== chunks.length) {
          throw new Error(`Embedding vector count mismatch: expected=${chunks.length}, got=${vectors.length}`);
        }
        return vectors;
      } catch (error: any) {
        lastError = error;

        if (this.isContextLengthError(error)) {
          throw error;
        }

        if (
          error instanceof EmbeddingHttpError &&
          [404, 429].includes(error.status) &&
          endpoints.length > 1 &&
          url !== endpoints[endpoints.length - 1]
        ) {
          continue;
        }

        if (url !== endpoints[endpoints.length - 1]) {
          continue;
        }
      }
    }

    throw lastError || new Error("Embedding API error: no endpoint succeeded");
  }

  private async embedBatch(url: string, useOpenAiFormat: boolean, chunks: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const max429Retries = 3;
      for (let attempt = 0; attempt <= max429Retries; attempt++) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            useOpenAiFormat
              ? { model: this.config.model, input: chunks }
              : { model: this.config.model, prompt: chunks[0] }
          ),
          signal: controller.signal,
        });

        if (response.status === 429 && attempt < max429Retries) {
          const backoffMs = Math.min(4000, 300 * Math.pow(2, attempt));
          this.logger.warn(`[Embedding] 429 rate limit. retry in ${backoffMs}ms (attempt ${attempt + 1}/${max429Retries})`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          const preview = errorText.substring(0, 500);
          throw new EmbeddingHttpError(response.status, preview);
        }

        const data = await response.json();

        if (!useOpenAiFormat) {
          if (data.embedding && Array.isArray(data.embedding)) {
            return [data.embedding];
          }
          throw new Error("Invalid Ollama embedding response format");
        }

        if (Array.isArray(data.data)) {
          const vectors = data.data
            .map((d: any) => d?.embedding)
            .filter((v: any) => Array.isArray(v));
          if (vectors.length > 0) return vectors;
        }

        throw new Error("Invalid OpenAI embedding response format");
      }

      throw new Error("Embedding API 429 retries exhausted");
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error("Embedding request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async embedSingle(url: string, useOpenAiFormat: boolean, chunk: string): Promise<number[]> {
    const vectors = await this.embedBatch(url, useOpenAiFormat, [chunk]);
    if (!vectors[0]) throw new Error("No embedding vector returned");
    return vectors[0];
  }

  /**
   * Fallback: Generate embedding from text hash (deterministic)
   */
  private embedFromHash(text: string): number[] {
    const hash = text.split("").reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);

    const embedding: number[] = [];
    for (let i = 0; i < this.config.dimensions; i++) {
      embedding.push(Math.sin(hash + i) * 0.1);
    }
    return this.l2Normalize(embedding);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Vector dimensions mismatch");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
