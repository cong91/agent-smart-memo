import { MemoryConfig } from "../types.js";

export interface EmbeddingMetadata {
  embedding_chunked: boolean;
  embedding_chunks_count: number;
  embedding_chunking_strategy: "array_batch_weighted_avg";
  embedding_model: string;
  embedding_max_tokens: number;
  embedding_safe_chunk_tokens: number;
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

/**
 * Embedding service client
 */
export class EmbeddingClient {
  private config: Pick<MemoryConfig, "embeddingApiUrl" | "timeout"> & { model: string };
  private logger: any;
  private dimensions: number;

  // conservative model context windows
  private readonly modelMaxTokens: Record<string, number> = {
    "text-embedding-3-small": 8192,
    "text-embedding-3-large": 8192,
    "qwen3-embedding:0.6b": 8192,
  };

  constructor(config: { embeddingApiUrl?: string; timeout?: number; dimensions?: number; model?: string }, logger?: any) {
    this.config = {
      embeddingApiUrl: config.embeddingApiUrl || "http://localhost:11434",
      timeout: config.timeout || 30000,
      model: config.model || "qwen3-embedding:0.6b",
    };
    this.logger = logger || console;
    this.dimensions = config.dimensions || 1024;
  }

  private resolveEmbeddingEndpoints(rawBaseUrl: string): string[] {
    const base = (rawBaseUrl || "").trim();
    const normalizedBase = (base || "http://localhost:11434").replace(/\/+$/, "");

    if (/(\/v1\/embeddings|\/api\/embeddings)\/?$/i.test(normalizedBase)) {
      return [normalizedBase];
    }

    return [`${normalizedBase}/v1/embeddings`, `${normalizedBase}/api/embeddings`];
  }

  private isOpenAIEmbeddingEndpoint(url: string): boolean {
    return /\/v1\/embeddings\/?$/i.test(url);
  }

  private getModelMaxTokens(): number {
    return this.modelMaxTokens[this.config.model] || 4096;
  }

  private getSafeChunkTokens(maxTokens: number): number {
    return Math.max(256, Math.min(6000, Math.floor(maxTokens * 0.73)));
  }

  // Conservative estimate: use the higher of whitespace token count and char-based heuristic
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

  private chunkTextBySafeTokens(text: string, safeChunkTokens: number): string[] {
    const maxChars = Math.max(1, safeChunkTokens * 4);
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const remaining = text.length - cursor;
      if (remaining <= maxChars) {
        chunks.push(text.slice(cursor).trim());
        break;
      }

      let end = cursor + maxChars;
      const window = text.slice(cursor, end);
      const lastBreak = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      if (lastBreak > Math.floor(maxChars * 0.5)) {
        end = cursor + lastBreak;
      }

      const chunk = text.slice(cursor, end).trim();
      if (chunk.length > 0) chunks.push(chunk);
      cursor = Math.max(end, cursor + 1);
    }

    return chunks.filter((c) => c.length > 0);
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

  /**
   * Backward-compatible method
   */
  async embed(text: string | string[]): Promise<number[]> {
    const result = await this.embedDetailed(text);
    return result.vector;
  }

