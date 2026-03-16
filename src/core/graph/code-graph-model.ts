import type { GraphDB } from "../../db/graph-db.js";
import {
  UNIVERSAL_GRAPH_MODEL_VERSION,
  type UniversalGraphNodeInput,
  type UniversalGraphRelationInput,
  type UniversalGraphRelationProvenance,
} from "./contracts.js";

function normalizeConfidence(input: number): number {
  if (!Number.isFinite(input)) return 0;
  if (input < 0) return 0;
  if (input > 1) return 1;
  return Number(input.toFixed(6));
}

function normalizeProvenance(provenance: UniversalGraphRelationProvenance): UniversalGraphRelationProvenance {
  const normalized: UniversalGraphRelationProvenance = {
    adapter_kind: String(provenance.adapter_kind || "unknown"),
    confidence: normalizeConfidence(provenance.confidence),
  };

  if (typeof provenance.evidence_path === "string" && provenance.evidence_path.trim()) {
    normalized.evidence_path = provenance.evidence_path.trim();
  }

  if (typeof provenance.evidence_start_line === "number" && Number.isFinite(provenance.evidence_start_line)) {
    normalized.evidence_start_line = Math.max(1, Math.floor(provenance.evidence_start_line));
  }

  if (typeof provenance.evidence_end_line === "number" && Number.isFinite(provenance.evidence_end_line)) {
    normalized.evidence_end_line = Math.max(1, Math.floor(provenance.evidence_end_line));
  }

  return normalized;
}

export function upsertUniversalGraphNode(
  graph: GraphDB,
  scopeUserId: string,
  scopeAgentId: string,
  input: UniversalGraphNodeInput,
) {
  const existing = graph.getEntity(scopeUserId, scopeAgentId, input.node_id);
  const mergedProperties = {
    ...(existing?.properties || {}),
    ...(input.properties || {}),
    graph_model: UNIVERSAL_GRAPH_MODEL_VERSION,
  };

  if (existing) {
    return graph.updateEntity(scopeUserId, scopeAgentId, input.node_id, {
      name: input.name,
      type: input.node_type,
      properties: mergedProperties,
    });
  }

  return graph.createEntityWithId(scopeUserId, scopeAgentId, {
    id: input.node_id,
    name: input.name,
    type: input.node_type,
    properties: mergedProperties,
  });
}

export function upsertUniversalGraphRelation(
  graph: GraphDB,
  scopeUserId: string,
  scopeAgentId: string,
  input: UniversalGraphRelationInput,
) {
  const provenance = normalizeProvenance(input.provenance);
  const properties = {
    ...(input.properties || {}),
    graph_model: UNIVERSAL_GRAPH_MODEL_VERSION,
    adapter_kind: provenance.adapter_kind,
    confidence: provenance.confidence,
    evidence_path: provenance.evidence_path,
    evidence_start_line: provenance.evidence_start_line,
    evidence_end_line: provenance.evidence_end_line,
  };

  return graph.createRelationship(scopeUserId, scopeAgentId, {
    source_entity_id: input.source_node_id,
    target_entity_id: input.target_node_id,
    relation_type: input.relation_type,
    weight: provenance.confidence,
    properties,
  });
}

export function readUniversalGraphChain(
  graph: GraphDB,
  scopeUserId: string,
  scopeAgentId: string,
  startNodeId: string,
  depth: number = 2,
) {
  return graph.traverseGraph(scopeUserId, scopeAgentId, startNodeId, depth);
}
