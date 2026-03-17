export type ProjectLifecycleState =
  | "active"
  | "disabled"
  | "detached"
  | "deindexed"
  | "archived"
  | "purged";

export type ProjectLifecycleAction =
  | "register"
  | "deindex"
  | "unregister"
  | "detach"
  | "purge_preview"
  | "purge";

export interface ProjectDeindexPayload {
  project_id: string;
  reason?: string | null;
}

export interface ProjectDeindexResult {
  project_id: string;
  lifecycle_status: ProjectLifecycleState;
  deindexed_at: string;
  reason: string | null;
  affected: {
    files: number;
    chunks: number;
    symbols: number;
  };
  searchable: false;
}

export interface ProjectDetachPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  reason?: string | null;
}

export interface ProjectDetachResult {
  project_id: string;
  lifecycle_status: "detached";
  detached_at: string;
  reason: string | null;
  detached_fields: {
    repo_root: boolean;
    repo_remote_primary: boolean;
    active_version: boolean;
    aliases_removed: number;
    tracker_mappings_removed: number;
  };
  searchable: false;
  next_actions: {
    reattach_via_register_or_update: true;
    reversible_by_re_register: true;
  };
}

export interface ProjectUnregisterPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  confirm?: boolean;
  mode?: "safe";
  reason?: string | null;
}

export interface ProjectUnregisterResult {
  project_id: string;
  lifecycle_status: "disabled";
  unregistered_at: string;
  mode: "safe";
  reason: string | null;
  detached_fields: {
    aliases_removed: number;
    tracker_mappings_removed: number;
  };
  registration_state: {
    registration_status: "draft";
    validation_status: "warn";
  };
  searchable: false;
  audit: {
    deindexed_first: boolean;
    confirm_required: true;
  };
}

export interface ProjectPurgePreviewPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
}

export interface ProjectPurgePreviewResult {
  project_id: string;
  current_lifecycle_status: ProjectLifecycleState;
  purge_guard: {
    destructive: true;
    allowed: boolean;
    reason: string;
    requires_lifecycle_status: "disabled";
    requires_confirm: true;
  };
  affected: {
    project_row: 1;
    aliases: number;
    tracker_mappings: number;
    registration_state: number;
    index_runs: number;
    watch_state: number;
    file_index_state: number;
    chunk_registry: number;
    symbol_registry: number;
    task_registry: number;
  };
  previewed_at: string;
}

export interface ProjectPurgePayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  confirm?: boolean;
  reason?: string | null;
}

export interface ProjectPurgeResult {
  project_id: string;
  lifecycle_status: "purged";
  purged_at: string;
  reason: string | null;
  deleted: {
    project_row: 1;
    aliases: number;
    tracker_mappings: number;
    registration_state: number;
    index_runs: number;
    watch_state: number;
    file_index_state: number;
    chunk_registry: number;
    symbol_registry: number;
    task_registry: number;
  };
  searchable: false;
  recoverable: false;
  audit: {
    confirm_required: true;
    allowed_from_lifecycle_status: "disabled";
  };
}
