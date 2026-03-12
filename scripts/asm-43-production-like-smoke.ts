import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createPaperclipRuntime } from "../src/adapters/paperclip/runtime.js";
import { registerSemanticMemoryTools } from "../src/tools/semantic-memory-tools.js";
import { registerSlotTools } from "../src/tools/slot-tools.js";
import { QdrantClient } from "../src/services/qdrant.js";
import { EmbeddingClient } from "../src/services/embedding.js";
import { DeduplicationService } from "../src/services/dedupe.js";
import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any, ctx: any) => Promise<any>;
}

class MockApi {
  public tools = new Map<string, RegisteredTool>();

  registerTool(tool: any) {
    this.tools.set(tool.name, tool as RegisteredTool);
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function extractToolText(result: any): string {
  return String(result?.content?.[0]?.text || "");
}

function extractFoundCount(text: string): number {
  const match = text.match(/Found\s+(\d+)\s+relevant memories/i);
  return match?.[1] ? Number(match[1]) : 0;
}

async function deleteCollection(host: string, port: number, collection: string): Promise<void> {
  try {
    await fetch(`http://${host}:${port}/collections/${collection}`, { method: "DELETE" });
  } catch {
    // best effort cleanup only
  }
}

async function main() {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const testRoot = join(tmpdir(), `agent-memo-asm43-smoke-${runId}`);
  const paperclipStateDir = join(testRoot, "paperclip-state");
  const paperclipSlotDbDir = join(testRoot, "paperclip-slotdb");
  const openclawStateDir = join(testRoot, "openclaw-state");
  const openclawSlotDbDir = join(testRoot, "openclaw-slotdb");

  for (const dir of [paperclipStateDir, paperclipSlotDbDir, openclawStateDir, openclawSlotDbDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const qdrantHost = process.env.AGENT_MEMO_QDRANT_HOST || "localhost";
  const qdrantPort = Number(process.env.AGENT_MEMO_QDRANT_PORT || 6333);
  const qdrantCollection = `asm43_smoke_${Date.now()}`;
  const qdrantVectorSize = Number(process.env.AGENT_MEMO_QDRANT_VECTOR_SIZE || 1024);

  const embedBaseUrl = process.env.AGENT_MEMO_EMBED_BASE_URL || "http://localhost:11434";
  const embedModel = process.env.AGENT_MEMO_EMBED_MODEL || "qwen3-embedding:0.6b";
  const embedDimensions = Number(process.env.AGENT_MEMO_EMBED_DIMENSIONS || 1024);

  const evidence: Record<string, any> = {
    runId,
    startedAt: new Date().toISOString(),
    runtime: {
      qdrantHost,
      qdrantPort,
      qdrantCollection,
      qdrantVectorSize,
      embedBaseUrl,
      embedModel,
      embedDimensions,
    },
    scenarios: {},
  };

  const qdrant = new QdrantClient({
    host: qdrantHost,
    port: qdrantPort,
    collection: qdrantCollection,
    vectorSize: qdrantVectorSize,
  });

  const embedding = new EmbeddingClient({
    embeddingApiUrl: embedBaseUrl,
    model: embedModel,
    dimensions: embedDimensions,
    stateDir: paperclipStateDir,
  });

  const dedupe = new DeduplicationService(0.95, console);
  const semanticUseCase = new SemanticMemoryUseCase(qdrant, embedding, dedupe);

  try {
    console.log("\n[ASM-43] Creating isolated Qdrant collection for production-like smoke...");
    await qdrant.createCollection();

    // -----------------------------
    // Paperclip simulated caller path
    // -----------------------------
    const paperclipRuntime = createPaperclipRuntime({
      stateDir: paperclipStateDir,
      slotDbDir: paperclipSlotDbDir,
      semanticUseCase,
      qdrantHost,
      qdrantPort,
      qdrantCollection,
      qdrantVectorSize,
      embedBaseUrl,
      embedModel,
      embedDimensions,
    });

    const paperclipCtx = {
      userId: "asm43-paperclip-user",
      sessionId: `paperclip-session-${runId}`,
      workspaceId: "asm43-workspace",
      traceId: `trace-${runId}`,
    };

    const uniqueToken = `asm43-parity-${runId}`;
    const sharedNamespace = "shared.project_context";
    const memoryText = `Paperclip runtime smoke memory ${uniqueToken}`;

    console.log("[ASM-43] Scenario A - Paperclip capture/store...");
    const pCapture = await paperclipRuntime.adapter.execute({
      action: "memory.capture",
      payload: {
        text: memoryText,
        namespace: sharedNamespace,
        metadata: { source: "asm43-smoke", caller: "paperclip-simulated" },
      },
      context: paperclipCtx,
    });

    assert(pCapture.ok === true, "Paperclip memory.capture should succeed");
    assert(Boolean((pCapture.data as any)?.id), "Paperclip memory.capture should return id");

    console.log("[ASM-43] Scenario B - Paperclip search/retrieve...");
    const pSearch = await paperclipRuntime.adapter.execute({
      action: "memory.search",
      payload: {
        query: uniqueToken,
        namespace: sharedNamespace,
        minScore: 0.1,
        limit: 5,
      },
      context: paperclipCtx,
    });

    assert(pSearch.ok === true, "Paperclip memory.search should succeed");
    const pResults = ((pSearch.data as any)?.results || []) as Array<any>;
    assert(Array.isArray(pResults), "Paperclip memory.search should return results array");
    assert(pResults.length >= 1, "Paperclip memory.search should find at least one result");
    assert(pResults.some((r) => String(r.text || "").includes(uniqueToken)), "Paperclip search result should contain inserted token");

    // Paperclip slot flow (store + retrieve) for parity baseline
    const pSlotSet = await paperclipRuntime.adapter.execute({
      action: "slot.set",
      payload: {
        key: "project.asm43_smoke",
        value: uniqueToken,
        source: "manual",
      },
      context: paperclipCtx,
    });
    assert(pSlotSet.ok === true, "Paperclip slot.set should succeed");

    const pSlotGet = await paperclipRuntime.adapter.execute({
      action: "slot.get",
      payload: { key: "project.asm43_smoke" },
      context: paperclipCtx,
    });
    assert(pSlotGet.ok === true, "Paperclip slot.get should succeed");
    assert((pSlotGet.data as any)?.value === uniqueToken, "Paperclip slot.get should return stored token");

    evidence.scenarios.paperclip = {
      capture: pCapture.data,
      searchCount: pResults.length,
      topResult: pResults[0],
      slotGet: pSlotGet.data,
    };

    // -----------------------------
    // OpenClaw simulated caller path
    // -----------------------------
    const api = new MockApi();
    registerSemanticMemoryTools(api as any, {
      stateDir: openclawStateDir,
      slotDbDir: openclawSlotDbDir,
      semanticUseCaseFactory: () => semanticUseCase,
    });
    registerSlotTools(api as any, [], {
      stateDir: openclawStateDir,
      slotDbDir: openclawSlotDbDir,
      semanticUseCaseFactory: () => semanticUseCase,
    });

    const openclawCtx = {
      sessionKey: `agent:assistant:asm43-openclaw-user-${runId}`,
      stateDir: openclawStateDir,
      pluginConfig: { slotDbDir: openclawSlotDbDir },
    };

    const memoryStoreTool = api.tools.get("memory_store");
    const memorySearchTool = api.tools.get("memory_search");
    const slotSetTool = api.tools.get("memory_slot_set");
    const slotGetTool = api.tools.get("memory_slot_get");

    assert(memoryStoreTool && memorySearchTool && slotSetTool && slotGetTool, "OpenClaw tools should be registered");

    console.log("[ASM-43] Scenario C - OpenClaw parity path (capture/search + slot) ...");
    const oStore = await memoryStoreTool!.execute("1", {
      text: memoryText,
      namespace: sharedNamespace,
      sessionId: `openclaw-session-${runId}`,
      userId: "asm43-openclaw-user",
      metadata: { source: "asm43-smoke", caller: "openclaw-simulated" },
    }, openclawCtx);
    const oStoreText = extractToolText(oStore);
    assert(oStore?.isError !== true, `OpenClaw memory_store should succeed. got=${oStoreText}`);

    const oSearch = await memorySearchTool!.execute("2", {
      query: uniqueToken,
      namespace: sharedNamespace,
      minScore: 0.1,
      limit: 5,
      userId: "asm43-openclaw-user",
      sessionId: `openclaw-session-${runId}`,
    }, openclawCtx);
    const oSearchText = extractToolText(oSearch);
    assert(oSearch?.isError !== true, `OpenClaw memory_search should succeed. got=${oSearchText}`);
    assert(oSearchText.includes(uniqueToken), "OpenClaw memory_search output should include inserted token");

    const oSlotSet = await slotSetTool!.execute("3", {
      key: "project.asm43_smoke",
      value: uniqueToken,
      source: "manual",
    }, openclawCtx);
    assert(oSlotSet?.isError !== true, "OpenClaw memory_slot_set should succeed");

    const oSlotGet = await slotGetTool!.execute("4", {
      key: "project.asm43_smoke",
    }, openclawCtx);
    const oSlotGetText = extractToolText(oSlotGet);
    assert(oSlotGet?.isError !== true, "OpenClaw memory_slot_get should succeed");
    assert(oSlotGetText.includes(uniqueToken), "OpenClaw memory_slot_get should include stored token");

    const openclawFoundCount = extractFoundCount(oSearchText);

    evidence.scenarios.openclaw = {
      memoryStoreText: oStoreText,
      memorySearchText: oSearchText,
      memorySearchFoundCount: openclawFoundCount,
      slotGetText: oSlotGetText,
    };

    // -----------------------------
    // Basic parity checks
    // -----------------------------
    assert(pResults.length >= 1, "Paperclip should find >=1 semantic result");
    assert(openclawFoundCount >= 1, "OpenClaw should find >=1 semantic result");
    assert((pSlotGet.data as any)?.value === uniqueToken, "Paperclip slot value parity baseline should match token");
    assert(oSlotGetText.includes(uniqueToken), "OpenClaw slot value parity baseline should match token");

    evidence.parity = {
      semanticSearch: {
        paperclipCount: pResults.length,
        openclawCount: openclawFoundCount,
        token: uniqueToken,
        status: "PASS",
      },
      slotRoundtrip: {
        paperclipValue: (pSlotGet.data as any)?.value,
        openclawContainsToken: oSlotGetText.includes(uniqueToken),
        status: "PASS",
      },
    };

    // cleanup tool-owned db handle
    paperclipRuntime.slotDb.close();

    evidence.finishedAt = new Date().toISOString();
    evidence.status = "PASS";

    const artifactDir = join(process.cwd(), "artifacts", "asm-43");
    mkdirSync(artifactDir, { recursive: true });

    const jsonPath = join(artifactDir, `asm-43-production-like-smoke-${runId}.json`);
    writeFileSync(jsonPath, JSON.stringify(evidence, null, 2), "utf8");

    const jiraCommentPath = join(artifactDir, `asm-43-jira-evidence-${runId}.md`);
    const jiraComment = [
      `ASM-43 evidence update (${new Date().toISOString()})`,
      "",
      "Production-like verify pass completed on branch `work/asm-43-memory-core-platform-20260312`.",
      "",
      "What was verified:",
      "1) Paperclip simulated runtime caller smoke (real local deps: Qdrant + embedding + SlotDB)",
      "2) Core scenarios on Paperclip path:",
      `   - A. capture/store memory ✅`,
      `   - B. search/retrieve memory ✅ (count=${pResults.length})`,
      "3) Parity baseline with OpenClaw path for same scenario token ✅",
      `   - OpenClaw memory_search count=${openclawFoundCount}`,
      "   - Slot roundtrip parity token check passed on both paths",
      "",
      "Artifacts:",
      `- ${jsonPath}`,
      `- ${jiraCommentPath}`,
      "",
      "Notes / honesty scope:",
      "- This pass confirms runtime-like smoke + basic parity behavior.",
      "- It does NOT overclaim production-grade multi-runtime readiness beyond this verified scope.",
    ].join("\n");
    writeFileSync(jiraCommentPath, jiraComment, "utf8");

    console.log("\n✅ ASM-43 production-like smoke + parity PASS");
    console.log(`- Evidence JSON: ${jsonPath}`);
    console.log(`- Jira comment draft: ${jiraCommentPath}\n`);
  } finally {
    await deleteCollection(qdrantHost, qdrantPort, qdrantCollection);
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

main().catch((error) => {
  console.error("\n❌ ASM-43 production-like smoke failed");
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
