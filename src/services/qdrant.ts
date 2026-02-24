import { MemoryConfig, Point, SearchResponse, ScoredPoint } from "../types.js";

interface QdrantConfig {
  host: string;
  port: number;
  collection: string;
  vectorSize: number;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Qdrant client with retry logic
 */
export class QdrantClient {
  private config: Required<QdrantConfig>;
  private logger: any;
  
  constructor(config: QdrantConfig, logger?: any) {
    this.config = {
      host: config.host,
      port: config.port,
      collection: config.collection,
      vectorSize: config.vectorSize,
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
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
    const url = `http://${this.config.host}:${this.config.port}${path}`;
    
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
      await this.request(`/collections/${this.config.collection}`, { method: "GET" });
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
      this.logger.info(`[Qdrant] Collection ${this.config.collection} already exists`);
      return;
    }
    
    this.logger.info(`[Qdrant] Creating collection ${this.config.collection}`);
    
    await this.request(`/collections/${this.config.collection}`, {
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
    
    // Create payload indexes for memory isolation
    await this.createPayloadIndex("namespace", "keyword");
    await this.createPayloadIndex("source_agent", "keyword");
    await this.createPayloadIndex("source_type", "keyword");
    await this.createPayloadIndex("userId", "keyword");
  }
  
  /**
   * Create payload index for efficient filtering
   */
  async createPayloadIndex(fieldName: string, fieldType: "keyword" | "integer" | "float" | "bool"): Promise<void> {
    try {
      await this.request(`/collections/${this.config.collection}/index`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldType,
        }),
      });
      this.logger.info(`[Qdrant] Created payload index: ${fieldName}`);
    } catch (error: any) {
      // Index may already exist, log but don't fail
      this.logger.warn(`[Qdrant] Failed to create index ${fieldName}: ${error.message}`);
    }
  }
  
  /**
   * Upsert points
   */
  async upsert(points: Point[]): Promise<void> {
    await this.request(`/collections/${this.config.collection}/points`, {
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
      `/collections/${this.config.collection}/points/search`,
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
    await this.request(`/collections/${this.config.collection}/points/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
    });
  }
}
