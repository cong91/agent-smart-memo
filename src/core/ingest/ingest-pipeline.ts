import type {
  ChunkArtifact,
  FileCandidateInput,
  FilePlanEntry,
  IngestPlanInput,
  SemanticBlock,
} from "./contracts.js";
import { buildChunkId, buildFileId, buildSymbolId, checksumOf } from "./ids.js";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

const IGNORED_DIRS = [
  "node_modules",
  ".venv",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".git",
];

const BINARY_EXT = [
  "png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "gz", "tar", "mp4", "mov", "mp3", "wav", "ico", "lockb",
];

function isIgnoredPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return IGNORED_DIRS.some((dir) => normalized.split("/").includes(dir));
}

function hasBinaryExt(relativePath: string): boolean {
  const idx = relativePath.lastIndexOf(".");
  if (idx < 0) return false;
  const ext = relativePath.slice(idx + 1).toLowerCase();
  return BINARY_EXT.includes(ext);
}

function isIncludeOverride(relativePath: string, includeOverrides: string[]): boolean {
  return includeOverrides.some((prefix) => relativePath.startsWith(prefix));
}

export function planIngestFiles(input: IngestPlanInput, files: FileCandidateInput[]): FilePlanEntry[] {
  const includeOverrides = input.include_overrides ?? [];
  const maxFileBytes = input.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;

  return files.map((file) => {
    const bytes = file.bytes ?? Buffer.byteLength(file.content, "utf8");
    const fileId = buildFileId(input.project_id, file.relative_path);
    const checksum = checksumOf(file.content);

    if (isIncludeOverride(file.relative_path, includeOverrides)) {
      return {
        relative_path: file.relative_path,
        file_id: fileId,
        include: true,
        reason: "included" as const,
        checksum,
        bytes,
      };
    }

    if (isIgnoredPath(file.relative_path)) {
      return {
        relative_path: file.relative_path,
        file_id: fileId,
        include: false,
        reason: "ignored_path" as const,
        checksum,
        bytes,
      };
    }

    if (hasBinaryExt(file.relative_path)) {
      return {
        relative_path: file.relative_path,
        file_id: fileId,
        include: false,
        reason: "binary_ext" as const,
        checksum,
        bytes,
      };
    }

    if (bytes > maxFileBytes) {
      return {
        relative_path: file.relative_path,
        file_id: fileId,
        include: false,
        reason: "oversized" as const,
        checksum,
        bytes,
      };
    }

    return {
      relative_path: file.relative_path,
      file_id: fileId,
      include: true,
      reason: "included" as const,
      checksum,
      bytes,
    };
  });
}

export function buildChunkArtifacts(
  projectId: string,
  fileId: string,
  relativePath: string,
  blocks: SemanticBlock[],
): ChunkArtifact[] {
  return blocks.map((block, ordinal) => {
    const symbolId = ["function", "class", "method", "tool"].includes(block.kind)
      ? buildSymbolId(projectId, relativePath, block.semantic_path)
      : null;

    return {
      chunk_id: buildChunkId(fileId, block.kind, block.semantic_path, ordinal),
      file_id: fileId,
      relative_path: relativePath,
      chunk_kind: block.kind,
      symbol_id: symbolId,
      checksum: checksumOf(block.text),
      semantic_path: block.semantic_path,
      ordinal,
      text: block.text,
    };
  });
}
