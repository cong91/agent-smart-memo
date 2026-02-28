/**
 * Data Migration Script: Namespace Standardization
 * 
 * Fixes namespace values in Qdrant collection:
 * - "default" → "agent_decisions"
 * - "trader" → "trading_signals"
 * - "fullstack" → "project_context"
 * - null/undefined → "agent_decisions"
 * 
 * Usage: npx tsx scripts/migrate-namespaces.ts
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "mrc_bot_memory";
const BATCH_SIZE = 100;

interface QdrantPoint {
  id: string;
  payload: Record<string, any>;
  vector?: number[];
}

interface ScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | number | null;
  };
  status?: string;
}

const NAMESPACE_MAPPING: Record<string, string> = {
  "default": "agent_decisions",
  "trader": "trading_signals",
  "fullstack": "project_context",
};

function getFixedNamespace(current: string | null | undefined): string | null {
  // Handle null/undefined/empty
  if (!current || current === "" || current === "null") {
    return "agent_decisions";
  }
  
  // Check direct mapping
  if (current in NAMESPACE_MAPPING) {
    return NAMESPACE_MAPPING[current];
  }
  
  // Already valid - no change needed
  const validNamespaces = ["agent_decisions", "user_profile", "project_context", "trading_signals", "agent_learnings", "system_rules"];
  if (validNamespaces.includes(current)) {
    return null; // No change needed
  }
  
  // Unknown namespace - default to agent_decisions
  console.log(`[WARN] Unknown namespace "${current}" for point, defaulting to agent_decisions`);
  return "agent_decisions";
}

async function scrollPoints(offset?: string | number | null): Promise<ScrollResponse> {
  const url = new URL(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`);
  
  const body: any = {
    limit: BATCH_SIZE,
    with_payload: true,
    with_vector: true,
  };
  
  if (offset !== undefined && offset !== null) {
    body.offset = offset;
  }
  
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    throw new Error(`Qdrant scroll failed: ${response.status} ${await response.text()}`);
  }
  
  return response.json();
}

async function updatePoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return;
  
  const url = new URL(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points?wait=true`);
  
  const response = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      points: points.map(p => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Qdrant update failed: ${response.status} ${await response.text()}`);
  }
}

async function getCollectionInfo(): Promise<any> {
  const url = new URL(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
  const response = await fetch(url.toString());
  
  if (!response.ok) {
    throw new Error(`Failed to get collection info: ${response.status}`);
  }
  
  return response.json();
}

async function main() {
  console.log("=".repeat(60));
  console.log("Namespace Migration Script v2");
  console.log("=".repeat(60));
  console.log(`Qdrant URL: ${QDRANT_URL}`);
  console.log(`Collection: ${COLLECTION_NAME}`);
  console.log("");
  
  // Check collection exists
  try {
    const info = await getCollectionInfo();
    const pointsCount = info.result?.points_count || 0;
    console.log(`Collection exists with ${pointsCount} points`);
    console.log("");
  } catch (error: any) {
    console.error(`Failed to connect to Qdrant: ${error.message}`);
    process.exit(1);
  }
  
  let offset: string | number | null = null;
  let totalProcessed = 0;
  let totalChanged = 0;
  let totalErrors = 0;
  const changesByType: Record<string, number> = {};
  
  console.log("Starting migration...");
  console.log("-".repeat(60));
  
  do {
    try {
      const response = await scrollPoints(offset);
      const points = response.result?.points || [];
      
      if (points.length === 0) {
        break;
      }
      
      const pointsToUpdate: QdrantPoint[] = [];
      
      for (const point of points) {
        totalProcessed++;
        const currentNs = point.payload?.namespace;
        const fixedNs = getFixedNamespace(currentNs);
        
        if (fixedNs !== null) {
          // Track change type
          const changeKey = `"${currentNs}" → "${fixedNs}"`;
          changesByType[changeKey] = (changesByType[changeKey] || 0) + 1;
          
          // Update payload
          point.payload = {
            ...point.payload,
            namespace: fixedNs,
            _migrated_at: Date.now(),
            _original_namespace: currentNs || null,
          };
          
          pointsToUpdate.push(point);
          totalChanged++;
          
          if (totalChanged % 100 === 0) {
            console.log(`  Progress: ${totalProcessed} processed, ${totalChanged} changed...`);
          }
        }
      }
      
      // Batch update points that need changes
      if (pointsToUpdate.length > 0) {
        try {
          await updatePoints(pointsToUpdate);
          console.log(`  Updated batch of ${pointsToUpdate.length} points`);
        } catch (error: any) {
          console.error(`  Failed to update batch: ${error.message}`);
          totalErrors += pointsToUpdate.length;
        }
      }
      
      offset = response.result?.next_page_offset;
      
      // Safety: if no more offset, we're done
      if (offset === null || offset === undefined) {
        break;
      }
      
    } catch (error: any) {
      console.error(`Error during scroll: ${error.message}`);
      totalErrors += BATCH_SIZE;
      break;
    }
  } while (offset !== null && offset !== undefined);
  
  console.log("-".repeat(60));
  console.log("Migration Complete!");
  console.log("=".repeat(60));
  console.log(`Total points processed: ${totalProcessed}`);
  console.log(`Total points changed:   ${totalChanged}`);
  console.log(`Total errors:           ${totalErrors}`);
  console.log("");
  
  if (Object.keys(changesByType).length > 0) {
    console.log("Changes by type:");
    for (const [changeType, count] of Object.entries(changesByType)) {
      console.log(`  ${changeType}: ${count}`);
    }
  }
  
  console.log("");
  console.log("✅ Migration finished successfully!");
  console.log("   This script is idempotent - safe to re-run if needed.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
