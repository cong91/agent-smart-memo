import "dotenv/config";

import { EmbeddingClient } from "../services/embedding.js";
import { QdrantClient } from "../services/qdrant.js";

interface ReembedStats {
  totalProcessed: number;
  chunkedCount: number;
  maxChunksSeen: number;
  failedCount: number;
  startedAt: number;
}

function sampleArray<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const copy = [...items];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

async function run(): Promise<void> {
  const qdrantHost = process.env.QDRANT_HOST || "localhost";
  const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
  const qdrantCollection = process.env.QDRANT_COLLECTION || "mrc_bot_memory";
  const embeddingApiUrl = process.env.EMBEDDING_API_URL || process.env.OLLAMA_URL || "http://localhost:4142";
  const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  let embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
  const batchSize = Math.max(1, Number(process.env.REEMBED_BATCH_SIZE || 25));

  const qdrant = new QdrantClient({
    host: qdrantHost,
    port: qdrantPort,
    collection: qdrantCollection,
    vectorSize: embeddingDimensions,
    timeout: 60000,
    maxRetries: 4,
  }, console);

  const collectionInfo = await qdrant.getCollectionInfo();
  const detectedVectorSize = Number(collectionInfo?.result?.config?.params?.vectors?.size || 0);
  if (detectedVectorSize > 0 && detectedVectorSize !== embeddingDimensions) {
    console.warn(`[Reembed] EMBEDDING_DIMENSIONS mismatch env=${embeddingDimensions} qdrant=${detectedVectorSize}. Using qdrant size.`);
    embeddingDimensions = detectedVectorSize;
  }

  const embedding = new EmbeddingClient({
    embeddingApiUrl,
    model: embeddingModel,
    dimensions: embeddingDimensions,
    timeout: 120000,
  }, console);

  const stats: ReembedStats = {
    totalProcessed: 0,
    chunkedCount: 0,
    maxChunksSeen: 0,
    failedCount: 0,
    startedAt: Date.now(),
  };

  console.log(`[Reembed] Start collection=${qdrantCollection} host=${qdrantHost}:${qdrantPort} model=${embeddingModel} dims=${embeddingDimensions}`);

  const pointsBefore = await qdrant.countPoints(true);
  console.log(`[Reembed] points_before=${pointsBefore}`);

  const processedIds: any[] = [];
  let offset: any = undefined;

  while (true) {
    const page = await qdrant.scroll(batchSize, offset, false);
    if (page.points.length === 0) break;

    const fallbackUpsertPoints: Array<{ id: string; vector: number[]; payload: Record<string, any> }> = [];
    const vectorUpdates: Array<{ id: string; vector: number[] }> = [];

    for (const point of page.points) {
      const payload = point.payload || {};
      const text = typeof payload.text === "string" ? payload.text.trim() : "";

      if (!text) {
        stats.failedCount += 1;
        console.warn(`[Reembed] Skip id=${point.id}: empty text`);
        continue;
      }

      try {
        const embedded = await embedding.embedDetailed(text);
        const mergedPayload = {
          ...payload,
          ...embedded.metadata,
          metadata: {
            ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
            ...embedded.metadata,
          },
        };

        vectorUpdates.push({ id: point.id, vector: embedded.vector });
        fallbackUpsertPoints.push({ id: point.id, vector: embedded.vector, payload: mergedPayload });
        processedIds.push(point.id);

        stats.totalProcessed += 1;
        if (embedded.metadata.embedding_chunked) stats.chunkedCount += 1;
        if (embedded.metadata.embedding_chunks_count > stats.maxChunksSeen) {
          stats.maxChunksSeen = embedded.metadata.embedding_chunks_count;
        }
      } catch (error: any) {
        stats.failedCount += 1;
        console.error(`[Reembed] Failed id=${point.id}: ${error.message}`);
      }
    }

    if (vectorUpdates.length > 0) {
      let usedFallbackUpsert = false;
      try {
        await qdrant.updateVectors(vectorUpdates);
        await qdrant.setPayload(
          fallbackUpsertPoints.map((p) => ({ id: p.id, payload: p.payload }))
        );
      } catch (_error) {
        usedFallbackUpsert = true;
        await qdrant.upsert(fallbackUpsertPoints);
      }
      console.log(
        `[Reembed] Batch done size=${page.points.length} updated=${vectorUpdates.length} mode=${usedFallbackUpsert ? "upsert_fallback" : "updateVectors+setPayload"}`
      );
    }

    offset = page.nextOffset;
    if (offset === undefined || offset === null) break;
  }

  const pointsAfter = await qdrant.countPoints(true);
  console.log(`[Reembed] points_after=${pointsAfter}`);

  if (pointsBefore !== pointsAfter) {
    throw new Error(`Point count mismatch: before=${pointsBefore}, after=${pointsAfter}`);
  }

  const verifyIds = sampleArray(processedIds, Math.min(10, processedIds.length));
  const toKey = (id: any) => JSON.stringify(id);
  let verifyChecked = 0;
  if (verifyIds.length > 0) {
    let verifyOffset: any = undefined;
    const need = new Set(verifyIds.map((id) => toKey(id)));
    while (need.size > 0) {
      const page = await qdrant.scroll(100, verifyOffset, true);
      if (page.points.length === 0) break;
      for (const p of page.points) {
        const key = toKey(p.id);
        if (need.has(key)) {
          const dim = p.vector?.length || 0;
          if (dim !== embeddingDimensions) {
            throw new Error(`Vector dim mismatch for id=${key}: expected=${embeddingDimensions}, got=${dim}`);
          }
          verifyChecked += 1;
          need.delete(key);
        }
      }
      verifyOffset = page.nextOffset;
      if (verifyOffset === undefined || verifyOffset === null) break;
    }
  }

  const smokeVector = await embedding.embed("memory search smoke test");
  const smokeResults = await qdrant.search(smokeVector, 3);
  if (!Array.isArray(smokeResults)) {
    throw new Error("Search smoke test failed: no result array");
  }

  const totalTime = Date.now() - stats.startedAt;
  console.log("[Reembed] Verification passed");
  console.log(JSON.stringify({
    collection: qdrantCollection,
    points_before: pointsBefore,
    points_after: pointsAfter,
    random_verified_vectors: verifyChecked,
    search_smoke_test: true,
    total_processed: stats.totalProcessed,
    chunked_count: stats.chunkedCount,
    max_chunks_seen: stats.maxChunksSeen,
    failed_count: stats.failedCount,
    total_time_ms: totalTime,
  }, null, 2));
}

run().catch((error) => {
  console.error(`[Reembed] Fatal: ${error.stack || error.message}`);
  process.exit(1);
});
