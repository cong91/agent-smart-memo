import { MemoryConfig } from "./types";

export function loadConfig(api: any): MemoryConfig {
  const pluginConfig = api.config?.plugins?.entries?.["memory-qdrant"]?.config || {};
  
  const config: MemoryConfig = {
    qdrantUrl: String(pluginConfig.qdrantUrl || "http://localhost:6333"),
    collectionName: String(pluginConfig.collectionName || "mrc_bot_memory"),
    vectorSize: Number(pluginConfig.vectorSize) || 768,
    embeddingApiUrl: String(pluginConfig.embeddingApiUrl || "http://localhost:8898"),
    timeout: Number(pluginConfig.timeout) || 10000,
    maxRetries: Number(pluginConfig.maxRetries) || 3,
    defaultNamespace: String(pluginConfig.defaultNamespace || "default"),
    similarityThreshold: Number(pluginConfig.similarityThreshold) || 0.95,
  };
  
  // Validate
  if (config.vectorSize < 1 || config.vectorSize > 4096) {
    api.logger.warn("[Memory] vectorSize out of range, using default 768");
    config.vectorSize = 768;
  }
  
  if (config.similarityThreshold < 0 || config.similarityThreshold > 1) {
    api.logger.warn("[Memory] similarityThreshold out of range, using default 0.95");
    config.similarityThreshold = 0.95;
  }
  
  api.logger.info(`[Memory] Config: ${config.qdrantUrl}/${config.collectionName}`);
  return config;
}
