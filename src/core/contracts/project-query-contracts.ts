import type { FeaturePackKey, FeaturePackV1 } from "./feature-pack-contracts.js";

export type ProjectDeveloperQueryIntent =
  | "locate"
  | "trace_flow"
  | "impact"
  | "change_aware_lookup"
  | "feature_understanding";

export interface ProjectDeveloperQueryPayload {
  project_id?: string;
  project_alias?: string;
  query?: string;
  intent?: ProjectDeveloperQueryIntent;
  limit?: number;
  feature_key?: FeaturePackKey;
  feature_name?: string;
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
  confidence: {
    overall: number;
    reason: string;
  };
  why_this_result: string[];
  generated_at: string;
  generator_version: "asm-95-slice3";
}
