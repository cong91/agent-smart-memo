import type { FeaturePackKey, FeaturePackV1 } from "./feature-pack-contracts.js";

export type ProjectDeveloperQueryCanonicalIntent =
  | "locate_symbol"
  | "locate_file"
  | "feature_lookup"
  | "change_lookup";

export type ProjectDeveloperQueryLegacyIntent =
  | "locate"
  | "trace_flow"
  | "impact"
  | "impact_analysis"
  | "change_aware_lookup"
  | "feature_understanding";

export type ProjectDeveloperQueryIntent =
  | ProjectDeveloperQueryCanonicalIntent
  | ProjectDeveloperQueryLegacyIntent;

export interface ProjectDeveloperQueryPayload {
  project_id?: string;
  project_alias?: string;
  query?: string;
  intent?: ProjectDeveloperQueryIntent;
  limit?: number;
  feature_key?: FeaturePackKey;
  feature_name?: string;
  symbol_name?: string;
  relative_path?: string;
  route_path?: string;
  tracker_issue_key?: string;
  task_id?: string;
  task_title?: string;
  tracker_issue_keys?: string[];
  task_ids?: string[];
  route_paths?: string[];
}

export interface ProjectDeveloperQueryPrimaryResult {
  type: "file" | "symbol" | "chunk" | "task" | "feature_pack";
  id: string;
  title: string;
  score?: number;
  relative_path?: string;
  symbol_name?: string;
  snippet?: string;
}

export interface ProjectDeveloperQueryResponseV1 {
  query_id: string;
  intent: ProjectDeveloperQueryIntent;
  project_id: string;
  project_alias: string | null;
  query: string;
  primary_results: ProjectDeveloperQueryPrimaryResult[];
  files: string[];
  symbols: string[];
  snippets: string[];
  graph_paths: string[];
  feature_packs: FeaturePackV1[];
  change_context: string[];
  assembly_sources: Array<"file" | "symbol" | "feature_pack" | "change_overlay">;
  answer_template: "locate" | "feature_understanding" | "generic";
  answer_summary: string;
  answer_points: string[];
  explainability: {
    ranking_rules: string[];
    top_n: {
      primary_results: number;
      files: number;
      symbols: number;
      snippets: number;
      graph_paths: number;
      change_context: number;
      answer_points: number;
    };
    evidence_counts: {
      locate_hits: number;
      feature_pack_hits: number;
      overlay_changed_files: number;
      overlay_related_symbols: number;
    };
    dedup: {
      primary_results: boolean;
      files: boolean;
      symbols: boolean;
      snippets: boolean;
      graph_paths: boolean;
      change_context: boolean;
    };
    fallbacks: string[];
  };
  confidence: {
    overall: number;
    reason: string;
  };
  why_this_result: string[];
  generated_at: string;
  generator_version: "asm-109-slice8";
}

export type ProjectWorkstreamType = "research_execution" | "coding_execution" | "review_execution";

export interface ProjectRoutingContractPayload {
  project_id?: string;
  project_alias?: string;
  query?: string;
  objective?: string;
  workstream_type?: ProjectWorkstreamType;
}

export interface ProjectRoutingContractV1 {
  routing_contract_version: "asm-routing-v1";
  workstream_type: ProjectWorkstreamType;
  project_id: string;
  project_alias: string | null;
  route_target: {
    lane: "opencode";
    mode: "foundation";
    reason: string;
  };
  retrieval_profile: {
    project_aware: true;
    code_aware: true;
    primary_usecase: "project.developer_query";
  };
  generated_at: string;
}

export interface ProjectCodingPacketPayload {
  project_id?: string;
  project_alias?: string;
  query?: string;
  objective?: string;
  task_id?: string;
  tracker_issue_key?: string;
  task_title?: string;
  symbol_name?: string;
  relative_path?: string;
  route_path?: string;
  limit?: number;
  acceptance_criteria?: string[];
  constraints?: string[];
  out_of_scope?: string[];
  validation_commands?: string[];
}

export interface ProjectCodingPacketV1 {
  packet_version: "asm-coding-packet-v1";
  routing: ProjectRoutingContractV1;
  objective: string;
  project: {
    project_id: string;
    project_alias: string | null;
  };
  selectors: {
    task_id?: string;
    tracker_issue_key?: string;
    task_title?: string;
    symbol_name?: string;
    relative_path?: string;
    route_path?: string;
  };
  context: {
    developer_query: ProjectDeveloperQueryResponseV1;
    primary_files: string[];
    primary_symbols: string[];
    change_context: string[];
  };
  execution_hints: {
    acceptance_criteria: string[];
    constraints: string[];
    out_of_scope: string[];
    validation_commands: string[];
    handoff_language: "vi";
  };
  generated_at: string;
}
