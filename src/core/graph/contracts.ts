export const UNIVERSAL_GRAPH_MODEL_VERSION = "universal-v1" as const;

export const UNIVERSAL_GRAPH_NODE_TYPES = [
  "file",
  "module",
  "symbol",
  "route",
  "job",
  "event",
  "entity",
] as const;

export const UNIVERSAL_GRAPH_RELATION_TYPES = [
  "defines",
  "calls",
  "imports",
  "extends",
  "implements",
  "routes_to",
  "reads_from",
  "writes_to",
  "emits",
  "consumes",
  "scheduled_as",
  "depends_on",
] as const;

export type UniversalGraphNodeType = (typeof UNIVERSAL_GRAPH_NODE_TYPES)[number];
export type UniversalGraphRelationType = (typeof UNIVERSAL_GRAPH_RELATION_TYPES)[number];

export interface UniversalGraphRelationProvenance {
  adapter_kind: string;
  confidence: number;
  evidence_path?: string;
  evidence_start_line?: number;
  evidence_end_line?: number;
}

export interface UniversalGraphNodeInput {
  node_id: string;
  node_type: UniversalGraphNodeType;
  name: string;
  properties?: Record<string, unknown>;
}

export interface UniversalGraphRelationInput {
  source_node_id: string;
  target_node_id: string;
  relation_type: UniversalGraphRelationType;
  provenance: UniversalGraphRelationProvenance;
  properties?: Record<string, unknown>;
}

export function isUniversalGraphNodeType(value: unknown): value is UniversalGraphNodeType {
  return typeof value === "string" && UNIVERSAL_GRAPH_NODE_TYPES.includes(value as UniversalGraphNodeType);
}

export function isUniversalGraphRelationType(value: unknown): value is UniversalGraphRelationType {
  return typeof value === "string" && UNIVERSAL_GRAPH_RELATION_TYPES.includes(value as UniversalGraphRelationType);
}

export function isValidUniversalGraphProvenance(value: unknown): value is UniversalGraphRelationProvenance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UniversalGraphRelationProvenance>;
  if (typeof candidate.adapter_kind !== "string" || !candidate.adapter_kind.trim()) return false;
  if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)) return false;
  if (candidate.evidence_path !== undefined && typeof candidate.evidence_path !== "string") return false;
  if (candidate.evidence_start_line !== undefined && (!Number.isFinite(candidate.evidence_start_line) || candidate.evidence_start_line < 1)) return false;
  if (candidate.evidence_end_line !== undefined && (!Number.isFinite(candidate.evidence_end_line) || candidate.evidence_end_line < 1)) return false;
  return true;
}
