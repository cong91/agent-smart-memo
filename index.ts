import { loadConfig } from "./src/config";
import { QdrantClient } from "./src/services/qdrant";
import { EmbeddingClient } from "./src/services/embedding";
import { DeduplicationService } from "./src/services/dedupe";
import { createMemoryStoreTool } from "./src/tools/memory_store";
import { createMemorySearchTool } from "./src/tools/memory_search";

/**
 * Qdrant Memory Plugin for OpenClaw
 * 
 * Features:
 * - Vector-based semantic memory storage
 * - Automatic deduplication
 * - Namespace/session/user filtering
 * - Configurable similarity threshold
 * - Retry logic for resilience
 */
export default {
  id: "memory-qdrant",
  name: "Qdrant Memory Plugin",
  version: "1.0.0",
  
  async register(api: any) {
    try {
      // Load config
      const config = loadConfig(api);
      
      // Initialize services
      const qdrant = new QdrantClient(config, api.logger);
      const embedding = new EmbeddingClient(config, api.logger);
      const dedupe = new DeduplicationService(config.similarityThreshold, api.logger);
      
      // Ensure collection exists
      await qdrant.createCollection();
      
      // Register tools
      const storeTool = createMemoryStoreTool(qdrant, embedding, dedupe, config.defaultNamespace);
      const searchTool = createMemorySearchTool(qdrant, embedding, config.defaultNamespace);
      
      api.registerTool(storeTool, { optional: false });
      api.registerTool(searchTool, { optional: false });
      
      api.logger.info("✅ [Memory-Qdrant] Plugin loaded successfully");
      api.logger.info(`   Collection: ${config.collectionName}`);
      api.logger.info(`   Vector Size: ${config.vectorSize}`);
      api.logger.info(`   Dedupe Threshold: ${config.similarityThreshold}`);
      
    } catch (error: any) {
      api.logger.error(`❌ [Memory-Qdrant] Failed to load: ${error.message}`);
      throw error;
    }
  },
};
