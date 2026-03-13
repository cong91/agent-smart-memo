import { extractSemanticBlocks } from "../src/core/ingest/semantic-block-extractor.js";
import { buildChunkArtifacts, planIngestFiles } from "../src/core/ingest/ingest-pipeline.js";
import { buildFileId } from "../src/core/ingest/ids.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("\n🧪 ASM-77 ingest pipeline + semantic extraction tests\n");

  const files = planIngestFiles(
    {
      project_id: "agent-smart-memo",
      source_rev: "abc123",
      trigger_type: "incremental",
      index_profile: "default",
      include_overrides: ["dist/keep-me.ts"],
      max_file_bytes: 120,
    },
    [
      { relative_path: "src/core/a.ts", content: "export function a() { return 1; }" },
      { relative_path: "node_modules/lib/index.js", content: "x" },
      { relative_path: "assets/logo.png", content: "binary" },
      { relative_path: "dist/keep-me.ts", content: "x".repeat(500) },
      { relative_path: "docs/big.md", content: "x".repeat(400) },
    ],
  );

  assert(files.find((f) => f.relative_path === "src/core/a.ts")?.include === true, "source file should be included");
  assert(files.find((f) => f.relative_path === "node_modules/lib/index.js")?.reason === "ignored_path", "node_modules should be ignored");
  assert(files.find((f) => f.relative_path === "assets/logo.png")?.reason === "binary_ext", "binary ext should be excluded");
  assert(files.find((f) => f.relative_path === "docs/big.md")?.reason === "oversized", "oversized file should be excluded");
  assert(files.find((f) => f.relative_path === "dist/keep-me.ts")?.include === true, "include override should win");

  const code = [
    "export class Planner {",
    "  build(input: string) {",
    "    return input.trim();",
    "  }",
    "}",
    "",
    "export async function runPipeline(projectId: string) {",
    "  return projectId;",
    "}",
  ].join("\n");

  const blocks = extractSemanticBlocks({ relativePath: "src/core/planner.ts", content: code });
  assert(blocks.some((b) => b.kind === "class" && b.symbol_name === "Planner"), "should extract class block");
  assert(blocks.some((b) => b.kind === "function" && b.symbol_name === "runPipeline"), "should extract function block");

  const fileId = buildFileId("agent-smart-memo", "src/core/planner.ts");
  const chunksA = buildChunkArtifacts("agent-smart-memo", fileId, "src/core/planner.ts", blocks);
  const chunksB = buildChunkArtifacts("agent-smart-memo", fileId, "src/core/planner.ts", blocks);

  assert(chunksA.length === blocks.length, "chunk count should follow semantic blocks");
  assert(chunksA[0]?.chunk_id === chunksB[0]?.chunk_id, "chunk_id must be deterministic");

  const markdown = "# Intro\n\nThis is a long narrative paragraph about indexing. ".repeat(80);
  const docBlocks = extractSemanticBlocks({
    relativePath: "docs/architecture/ingest.md",
    content: markdown,
    maxDocChunkChars: 600,
  });
  assert(docBlocks.length > 1, "doc fallback should split long content into multiple chunks");

  console.log("✅ asm-77 ingest tests passed\n");
}

main().catch((error) => {
  console.error("❌ asm-77 ingest tests failed:", error.message);
  process.exit(1);
});
