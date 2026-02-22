import { MemoryConfig } from "../types.js";

/**
 * Embedding service client - Local embedding service compatible
 */
export class EmbeddingClient {
  private config: Pick<MemoryConfig, "embeddingApiUrl" | "timeout">;
  private logger: any;
  private dimensions: number;
  
  constructor(config: { embeddingApiUrl?: string; timeout?: number; dimensions?: number; model?: string }, logger?: any) {
    this.config = {
      embeddingApiUrl: config.embeddingApiUrl || "http://localhost:8000",
      timeout: config.timeout || 30000,
    };
    this.logger = logger || console;
    this.dimensions = config.dimensions || 1024;
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
      const url = `${this.config.embeddingApiUrl}/embed`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        this.logger.error(`[Embedding] HTTP ${response.status}: ${errorText.substring(0, 200)}`);
        throw new Error(`Embedding API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Local embedding service format: {embedding: [...], vector_size: 768, model: "..."}
      if (data.embedding && Array.isArray(data.embedding)) {
        return data.embedding;
      }
      
      this.logger.error(`[Embedding] Unexpected response format: ${JSON.stringify(data).substring(0, 200)}`);
      throw new Error("Invalid embedding response format");
      
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