  /**
   * New method with chunking + metadata
   */
  async embedDetailed(text: string | string[]): Promise<EmbeddingResult> {
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
          embedding_max_tokens: this.getModelMaxTokens(),
          embedding_safe_chunk_tokens: this.getSafeChunkTokens(this.getModelMaxTokens()),
        },
      };
    }

    const mergedText = normalizedInput.join("\n\n");
    const maxTokens = this.getModelMaxTokens();

    // Retry by shrinking chunk size for 400 context-length failures
    const baseSafeChunkTokens = this.getSafeChunkTokens(maxTokens);
    const safetyMultipliers = [1, 0.8, 0.65, 0.5, 0.4, 0.3];

    for (const mul of safetyMultipliers) {
      const safeChunkTokens = Math.max(256, Math.floor(baseSafeChunkTokens * mul));
      const chunks = this.chunkTextBySafeTokens(mergedText, safeChunkTokens);
      const chunkWeights = chunks.map((c) => this.estimateTokens(c));

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
            embedding_max_tokens: maxTokens,
            embedding_safe_chunk_tokens: safeChunkTokens,
          },
        };
      } catch (error: any) {
        const isContextLength400 =
          error instanceof EmbeddingHttpError &&
          error.status === 400 &&
          /context length|maximum context|too many tokens|exceed/i.test(error.bodyPreview || "");

        if (isContextLength400) {
          this.logger.warn(
            `[Embedding] 400 context-length detected. Retry with smaller chunk size (safeChunkTokens=${safeChunkTokens})`
          );
          continue;
        }

        // non context-length error -> fallback hash immediately
        this.logger.warn(`[Embedding] API failed, fallback to hash embedding: ${error.message}`);
        return {
          vector: this.embedFromHash(mergedText),
          metadata: {
            embedding_chunked: chunks.length > 1,
            embedding_chunks_count: chunks.length,
            embedding_chunking_strategy: "array_batch_weighted_avg",
            embedding_model: this.config.model,
            embedding_max_tokens: maxTokens,
            embedding_safe_chunk_tokens: safeChunkTokens,
          },
        };
      }
    }

    // Exhausted shrink retries -> fallback hash
    this.logger.warn("[Embedding] Exhausted context-length retries, fallback to hash embedding");
    return {
      vector: this.embedFromHash(mergedText),
      metadata: {
        embedding_chunked: true,
        embedding_chunks_count: Math.max(1, this.chunkTextBySafeTokens(mergedText, this.getSafeChunkTokens(maxTokens)).length),
        embedding_chunking_strategy: "array_batch_weighted_avg",
        embedding_model: this.config.model,
        embedding_max_tokens: maxTokens,
        embedding_safe_chunk_tokens: this.getSafeChunkTokens(maxTokens),
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
      const useOpenAiFormat = this.isOpenAIEmbeddingEndpoint(url);

      try {
        if (process.env.EMBEDDING_DEBUG === "1") {
          this.logger.debug?.(
            `[Embedding] API request schema: ${JSON.stringify({
              endpoint: url,
              model: this.config.model,
              chunksCount: chunks.length,
              firstChunkChars: chunks[0]?.length || 0,
              firstChunkTokensEst: this.estimateTokens(chunks[0] || ""),
              format: useOpenAiFormat ? "openai" : "ollama",
            })}`
          );
        }

        if (!useOpenAiFormat && chunks.length > 1) {
          // Ollama /api/embeddings: no array batch support in one call (do sequential fallback)
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

        const isContextLength400 =
          error instanceof EmbeddingHttpError &&
          error.status === 400 &&
          /context length|maximum context|too many tokens|exceed|8192|token/i.test(
            error.bodyPreview || ""
          );

        if (isContextLength400) {
          // Let outer adaptive-shrink retry handle this immediately.
          throw error;
        }

        if (
          error instanceof EmbeddingHttpError &&
          error.status === 404 &&
          endpoints.length > 1 &&
          url !== endpoints[endpoints.length - 1]
        ) {
          continue;
        }
        if (
          error instanceof EmbeddingHttpError &&
          error.status === 429
        ) {
          // endpoint is rate-limited; try next endpoint if any
          continue;
        }
        // for other errors we still may try next endpoint
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
      // 429 retry/backoff
      const max429Retries = 4;
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
          const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt));
          this.logger.warn(`[Embedding] 429 rate limit. Retry in ${backoffMs}ms (attempt ${attempt + 1}/${max429Retries})`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          const preview = errorText.substring(0, 300);
          this.logger.error(`[Embedding] HTTP ${response.status} @ ${url}: ${preview}`);
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
    for (let i = 0; i < this.dimensions; i++) {
      embedding.push(Math.sin(hash + i) * 0.1);
    }
    return this.l2Normalize(embedding);
  }

  /**
   * Calculate cosine similarity
   */
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
