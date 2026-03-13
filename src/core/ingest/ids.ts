import { createHash } from "node:crypto";

function sha1(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

export function buildFileId(projectId: string, relativePath: string): string {
  return sha1(`${projectId}:${relativePath}`);
}

export function buildChunkId(
  fileId: string,
  chunkKind: string,
  semanticPath: string,
  ordinal: number,
): string {
  return sha1(`${fileId}:${chunkKind}:${semanticPath}:${ordinal}`);
}

export function buildSymbolId(projectId: string, relativePath: string, symbolFqn: string): string {
  return sha1(`${projectId}:${relativePath}:${symbolFqn}`);
}

export function checksumOf(raw: string): string {
  return sha1(raw);
}
