import { MemoryConfig } from "../types.js";

/**
 * Embedding service client - Ollama compatible
 */
export class EmbeddingClient {
  private config: Pick<MemoryConfig, "embeddingApiUrl" | "timeout"> & { model: string };
  private logger: any;
  private dimensions: number;

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

    // If already a full embeddings path, use directly.
    if (/(\/v1\/embeddings|\/api\/embeddings)\/?$/i.test(normalizedBase)) {
      return [normalizedBase];
    }

    // Smart handling for base URL only:
    // 1) Prefer OpenAI-compatible /v1/embeddings (for proxypal/openai-like services)
    // 2) Fallback to Ollama /api/embeddings (for backward compatibility)
    return [`${normalizedBase}/v1/embeddings`, `${normalizedBase}/api/embeddings`];
  }

  private isOpenAIEmbeddingEndpoint(url: string): boolean {
    return /\/v1\/embeddings\/?$/i.test(url);
  }
  
  /**
   * Get embedding vector for text
   * Fallback to hash-based embedding if API unavailable
   */
  async embed(text: string): Promise<number[]> {
    // Try API first
    try {
      return await this.embedFromApi(text);
    } catch (error) {
      // Fallback to deterministic hash-based embedding
      return this.embedFromHash(text);
    }
  }
  
  /**
   * Get embedding from API
   */
  private async embedFromApi(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const endpoints = this.resolveEmbeddingEndpoints(this.config.embeddingApiUrl);
      let lastError: Error | null = null;

      for (const url of endpoints) {
        const useOpenAiFormat = this.isOpenAIEmbeddingEndpoint(url);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            useOpenAiFormat
              ? {
                  model: this.config.model,
                  input: text,
                }
              : {
                  model: this.config.model,
                  prompt: text,
                }
          ),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          this.logger.error(`[Embedding] HTTP ${response.status} @ ${url}: ${errorText.substring(0, 200)}`);

          // If this endpoint not found and we still have fallback endpoint, continue.
          if (response.status === 404 && endpoints.length > 1 && url !== endpoints[endpoints.length - 1]) {
            continue;
          }

          lastError = new Error(`Embedding API error: ${response.status}`);
          break;
        }

        const data = await response.json();

        // Ollama API format: { embedding: [...] }
        if (data.embedding && Array.isArray(data.embedding)) {
          clearTimeout(timeoutId);
          return data.embedding;
        }

        // OpenAI-compatible format: { data: [{ embedding: [...] }] }
        if (Array.isArray(data.data) && data.data[0]?.embedding && Array.isArray(data.data[0].embedding)) {
          clearTimeout(timeoutId);
          return data.data[0].embedding;
        }

        this.logger.error(`[Embedding] Unexpected response format: ${JSON.stringify(data).substring(0, 200)}`);
        lastError = new Error("Invalid embedding response format");
        break;
      }

      clearTimeout(timeoutId);
      throw lastError || new Error("Embedding API error: no endpoint succeeded");
      
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error("Embedding request timed out");
      }
      throw error;
    }
  }
  
  /**
   * Fallback: Generate embedding from text hash (deterministic)
   */
  private embedFromHash(text: string): number[] {
    const hash = text.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    
    const embedding: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      embedding.push(Math.sin(hash + i) * 0.1);
    }
    return embedding;
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
