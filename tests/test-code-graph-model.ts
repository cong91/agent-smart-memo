import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { GraphDB } from "../src/db/graph-db.js";
import {
  readUniversalGraphChain,
  upsertUniversalGraphNode,
  upsertUniversalGraphRelation,
} from "../src/core/graph/code-graph-model.js";
import { DefaultMemoryUseCasePort } from "../src/core/usecases/default-memory-usecase-port.js";
import { SlotDB } from "../src/db/slot-db.js";

const TEST_DIR = join(tmpdir(), `agent-memo-code-graph-test-${Date.now()}`);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.log(`  ❌ ${name}`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

async function main() {
  console.log("\n🧪 ASM-92 Universal Graph Model Tests\n");

  const graphDir = join(TEST_DIR, "graph-db");
  if (!existsSync(graphDir)) mkdirSync(graphDir, { recursive: true });
  const graph = new GraphDB(new DatabaseSync(join(graphDir, "slots.db")));

  const USER = "telegram:dm:test";
  const AGENT = "assistant";

  await test("upsertUniversalGraphNode uses stable IDs and updates existing node", () => {
    const created = upsertUniversalGraphNode(graph, USER, AGENT, {
      node_id: "file:src/index.ts",
      node_type: "file",
      name: "src/index.ts",
      properties: { language: "ts" },
    });

    assertEqual(created?.id, "file:src/index.ts", "node should keep provided stable id");

    const updated = upsertUniversalGraphNode(graph, USER, AGENT, {
      node_id: "file:src/index.ts",
      node_type: "file",
      name: "src/index.ts",
      properties: { language: "typescript", module: "src" },
    });

    assert(updated !== null, "updated node should exist");
    assertEqual(updated?.properties.language, "typescript", "node should be updated in place");
    assertEqual(updated?.properties.graph_model, "universal-v1", "graph model marker should exist");
  });

  await test("upsertUniversalGraphRelation stores provenance/confidence in relation properties", () => {
    upsertUniversalGraphNode(graph, USER, AGENT, {
      node_id: "symbol:src/index.ts#main",
      node_type: "symbol",
      name: "main",
    });

    const relation = upsertUniversalGraphRelation(graph, USER, AGENT, {
      source_node_id: "file:src/index.ts",
      target_node_id: "symbol:src/index.ts#main",
      relation_type: "defines",
      provenance: {
        adapter_kind: "test-adapter",
        confidence: 0.83,
        evidence_path: "src/index.ts",
        evidence_start_line: 1,
        evidence_end_line: 20,
      },
    });

    assertEqual(relation.relation_type, "defines", "relation type should persist");
    assertEqual(relation.weight, 0.83, "confidence should map to weight");
    assertEqual(relation.properties.adapter_kind, "test-adapter", "adapter_kind should persist");
    assertEqual(relation.properties.evidence_path, "src/index.ts", "evidence path should persist");
    assertEqual(relation.properties.graph_model, "universal-v1", "graph model marker should persist");
  });

  await test("readUniversalGraphChain returns minimal traversal chain", () => {
    upsertUniversalGraphNode(graph, USER, AGENT, {
      node_id: "route:/health",
      node_type: "route",
      name: "/health",
    });

    upsertUniversalGraphRelation(graph, USER, AGENT, {
      source_node_id: "symbol:src/index.ts#main",
      target_node_id: "route:/health",
      relation_type: "routes_to",
      provenance: {
        adapter_kind: "test-adapter",
        confidence: 0.72,
        evidence_path: "src/index.ts",
      },
    });

    const chain = readUniversalGraphChain(graph, USER, AGENT, "file:src/index.ts", 3);
    assert(chain.entities.some((entity) => entity.id === "symbol:src/index.ts#main"), "chain should include linked symbol");
    assert(chain.relationships.some((rel) => rel.relation_type === "defines"), "chain should include defines relation");
    assert(chain.relationships.some((rel) => rel.relation_type === "routes_to"), "chain should include routes_to relation");
  });

  await test("DefaultMemoryUseCasePort graph.code.upsert + graph.code.chain work end-to-end", async () => {
    const slotDb = new SlotDB(join(TEST_DIR, "slotdb"));
    const usecase = new DefaultMemoryUseCasePort(slotDb);
    const reqBase = {
      context: { userId: USER, agentId: AGENT },
      meta: { source: "test" as const },
    };

    const upsert = await usecase.run<any, any>("graph.code.upsert", {
      ...reqBase,
      payload: {
        nodes: [
          {
            node_id: "module:core.graph",
            node_type: "module",
            name: "core.graph",
            properties: { language: "ts" },
          },
          {
            node_id: "file:src/core/graph/code-graph-model.ts",
            node_type: "file",
            name: "src/core/graph/code-graph-model.ts",
          },
          {
            node_id: "symbol:src/core/graph/code-graph-model.ts#upsertUniversalGraphNode",
            node_type: "symbol",
            name: "upsertUniversalGraphNode",
          },
        ],
        relations: [
          {
            source_node_id: "module:core.graph",
            target_node_id: "file:src/core/graph/code-graph-model.ts",
            relation_type: "defines",
            provenance: { adapter_kind: "parser", confidence: 0.9, evidence_path: "src/core/graph/code-graph-model.ts" },
          },
          {
            source_node_id: "file:src/core/graph/code-graph-model.ts",
            target_node_id: "symbol:src/core/graph/code-graph-model.ts#upsertUniversalGraphNode",
            relation_type: "defines",
            provenance: { adapter_kind: "parser", confidence: 0.95, evidence_path: "src/core/graph/code-graph-model.ts", evidence_start_line: 1, evidence_end_line: 40 },
          },
        ],
      },
    });

    assertEqual(upsert.graph_model, "universal-v1", "usecase should return graph model version");
    assertEqual(upsert.nodes_upserted, 3, "should upsert 3 nodes");
    assertEqual(upsert.relations_upserted, 2, "should upsert 2 relations");

    const chain = await usecase.run<any, any>("graph.code.chain", {
      ...reqBase,
      payload: {
        node_id: "module:core.graph",
        depth: 3,
      },
    });

    assertEqual(chain.graph_model, "universal-v1", "chain should expose graph model version");
    assert(chain.entities.some((entity: any) => entity.id === "file:src/core/graph/code-graph-model.ts"), "chain should include file node");
    assert(chain.relationships.some((rel: any) => rel.relation_type === "defines"), "chain should include defines relation");
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  if (failed > 0) {
    process.exit(1);
  }

  console.log("🎉 ASM-92 universal graph tests passed!\n");
}

main().catch((error) => {
  console.error(error);
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
