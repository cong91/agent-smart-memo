import type { createHash } from "node:crypto";

export type IngestTriggerType = "bootstrap" | "incremental" | "manual" | "repair";

export interface IngestPlanInput {
  project_id: string;
  source_rev: string;
  trigger_type: IngestTriggerType;
  index_profile: string;
  include_overrides?: string[];
  max_file_bytes?: number;
}

export interface FileCandidateInput {
  relative_path: string;
  content: string;
  bytes?: number;
}

export interface FilePlanEntry {
  relative_path: string;
  file_id: string;
  include: boolean;
  reason: "included" | "ignored_path" | "binary_ext" | "oversized";
  checksum: string;
  bytes: number;
}

export type SemanticBlockKind =
  | "function"
  | "class"
  | "method"
  | "tool"
  | "doc_section"
  | "doc_paragraph";

export interface SemanticBlock {
  kind: SemanticBlockKind;
  symbol_name: string;
  semantic_path: string;
  start_line: number;
  end_line: number;
  ordinal: number;
  text: string;
}

export interface ChunkArtifact {
  chunk_id: string;
  file_id: string;
  relative_path: string;
  chunk_kind: SemanticBlockKind;
  symbol_id: string | null;
  checksum: string;
  semantic_path: string;
  ordinal: number;
  text: string;
}
