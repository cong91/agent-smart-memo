/**
 * Essence-Distiller Schema Foundation
 * Prepares API contracts for future Essence-Distiller skill
 */

export interface EssenceDocument {
  id: string;
  sourceType: "chat" | "document" | "code" | "config";
  sourceRef: string;  // session ID, file path, etc.
  rawContent: string;
  extractedAt: number;
}

export interface ExtractionResult {
  facts: Array<{
    text: string;
    confidence: number;
    category: "decision" | "learning" | "config" | "rule" | "context";
    namespace: string;
  }>;
  entities: Array<{
    name: string;
    type: string;
    attributes: Record<string, unknown>;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    type: string;
  }>;
}

export interface DistillationConfig {
  llmModel: string;
  minConfidence: number;
  maxFacts: number;
  targetNamespaces: string[];
  deduplication: boolean;
}

export interface DistillationPipeline {
  id: string;
  name: string;
  config: DistillationConfig;
  schedule?: string;  // cron expression
  sources: Array<{
    type: "session" | "file" | "webhook";
    filter: Record<string, unknown>;
  }>;
}
