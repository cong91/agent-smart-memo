import { MemoryConfig, Point, SearchResponse, ScoredPoint } from "../types";

/**
 * Qdrant client with retry logic
 */
export class QdrantClient {
  private config: MemoryConfig;
  private logger: any;
  
  constructor(config: Partial<MemoryConfig> & { host: string; port: number; collection: string }, logger?: any) {
    this.config = {
      qdrantUrl: `http://${config.host}:${config.port}`,
      collection: config.collection,
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      ...config,
    };
    this.logger = logger || console;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Make request with retry
   */
  private async request(
    path: string,
    options: RequestInit,
    attempt: number = 1
  ): Promise<any> {
    const url = `${this.config.qdrantUrl}${path}`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      
      // Some endpoints return empty body
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return await response.json();
      }
      return null;
      
    } catch (error: any) {
      if (attempt < this.config.maxRetries && this.isRetryableError(error)) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        this.logger.warn(`[Qdrant] Retry ${attempt} after ${delay}ms: ${error.message}`);
        await this.sleep(delay);
        return this.request(path, options, attempt + 1);
      }
      throw error;
    }
  }
  
  private isRetryableError(error: any): boolean {
    return error.message.includes("timeout") ||
           error.message.includes("network") ||
           error.message.includes("ECONNREFUSED") ||
           error.name === "AbortError";
  }
  
  /**
   * Check if collection exists
   */
  async collectionExists(): Promise<boolean> {
    try {
      await this.request(`/collections/${this.config.collectionName}`, { method: "GET" });
      return true;
    } catch (error: any) {
      if (error.message.includes("404")) {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Create collection if not exists
   */
  async createCollection(): Promise<void> {
    const exists = await this.collectionExists();
    if (exists) {
      this.logger.info(`[Qdrant] Collection ${this.config.collectionName} already exists`);
      return;
    }
    
    this.logger.info(`[Qdrant] Creating collection ${this.config.collectionName}`);
    
    await this.request(`/collections/${this.config.collectionName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: this.config.vectorSize,
          distance: "Cosine",
        },
        optimizers_config: {
          default_segment_number: 2,
        },
      }),
    });
    
    this.logger.info(`[Qdrant] Collection created successfully`);
  }
  
  /**
   * Upsert points
   */
  async upsert(points: Point[]): Promise<void> {
    await this.request(`/collections/${this.config.collectionName}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    });
  }
  
  /**
   * Search similar vectors
   */
  async search(
    vector: number[],
    limit: number = 5,
    filter?: Record<string, any>
  ): Promise<ScoredPoint[]> {
    const body: any = {
      vector,
      limit,
      with_payload: true,
      with_vector: false,
    };
    
    if (filter) {
      body.filter = filter;
    }
    
    const response: SearchResponse = await this.request(
      `/collections/${this.config.collectionName}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    
    return response.result || [];
  }
  
  /**
   * Delete points by filter
   */
  async deleteByFilter(filter: Record<string, any>): Promise<void> {
    await this.request(`/collections/${this.config.collectionName}/points/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
    });
  }
}
