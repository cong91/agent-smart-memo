export type FeaturePackKey =
  | "project_onboarding_registration_indexing"
  | "code_aware_retrieval"
  | "heartbeat_health_runtime_integrity"
  | "change_aware_impact"
  | "post_entry_review_decision_support";

export const FEATURE_PACK_KEYS: FeaturePackKey[] = [
  "project_onboarding_registration_indexing",
  "code_aware_retrieval",
  "heartbeat_health_runtime_integrity",
  "change_aware_impact",
  "post_entry_review_decision_support",
];

export interface FeaturePackFlowStep {
  step: number;
  title: string;
  details: string;
  related_files?: string[];
  related_symbols?: string[];
}

export interface FeaturePackEvidenceItem {
  type: "project" | "registration" | "tracker" | "index" | "task" | "file" | "symbol";
  ref: string;
  note?: string;
}

export interface FeaturePackV1 {
  pack_id: string;
  title: string;
  feature_key: FeaturePackKey;
  summary: string;
  primary_files: string[];
  primary_symbols: string[];
  flow_steps: FeaturePackFlowStep[];
  risk_points: string[];
  test_points: string[];
  related_tasks: string[];
  related_commits: string[];
  related_prs: string[];
  evidence: FeaturePackEvidenceItem[];
  generated_at: string;
  generator_version: "asm-93-slice1" | "asm-93-slice2";
}

export interface ProjectFeaturePackGeneratePayload {
  project_id?: string;
  project_alias?: string;
  feature_key?: FeaturePackKey;
}
