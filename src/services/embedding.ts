import { MemoryConfig } from "../types";

/**
 * Embedding service client - Local embedding service compatible
 */
export class EmbeddingClient {
  private config: MemoryConfig;
  private logger: any;
  
  constructor(config: MemoryConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }
  
  /**
   * Get embedding vector for text using local embedding service
   */
  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
    
    try {
      // Local embedding service endpoint
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
