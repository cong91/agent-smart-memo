import type { FeaturePackKey } from "./feature-pack-contracts.js";

export interface ProjectChangeOverlayQueryPayload {
  project_id: string;
  task_id?: string;
  tracker_issue_key?: string;
  task_title?: string;
  feature_key?: FeaturePackKey;
  feature_name?: string;
  include_related?: boolean;
  include_parent_chain?: boolean;
}

export interface ProjectChangeOverlaySymbol {
  symbol_name: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  relative_path?: string;
  source: "task_registry" | "symbol_registry";
  confidence?: number;
  evidence_refs?: string[];
}

export interface ProjectChangeOverlayEvidenceItem {
  type: "task" | "tracker_issue" | "file" | "symbol" | "commit_ref";
  ref: string;
  note?: string;
}

export interface ProjectChangeOverlayFeaturePackMatch {
  feature_key: FeaturePackKey;
  title: string;
  confidence: number;
  matched_evidence: ProjectChangeOverlayEvidenceItem[];
  note?: string;
}

export interface ProjectChangeOverlayConfidence {
  overall: number;
  signals: {
    changed_files: number;
    related_symbols: number;
    commit_refs: number;
    feature_pack_matches: number;
  };
}

export interface ProjectChangeOverlayV1 {
  overlay_id: string;
  project_id: string;
  focus: {
    task_id: string;
    task_title: string;
    tracker_issue_key: string | null;
  };
  changed_files: string[];
  related_symbols: ProjectChangeOverlaySymbol[];
  commit_refs: string[];
  feature_packs: ProjectChangeOverlayFeaturePackMatch[];
  evidence: ProjectChangeOverlayEvidenceItem[];
  confidence: ProjectChangeOverlayConfidence;
  generated_at: string;
  generator_version: "asm-94-slice1" | "asm-94-slice2" | "asm-94-slice3";
}
