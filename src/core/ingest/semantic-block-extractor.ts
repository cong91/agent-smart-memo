import type { SemanticBlock } from "./contracts.js";

interface ExtractInput {
  relativePath: string;
  content: string;
  maxDocChunkChars?: number;
}

const DEFAULT_MAX_DOC_CHUNK = 1400;

function ext(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : "";
}

function isCodeLike(path: string): boolean {
  return ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "rs"].includes(ext(path));
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function findBalancedBlock(content: string, startOffset: number): { text: string; endOffset: number } {
  const firstBrace = content.indexOf("{", startOffset);
  if (firstBrace < 0) {
    const lineEnd = content.indexOf("\n", startOffset);
    const endOffset = lineEnd >= 0 ? lineEnd : content.length;
    return { text: content.slice(startOffset, endOffset), endOffset };
  }

  let depth = 0;
  for (let i = firstBrace; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { text: content.slice(startOffset, i + 1), endOffset: i + 1 };
      }
    }
  }

  return { text: content.slice(startOffset), endOffset: content.length };
}

function extractRegisteredToolBlocks(content: string): Array<{ symbolName: string; start: number; endOffset: number; text: string }> {
  const blocks: Array<{ symbolName: string; start: number; endOffset: number; text: string }> = [];
  const nameRegex = /name\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_:-]*)["'`]/;
  let cursor = 0;

  while (cursor < content.length) {
    const callIdx = content.indexOf('registerTool', cursor);
    if (callIdx < 0) break;
    const objectStart = content.indexOf('{', callIdx);
    if (objectStart < 0) break;

    const block = findBalancedBlock(content, objectStart);
    const match = nameRegex.exec(block.text);
    if (match) {
      blocks.push({
        symbolName: match[1],
        start: callIdx,
        endOffset: block.endOffset,
        text: content.slice(callIdx, block.endOffset),
      });
    }

    cursor = Math.max(block.endOffset, callIdx + 1);
  }

  return blocks;
}

function extractCodeBlocks(relativePath: string, content: string): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  const classRegex = /^\s*(?:export\s+)?class\s+([A-Za-z_][\w$]*)/gm;
  const functionRegex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)\s*\(/gm;
  const methodRegex = /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|throw\b|else\b)([A-Za-z_][\w$]*)\s*\([^\)]*\)\s*\{/gm;
  const disallowedMethodNames = new Set(["if", "for", "while", "switch", "catch", "return", "throw", "else"]);

  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(content))) {
    const symbolName = match[1];
    const start = match.index;
    const block = findBalancedBlock(content, start);
    blocks.push({
      kind: "class",
      symbol_name: symbolName,
      semantic_path: `class:${symbolName}`,
      start_line: lineOf(content, start),
      end_line: lineOf(content, block.endOffset),
      ordinal: blocks.length,
      text: block.text,
    });
  }

  while ((match = functionRegex.exec(content))) {
    const symbolName = match[1];
    const start = match.index;
    const block = findBalancedBlock(content, start);
    blocks.push({
      kind: "function",
      symbol_name: symbolName,
      semantic_path: `function:${symbolName}`,
      start_line: lineOf(content, start),
      end_line: lineOf(content, block.endOffset),
      ordinal: blocks.length,
      text: block.text,
    });
  }

  while ((match = methodRegex.exec(content))) {
    const symbolName = match[1];
    if (disallowedMethodNames.has(symbolName)) continue;
    const start = match.index;
    const block = findBalancedBlock(content, start);
    blocks.push({
      kind: "method",
      symbol_name: symbolName,
      semantic_path: `method:${symbolName}`,
      start_line: lineOf(content, start),
      end_line: lineOf(content, block.endOffset),
      ordinal: blocks.length,
      text: block.text,
    });
  }

  for (const toolBlock of extractRegisteredToolBlocks(content)) {
    blocks.push({
      kind: "tool",
      symbol_name: toolBlock.symbolName,
      semantic_path: `tool:${toolBlock.symbolName}`,
      start_line: lineOf(content, toolBlock.start),
      end_line: lineOf(content, toolBlock.endOffset),
      ordinal: blocks.length,
      text: toolBlock.text,
    });
  }

  return blocks
    .filter((b, idx, arr) => arr.findIndex((x) => x.semantic_path === b.semantic_path && x.start_line === b.start_line) === idx)
    .sort((a, b) => a.start_line - b.start_line)
    .map((b, i) => ({ ...b, ordinal: i }));
}

function extractDocBlocks(content: string, maxDocChunkChars: number): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  const sections = content
    .split(/\n(?=#{1,3}\s+)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const sourceSections = sections.length > 0 ? sections : [content];
  for (const section of sourceSections) {
    if (section.length <= maxDocChunkChars) {
      blocks.push({
        kind: section.startsWith("#") ? "doc_section" : "doc_paragraph",
        symbol_name: "doc",
        semantic_path: section.startsWith("#") ? "doc:section" : "doc:paragraph",
        start_line: 1,
        end_line: section.split("\n").length,
        ordinal: blocks.length,
        text: section,
      });
      continue;
    }

    let cursor = 0;
    while (cursor < section.length) {
      const slice = section.slice(cursor, cursor + maxDocChunkChars);
      blocks.push({
        kind: "doc_paragraph",
        symbol_name: "doc",
        semantic_path: "doc:paragraph",
        start_line: 1,
        end_line: slice.split("\n").length,
        ordinal: blocks.length,
        text: slice,
      });
      cursor += maxDocChunkChars;
    }
  }

  return blocks.map((b, i) => ({ ...b, ordinal: i }));
}

export function extractSemanticBlocks(input: ExtractInput): SemanticBlock[] {
  const maxDocChunkChars = Math.max(300, input.maxDocChunkChars ?? DEFAULT_MAX_DOC_CHUNK);

  if (isCodeLike(input.relativePath)) {
    const codeBlocks = extractCodeBlocks(input.relativePath, input.content);
    if (codeBlocks.length > 0) return codeBlocks;
  }

  return extractDocBlocks(input.content, maxDocChunkChars);
}
