import { ScoredPoint } from "../types.js";

/**
 * Deduplication utilities
 */
export class DeduplicationService {
  private similarityThreshold: number;
  private logger: any;
  
  constructor(similarityThreshold: number, logger: any) {
    this.similarityThreshold = similarityThreshold;
    this.logger = logger;
  }
  
  /**
   * Check if new text is duplicate of existing memories
   * Returns existing memory ID if duplicate found, null otherwise
   */
  findDuplicate(newText: string, candidates: ScoredPoint[]): string | null {
    for (const candidate of candidates) {
      if (candidate.score >= this.similarityThreshold) {
        this.logger.debug(`[Dedupe] Found duplicate with score ${candidate.score.toFixed(3)}`);
        return candidate.id;
      }
    }
    return null;
  }
  
  /**
   * Normalize text for comparison
   */
  normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }
  
  /**
   * Calculate simple text similarity (Jaccard)
   */
  textSimilarity(a: string, b: string): number {
    const normA = this.normalizeText(a);
    const normB = this.normalizeText(b);
    
    if (normA === normB) return 1.0;
    
    const wordsA = new Set(normA.split(" "));
    const wordsB = new Set(normB.split(" "));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return intersection.size / union.size;
  }
}
