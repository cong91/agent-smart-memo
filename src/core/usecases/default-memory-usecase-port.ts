import type {
  CoreRequestEnvelope,
  MemoryUseCaseName,
  MemoryUseCasePort,
} from "../contracts/adapter-contracts.js";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { buildChunkArtifacts } from "../ingest/ingest-pipeline.js";
import { extractSemanticBlocks } from "../ingest/semantic-block-extractor.js";
import { SlotDB } from "../../db/slot-db.js";
import type { SemanticMemoryUseCase } from "./semantic-memory-usecase.js";
import {
  UNIVERSAL_GRAPH_MODEL_VERSION,
  isUniversalGraphNodeType,
  isUniversalGraphRelationType,
  isValidUniversalGraphProvenance,
  type UniversalGraphNodeInput,
  type UniversalGraphRelationInput,
} from "../graph/contracts.js";
import {
  upsertUniversalGraphNode,
  upsertUniversalGraphRelation,
} from "../graph/code-graph-model.js";
import {
  FEATURE_PACK_KEYS,
  type FeaturePackKey,
  type FeaturePackV1,
  type ProjectFeaturePackGeneratePayload,
} from "../contracts/feature-pack-contracts.js";
import type {
  ProjectChangeOverlayConfidence,
  ProjectChangeOverlayEvidenceItem,
  ProjectChangeOverlayFeaturePackMatch,
  ProjectChangeOverlayQueryPayload,
  ProjectChangeOverlayV1,
} from "../contracts/change-overlay-contracts.js";
import type {
  ProjectDeveloperQueryCanonicalIntent,
  ProjectDeveloperQueryIntent,
  ProjectDeveloperQueryPayload,
  ProjectDeveloperQueryPrimaryResult,
  ProjectDeveloperQueryResponseV1,
} from "../contracts/project-query-contracts.js";
import { resolveAsmCoreProjectWorkspaceRoot } from "../../shared/asm-config.js";

interface SlotGetPayload {
  key?: string;
  category?: string;
  scope?: "private" | "team" | "public" | "all";
}

interface SlotSetPayload {
  key: string;
  value: unknown;
  category?: string;
  source?: "manual" | "auto_capture" | "tool";
  scope?: "private" | "team" | "public";
}

interface SlotListPayload {
  category?: string;
  prefix?: string;
  scope?: "private" | "team" | "public" | "all";
}

interface SlotDeletePayload {
  key: string;
  scope?: "private" | "team" | "public";
}

interface GraphEntityGetPayload {
  id?: string;
  type?: string;
  name?: string;
}

interface GraphEntitySetPayload {
  id?: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

interface GraphRelAddPayload {
  source_id: string;
  target_id: string;
  relation_type: string;
  weight?: number;
  properties?: Record<string, unknown>;
}

interface GraphRelRemovePayload {
  id?: string;
  source_id?: string;
  target_id?: string;
  relation_type?: string;
}

interface GraphSearchPayload {
  entity_id: string;
  depth?: number;
  relation_type?: string;
}

interface GraphCodeUpsertPayload {
  nodes: UniversalGraphNodeInput[];
  relations: UniversalGraphRelationInput[];
}

interface GraphCodeChainPayload {
  node_id: string;
  depth?: number;
  relation_type?: string;
}

interface ProjectRegisterPayload {
  project_id?: string;
  project_name?: string;
  project_alias: string;
  repo_root?: string;
  repo_remote?: string;
  active_version?: string;
  allow_alias_update?: boolean;
}

interface ProjectGetPayload {
  project_id?: string;
  project_alias?: string;
}

interface ProjectBindingPreviewPayload {
  project_id?: string;
  project_alias?: string;
  repo_root?: string;
  session_project_alias?: string;
  allow_cross_project?: boolean;
}

interface ProjectOpenCodeSearchPayload extends ProjectBindingPreviewPayload {
  query: string;
  limit?: number;
  explicit_project_id?: string;
  explicit_project_alias?: string;
  explicit_cross_project?: boolean;
}

interface ProjectSetRegistrationStatePayload {
  project_id: string;
  registration_status: "draft" | "registered" | "validated" | "blocked";
  validation_status: "pending" | "ok" | "warn" | "error";
  validation_notes?: string | null;
  completeness_score: number;
  missing_required_fields: string[];
  last_validated_at?: string | null;
}

interface ProjectSetTrackerMappingPayload {
  project_id: string;
  tracker_type: "jira" | "github" | "other";
  tracker_space_key?: string;
  tracker_project_id?: string;
  default_epic_key?: string;
  board_key?: string;
  active_version?: string;
  external_project_url?: string;
}

interface ProjectRegisterCommandPayload {
  project_alias: string;
  project_name?: string;
  project_id?: string;
  repo_root?: string;
  repo_remote?: string;
  repo_url?: string;
  active_version?: string;
  tracker?: {
    tracker_type: "jira" | "github" | "other";
    tracker_space_key?: string;
    tracker_project_id?: string;
    default_epic_key?: string;
    board_key?: string;
    active_version?: string;
    external_project_url?: string;
  };
  options?: {
    trigger_index?: boolean;
    allow_alias_update?: boolean;
  };
}

interface ProjectLinkTrackerPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  tracker: {
    tracker_type: "jira" | "github" | "other";
    tracker_space_key?: string;
    tracker_project_id?: string;
    default_epic_key?: string;
    board_key?: string;
    active_version?: string;
    external_project_url?: string;
  };
  mode?: "attach_or_update";
}

interface ProjectTriggerIndexPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  mode?: "bootstrap" | "incremental" | "manual" | "repair";
  scope?: {
    path_prefix?: string[];
    module?: string[];
    task_id?: string[];
  };
  reason?: string;
  full_snapshot?: boolean;
  paths?: Array<{
    relative_path: string;
    checksum?: string | null;
    module?: string | null;
    language?: string | null;
    content?: string | null;
  }>;
  source_rev?: string | null;
  index_profile?: string;
}

interface ResolvedRepoSelection {
  repo_root?: string;
  repo_remote?: string;
  resolution:
    | "explicit_repo_root"
    | "cwd_git_root"
    | "registered_remote_match"
    | "cloned_from_repo_url"
    | "imported_local_path"
    | "repo_root_missing";
  clone_policy?:
    | "not_applicable"
    | "reuse_existing_clone"
    | "cloned_new"
    | "cloned_to_conflict_suffix";
  workspace_root?: string;
  clone_target?: string;
  notes: string[];
}

interface ProjectDeindexPayload {
  project_id: string;
  reason?: string | null;
}

interface ProjectDetachPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  reason?: string | null;
}

interface ProjectUnregisterPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  confirm?: boolean;
  mode?: "safe";
  reason?: string | null;
}

interface ProjectPurgePreviewPayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
}

interface ProjectPurgePayload {
  project_ref: {
    project_id?: string;
    project_alias?: string;
  };
  confirm?: boolean;
  reason?: string | null;
}

interface ProjectReindexDiffPayload {
  project_id: string;
  source_rev?: string | null;
  trigger_type?: "bootstrap" | "incremental" | "manual" | "repair";
  index_profile?: string;
  full_snapshot?: boolean;
  paths?: Array<{
    relative_path: string;
    checksum?: string | null;
    module?: string | null;
    language?: string | null;
    content?: string | null;
  }>;
}

interface ProjectIndexEventPayload {
  project_id: string;
  repo_root?: string | null;
  source_rev?: string | null;
  event_type?: "post_commit" | "post_merge" | "post_rewrite" | "manual";
  changed_files?: string[];
  deleted_files?: string[];
  trusted_sync?: boolean;
  full_snapshot?: boolean;
}

interface ProjectInstallHooksPayload {
  project_id: string;
}

interface ProjectIndexWatchGetPayload {
  project_id: string;
}

interface ProjectTaskRegistryUpsertPayload {
  task_id: string;
  project_id: string;
  task_title: string;
  task_type?: string | null;
  task_status?: string | null;
  parent_task_id?: string | null;
  related_task_ids?: string[];
  files_touched?: string[];
  symbols_touched?: string[];
  commit_refs?: string[];
  diff_refs?: string[];
  decision_notes?: string | null;
  tracker_issue_key?: string | null;
}

interface ProjectTaskLineageContextPayload {
  project_id: string;
  task_id?: string;
  tracker_issue_key?: string;
  task_title?: string;
  include_related?: boolean;
  include_parent_chain?: boolean;
}

interface ProjectHybridSearchPayload {
  project_id: string;
  query: string;
  limit?: number;
  debug?: boolean;
  path_prefix?: string[];
  module?: string[];
  language?: string[];
  task_id?: string[];
  tracker_issue_key?: string[];
  task_context?: {
    task_id?: string;
    tracker_issue_key?: string;
    task_title?: string;
    include_related?: boolean;
    include_parent_chain?: boolean;
  };
}

interface ProjectFeaturePackQueryPayload {
  project_id?: string;
  project_alias?: string;
  feature_key?: FeaturePackKey;
  feature_name?: string;
}

type ProjectChangeOverlayQueryUseCasePayload = ProjectChangeOverlayQueryPayload;

interface ProjectDeveloperQueryParsed {
  canonical_intent: ProjectDeveloperQueryCanonicalIntent;
  legacy_intent: ProjectDeveloperQueryIntent;
  query_text: string;
  symbol_name?: string;
  relative_path?: string;
  route_path?: string;
  tracker_issue_key?: string;
  task_id?: string;
  task_title?: string;
  tracker_issue_keys?: string[];
  task_ids?: string[];
  route_paths?: string[];
  feature_key?: FeaturePackKey;
}

type DeveloperRetrievalSource = "symbol_registry" | "file_index_state" | "chunk_registry" | "task_registry";

interface ProjectDeveloperRetrievalPlan {
  plan_key: ProjectDeveloperQueryCanonicalIntent;
  source_priority: DeveloperRetrievalSource[];
  locate_limit: number;
  use_task_context: boolean;
  attach_feature_pack: boolean;
  attach_overlay: boolean;
  prefer_feature_primary: boolean;
  path_prefix_hint?: string[];
}

interface ProjectLegacyBackfillPayload {
  mode?: "dry_run" | "apply";
  only_project_ids?: string[];
  only_aliases?: string[];
  force_registration_state?: boolean;
  source?: "repo_root" | "repo_remote" | "task_registry" | "mixed";
}

interface ProjectTelegramOnboardingPayload {
  command?: string;
  repo_url?: string;
  project_alias?: string;
  jira_space_key?: string;
  default_epic_key?: string;
  index_now?: boolean;
  project_name?: string;
  repo_root?: string;
  project_workspace_root?: string;
  active_version?: string;
  mode?: "preview" | "confirm";
}

interface ScopeIdentity {
  userId: string;
  agentId: string;
  scope: "private" | "team" | "public";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePrivateIdentity(ctx: { userId: string; agentId: string }): ScopeIdentity {
  return {
    userId: ctx.userId || "default",
    agentId: ctx.agentId || "assistant",
    scope: "private",
  };
}

function scopeToIdentity(
  ctx: { userId: string; agentId: string },
  scope: "private" | "team" | "public" | undefined,
): ScopeIdentity {
  const base = normalizePrivateIdentity(ctx);

  if (scope === "team") {
    return { userId: base.userId, agentId: "__team__", scope: "team" };
  }

  if (scope === "public") {
    return { userId: "__public__", agentId: "__public__", scope: "public" };
  }

  return base;
}

function allScopeIdentities(ctx: { userId: string; agentId: string }): ScopeIdentity[] {
  const base = normalizePrivateIdentity(ctx);
  return [
    base,
    { userId: base.userId, agentId: "__team__", scope: "team" },
    { userId: "__public__", agentId: "__public__", scope: "public" },
  ];
}

function randomJobId(): string {
  return `idxjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sha1(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}


function shellEscape(value: string): string {
  const input = String(value || "");
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

export class DefaultMemoryUseCasePort implements MemoryUseCasePort {
  constructor(
    private readonly slotDb: SlotDB,
    private readonly semanticUseCase?: SemanticMemoryUseCase,
  ) {}

  async run<TReq, TRes>(
    useCase: MemoryUseCaseName,
    req: CoreRequestEnvelope<TReq>,
  ): Promise<TRes> {
    const payload = asRecord(req.payload);

    switch (useCase) {
      case "slot.get":
        return this.handleSlotGet(payload as unknown as SlotGetPayload, req) as TRes;
      case "slot.set":
        return this.handleSlotSet(payload as unknown as SlotSetPayload, req) as TRes;
      case "slot.list":
        return this.handleSlotList(payload as unknown as SlotListPayload, req) as TRes;
      case "slot.delete":
        return this.handleSlotDelete(payload as unknown as SlotDeletePayload, req) as TRes;
      case "project.register":
        return this.handleProjectRegister(payload as unknown as ProjectRegisterPayload, req) as TRes;
      case "project.get":
        return this.handleProjectGet(payload as unknown as ProjectGetPayload, req) as TRes;
      case "project.binding_preview":
        return this.handleProjectBindingPreview(payload as unknown as ProjectBindingPreviewPayload, req) as TRes;
      case "project.opencode_search":
        return this.handleProjectOpenCodeSearch(payload as unknown as ProjectOpenCodeSearchPayload, req) as TRes;
      case "project.list":
        return this.handleProjectList(req) as TRes;
      case "project.set_registration_state":
        return this.handleProjectSetRegistrationState(payload as unknown as ProjectSetRegistrationStatePayload, req) as TRes;
      case "project.set_tracker_mapping":
        return this.handleProjectSetTrackerMapping(payload as unknown as ProjectSetTrackerMappingPayload, req) as TRes;
      case "project.register_command":
        return this.handleProjectRegisterCommand(payload as unknown as ProjectRegisterCommandPayload, req) as TRes;
      case "project.link_tracker":
        return this.handleProjectLinkTracker(payload as unknown as ProjectLinkTrackerPayload, req) as TRes;
      case "project.trigger_index":
        return this.handleProjectTriggerIndex(payload as unknown as ProjectTriggerIndexPayload, req) as TRes;
      case "project.deindex":
        return this.handleProjectDeindex(payload as unknown as ProjectDeindexPayload, req) as TRes;
      case "project.detach":
        return this.handleProjectDetach(payload as unknown as ProjectDetachPayload, req) as TRes;
      case "project.unregister":
        return this.handleProjectUnregister(payload as unknown as ProjectUnregisterPayload, req) as TRes;
      case "project.purge_preview":
        return this.handleProjectPurgePreview(payload as unknown as ProjectPurgePreviewPayload, req) as TRes;
      case "project.purge":
        return this.handleProjectPurge(payload as unknown as ProjectPurgePayload, req) as TRes;
      case "project.reindex_diff":
        return this.handleProjectReindexDiff(payload as unknown as ProjectReindexDiffPayload, req) as TRes;
      case "project.index_event":
        return this.handleProjectIndexEvent(payload as unknown as ProjectIndexEventPayload, req) as TRes;
      case "project.install_hooks":
        return this.handleProjectInstallHooks(payload as unknown as ProjectInstallHooksPayload, req) as TRes;
      case "project.index_watch_get":
        return this.handleProjectIndexWatchGet(payload as unknown as ProjectIndexWatchGetPayload, req) as TRes;
      case "project.task_registry_upsert":
        return this.handleProjectTaskRegistryUpsert(payload as unknown as ProjectTaskRegistryUpsertPayload, req) as TRes;
      case "project.task_lineage_context":
        return this.handleProjectTaskLineageContext(payload as unknown as ProjectTaskLineageContextPayload, req) as TRes;
      case "project.hybrid_search":
        return this.handleProjectHybridSearch(payload as unknown as ProjectHybridSearchPayload, req) as TRes;
      case "project.change_overlay.query":
        return this.handleProjectChangeOverlayQuery(payload as unknown as ProjectChangeOverlayQueryUseCasePayload, req) as TRes;
      case "project.legacy_backfill":
        return this.handleProjectLegacyBackfill(payload as unknown as ProjectLegacyBackfillPayload, req) as TRes;
      case "project.telegram_onboarding":
        return this.handleProjectTelegramOnboarding(payload as unknown as ProjectTelegramOnboardingPayload, req) as TRes;
      case "project.feature_pack.generate":
        return this.handleProjectFeaturePackGenerate(payload as unknown as ProjectFeaturePackGeneratePayload, req) as TRes;
      case "project.feature_pack.query":
        return this.handleProjectFeaturePackQuery(payload as unknown as ProjectFeaturePackQueryPayload, req) as TRes;
      case "project.developer_query":
        return this.handleProjectDeveloperQuery(payload as unknown as ProjectDeveloperQueryPayload, req) as TRes;
      case "graph.entity.get":
        return this.handleGraphEntityGet(payload as unknown as GraphEntityGetPayload, req) as TRes;
      case "graph.entity.set":
        return this.handleGraphEntitySet(payload as unknown as GraphEntitySetPayload, req) as TRes;
      case "graph.rel.add":
        return this.handleGraphRelAdd(payload as unknown as GraphRelAddPayload, req) as TRes;
      case "graph.rel.remove":
        return this.handleGraphRelRemove(payload as unknown as GraphRelRemovePayload, req) as TRes;
      case "graph.search":
        return this.handleGraphSearch(payload as unknown as GraphSearchPayload, req) as TRes;
      case "graph.code.upsert":
        return this.handleGraphCodeUpsert(payload as unknown as GraphCodeUpsertPayload, req) as TRes;
      case "graph.code.chain":
        return this.handleGraphCodeChain(payload as unknown as GraphCodeChainPayload, req) as TRes;
      case "memory.capture":
        return this.handleMemoryCapture(payload, req) as TRes;
      case "memory.search":
        return this.handleMemorySearch(payload, req) as TRes;
      default:
        throw new Error(`Unsupported use-case: ${useCase}`);
    }
  }

  private handleSlotGet(payload: SlotGetPayload, req: CoreRequestEnvelope<unknown>) {
    if (payload.scope === "all") {
      const rows = allScopeIdentities(req.context).flatMap((identity) => {
        const result = this.slotDb.get(identity.userId, identity.agentId, {
          key: payload.key,
          category: payload.category,
        });

        if (!result) return [];
        const list = Array.isArray(result) ? result : [result];
        return list.map((slot) => ({
          key: slot.key,
          value: slot.value,
          category: slot.category,
          version: slot.version,
          scope: identity.scope,
        }));
      });

      if (payload.key) {
        return rows.length > 0 ? rows[0] : null;
      }

      return rows;
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    const result = this.slotDb.get(identity.userId, identity.agentId, {
      key: payload.key,
      category: payload.category,
    });

    if (!result) return null;

    if (Array.isArray(result)) {
      return result.map((slot) => ({
        key: slot.key,
        value: slot.value,
        category: slot.category,
        version: slot.version,
        scope: identity.scope,
      }));
    }

    return {
      key: result.key,
      value: result.value,
      category: result.category,
      version: result.version,
      scope: identity.scope,
    };
  }

  private handleSlotSet(payload: SlotSetPayload, req: CoreRequestEnvelope<unknown>) {
    if (!payload.key || typeof payload.key !== "string") {
      throw new Error("slot.set requires payload.key");
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    const slot = this.slotDb.set(identity.userId, identity.agentId, {
      key: payload.key,
      value: payload.value,
      category: payload.category,
      source: payload.source || "tool",
    });

    return {
      key: slot.key,
      value: slot.value,
      category: slot.category,
      version: slot.version,
      scope: identity.scope,
    };
  }

  private handleSlotList(payload: SlotListPayload, req: CoreRequestEnvelope<unknown>) {
    if (payload.scope === "all" || !payload.scope) {
      return allScopeIdentities(req.context).flatMap((identity) =>
        this.slotDb.list(identity.userId, identity.agentId, {
          category: payload.category,
          prefix: payload.prefix,
        }).map((slot) => ({
          key: slot.key,
          value: slot.value,
          category: slot.category,
          version: slot.version,
          scope: identity.scope,
        })),
      );
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    return this.slotDb.list(identity.userId, identity.agentId, {
      category: payload.category,
      prefix: payload.prefix,
    }).map((slot) => ({
      key: slot.key,
      value: slot.value,
      category: slot.category,
      version: slot.version,
      scope: identity.scope,
    }));
  }

  private handleSlotDelete(payload: SlotDeletePayload, req: CoreRequestEnvelope<unknown>) {
    if (!payload.key || typeof payload.key !== "string") {
      throw new Error("slot.delete requires payload.key");
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    return {
      key: payload.key,
      deleted: this.slotDb.delete(identity.userId, identity.agentId, payload.key),
      scope: identity.scope,
    };
  }

  private handleProjectRegister(payload: ProjectRegisterPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_alias || typeof payload.project_alias !== "string") {
      throw new Error("project.register requires payload.project_alias");
    }

    return this.slotDb.registerProject(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_name: payload.project_name,
      project_alias: payload.project_alias,
      repo_root: payload.repo_root,
      repo_remote: payload.repo_remote,
      active_version: payload.active_version,
      allow_alias_update: payload.allow_alias_update,
    });
  }

  private handleProjectGet(payload: ProjectGetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id && !payload.project_alias) {
      throw new Error("project.get requires payload.project_id or payload.project_alias");
    }

    if (payload.project_id) {
      const project = this.slotDb.getProjectById(identity.userId, identity.agentId, payload.project_id);
      if (!project) return null;
      return {
        project,
        registration: this.slotDb.getProjectRegistrationState(identity.userId, identity.agentId, payload.project_id),
      };
    }

    const byAlias = this.slotDb.getProjectByAlias(identity.userId, identity.agentId, payload.project_alias!);
    if (!byAlias) return null;

    return {
      project: byAlias.project,
      alias: byAlias.alias,
      registration: this.slotDb.getProjectRegistrationState(identity.userId, identity.agentId, byAlias.project.project_id),
    };
  }

  private handleProjectList(req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    return this.slotDb.listProjects(identity.userId, identity.agentId);
  }

  private handleProjectBindingPreview(payload: ProjectBindingPreviewPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const projects = this.slotDb.listProjects(identity.userId, identity.agentId);
    const normalizedRepoRoot = this.normalizeRepoRootInput(payload.repo_root);
    const aliasSelector = String(payload.project_alias || payload.session_project_alias || "").trim();
    const matches: Array<{
      project_id: string;
      project_alias: string | null;
      project_name: string;
      repo_root: string | null;
      lifecycle_status: string;
      source: "project_id" | "project_alias" | "session_project_alias" | "repo_root";
    }> = [];

    const pushMatch = (project: any, aliases: any[], source: "project_id" | "project_alias" | "session_project_alias" | "repo_root") => {
      if (matches.some((item) => item.project_id === project.project_id && item.source === source)) return;
      matches.push({
        project_id: project.project_id,
        project_alias: aliases.find((item) => item.is_primary === 1)?.project_alias || aliases[0]?.project_alias || null,
        project_name: project.project_name,
        repo_root: project.repo_root,
        lifecycle_status: project.lifecycle_status,
        source,
      });
    };

    if (payload.project_id) {
      const direct = this.slotDb.getProjectById(identity.userId, identity.agentId, payload.project_id);
      if (direct) {
        const row = projects.find((item) => item.project.project_id === direct.project_id);
        pushMatch(direct, row?.aliases || [], "project_id");
      }
    }

    if (aliasSelector) {
      const byAlias = this.slotDb.getProjectByAlias(identity.userId, identity.agentId, aliasSelector);
      if (byAlias) {
        const row = projects.find((item) => item.project.project_id === byAlias.project.project_id);
        pushMatch(byAlias.project, row?.aliases || [byAlias.alias], payload.project_alias ? "project_alias" : "session_project_alias");
      }
    }

    if (normalizedRepoRoot) {
      for (const row of projects) {
        const projectRepoRoot = this.normalizeRepoRootInput(row.project.repo_root || undefined);
        if (projectRepoRoot && projectRepoRoot === normalizedRepoRoot) {
          pushMatch(row.project, row.aliases, "repo_root");
        }
      }
    }

    const uniqueByProject = Array.from(new Map(matches.map((item) => [item.project_id, item] as const)).values());
    const activeMatches = uniqueByProject.filter((item) => item.lifecycle_status === "active");
    const crossProjectRequired = activeMatches.length > 1;
    const allowed = !crossProjectRequired || payload.allow_cross_project === true;
    const selected = activeMatches[0] || uniqueByProject[0] || null;

    const resolutionStatus = selected
      ? (crossProjectRequired && !allowed ? "ambiguous" : "resolved")
      : "unresolved";
    const resolutionReason = resolutionStatus === "ambiguous"
      ? "multiple_active_projects"
      : resolutionStatus === "unresolved"
        ? (normalizedRepoRoot ? "unregistered_repo_root" : "selector_not_matched")
        : "matched";

    return {
      mode: "read-only",
      project_scoped_by_default: true,
      cross_project_allowed: payload.allow_cross_project === true,
      resolution_status: resolutionStatus,
      selected_project: selected,
      candidate_projects: uniqueByProject,
      resolution: {
        selectors: {
          project_id: payload.project_id || null,
          project_alias: payload.project_alias || null,
          session_project_alias: payload.session_project_alias || null,
          repo_root: normalizedRepoRoot || null,
        },
        reason: resolutionReason,
        cross_project_required: crossProjectRequired,
        explicit_cross_project_required: crossProjectRequired,
        read_only_tool_surface: ["project_registry_get", "project_registry_list", "project_hybrid_search", "project_developer_query"],
      },
      errors: selected
        ? (crossProjectRequired && !allowed ? ["multiple active project matches found; explicit cross-project approval required"] : [])
        : [normalizedRepoRoot ? "no active registered project matched repo_root" : "no registered project matched provided selectors"],
    };
  }

  private handleProjectOpenCodeSearch(payload: ProjectOpenCodeSearchPayload, req: CoreRequestEnvelope<unknown>) {
    const binding = this.handleProjectBindingPreview(
      {
        project_id: payload.explicit_project_id || payload.project_id,
        project_alias: payload.explicit_project_alias || payload.project_alias,
        repo_root: payload.repo_root,
        session_project_alias: payload.session_project_alias,
        allow_cross_project: payload.explicit_cross_project || payload.allow_cross_project,
      },
      req,
    ) as any;

    if (binding.resolution_status !== "resolved" || !binding.selected_project?.project_id) {
      return {
        mode: "read-only",
        resolution_status: binding.resolution_status,
        binding,
        query: payload.query,
        results: null,
        errors: binding.errors || ["project binding could not be resolved for read-only search"],
      };
    }

    const selectedProjectId = binding.selected_project.project_id;
    const selectedProjectAlias = binding.selected_project.project_alias;
    const selectedLifecycle = String(binding.selected_project.lifecycle_status || "active");

    if (["deindexed", "detached", "disabled", "purged"].includes(selectedLifecycle)) {
      return {
        mode: "read-only",
        resolution_status: "resolved",
        binding,
        query: payload.query,
        results: {
          project_id: selectedProjectId,
          project_alias: selectedProjectAlias || null,
          project_lifecycle_status: selectedLifecycle,
          searchable: false,
          count: 0,
          results: [],
          reason:
            selectedLifecycle === "deindexed"
              ? "project is deindexed; read-only retrieval is disabled until reindex"
              : selectedLifecycle === "detached"
                ? "project is detached; read-only retrieval is disabled until re-attachment"
                : selectedLifecycle === "disabled"
                  ? "project is unregistered/disabled; read-only retrieval is disabled"
                  : "project is purged; read-only retrieval is disabled",
        },
        errors: [],
      };
    }

    const results = this.handleProjectDeveloperQuery(
      {
        project_id: selectedProjectId,
        project_alias: selectedProjectAlias || undefined,
        query: payload.query,
        limit: payload.limit,
      },
      req,
    );

    return {
      mode: "read-only",
      resolution_status: "resolved",
      binding,
      query: payload.query,
      results,
      errors: [],
    };
  }

  private handleProjectSetRegistrationState(payload: ProjectSetRegistrationStatePayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.set_registration_state requires payload.project_id");
    }

    return this.slotDb.updateProjectRegistrationState(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      registration_status: payload.registration_status,
      validation_status: payload.validation_status,
      validation_notes: payload.validation_notes ?? null,
      completeness_score: payload.completeness_score,
      missing_required_fields: payload.missing_required_fields || [],
      last_validated_at: payload.last_validated_at,
    });
  }

  private handleProjectSetTrackerMapping(payload: ProjectSetTrackerMappingPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id || !payload.tracker_type) {
      throw new Error("project.set_tracker_mapping requires payload.project_id and payload.tracker_type");
    }

    if (payload.tracker_type === "jira") {
      this.validateJiraTrackerFields(payload.tracker_space_key, payload.default_epic_key);
    }

    return this.slotDb.setProjectTrackerMapping(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      tracker_type: payload.tracker_type,
      tracker_space_key: payload.tracker_space_key,
      tracker_project_id: payload.tracker_project_id,
      default_epic_key: payload.default_epic_key,
      board_key: payload.board_key,
      active_version: payload.active_version,
      external_project_url: payload.external_project_url,
    });
  }

  private handleProjectRegisterCommand(payload: ProjectRegisterCommandPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    const alias = String(payload.project_alias || "").trim();
    if (!alias) {
      throw new Error("project.register_command requires payload.project_alias");
    }

    const repoUrl = String(payload.repo_url || payload.repo_remote || "").trim() || undefined;
    const workspaceRoot = this.resolveWorkspaceRoot(req);
    const selection = this.resolveRepoForRegistration(
      identity.userId,
      identity.agentId,
      {
        explicitRepoRoot: payload.repo_root,
        repoUrl,
        workspaceRoot,
      },
    );

    const resolvedRepoRoot = selection.repo_root;
    const resolvedRepoRemote = payload.repo_remote || selection.repo_remote || repoUrl;

    const registered = this.slotDb.registerProject(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_name: payload.project_name,
      project_alias: alias,
      repo_root: resolvedRepoRoot,
      repo_remote: resolvedRepoRemote,
      active_version: payload.active_version,
      allow_alias_update: payload.options?.allow_alias_update,
      reuse_existing_repo_root: selection.resolution === "registered_remote_match",
    });

    let trackerMapping: any = null;
    if (payload.tracker?.tracker_type) {
      if (payload.tracker.tracker_type === "jira") {
        this.validateJiraTrackerFields(payload.tracker.tracker_space_key, payload.tracker.default_epic_key);
      }

      trackerMapping = this.slotDb.setProjectTrackerMapping(identity.userId, identity.agentId, {
        project_id: registered.project.project_id,
        tracker_type: payload.tracker.tracker_type,
        tracker_space_key: payload.tracker.tracker_space_key,
        tracker_project_id: payload.tracker.tracker_project_id,
        default_epic_key: payload.tracker.default_epic_key,
        board_key: payload.tracker.board_key,
        active_version: payload.tracker.active_version || payload.active_version,
        external_project_url: payload.tracker.external_project_url,
      });
    }

    const triggerRequested = payload.options?.trigger_index === true;
    let indexTrigger: any = {
      requested: triggerRequested,
      accepted: false,
      enqueued: false,
      run_id: null,
      job_id: null,
      note: triggerRequested ? "index requested but not enqueued" : null,
    };

    if (triggerRequested) {
      const triggerResult = this.handleProjectTriggerIndex(
        {
          project_ref: { project_id: registered.project.project_id },
          mode: "bootstrap",
          reason: "post_registration",
          paths: [],
        },
        req,
      );
      indexTrigger = {
        requested: true,
        accepted: Boolean(triggerResult?.accepted),
        enqueued: Boolean(triggerResult?.enqueued),
        run_id: triggerResult?.run_id || null,
        job_id: triggerResult?.job_id || null,
        note: triggerResult?.note || null,
      };
    }

    const autoIndexHook = this.installProjectGitHooks(registered.project.project_id, registered.project.repo_root);

    return {
      project_id: registered.project.project_id,
      project_alias: registered.alias.project_alias,
      registration_status: registered.registration.registration_status,
      validation_status: registered.registration.validation_status,
      completeness_score: Number((registered.registration.completeness_score / 100).toFixed(2)),
      warnings: [],
      auto_index_hook: autoIndexHook,
      repo_resolution: {
        resolution: selection.resolution,
        clone_policy: selection.clone_policy || "not_applicable",
        workspace_root: selection.workspace_root || null,
        clone_target: selection.clone_target || null,
        notes: selection.notes,
      },
      tracker_mapping: trackerMapping
        ? {
            tracker_type: trackerMapping.tracker_type,
            tracker_space_key: trackerMapping.tracker_space_key,
            default_epic_key: trackerMapping.default_epic_key,
            mapping_status: "linked",
          }
        : null,
      index_trigger: indexTrigger,
      project: registered.project,
      registration: registered.registration,
    };
  }

  private handleProjectLinkTracker(payload: ProjectLinkTrackerPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const mode = payload.mode || "attach_or_update";
    if (mode !== "attach_or_update") {
      throw new Error("project.link_tracker only supports mode=attach_or_update");
    }

    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref);
    if (!payload.tracker?.tracker_type) {
      throw new Error("project.link_tracker requires tracker.tracker_type");
    }

    if (payload.tracker.tracker_type === "jira") {
      this.validateJiraTrackerFields(payload.tracker.tracker_space_key, payload.tracker.default_epic_key);
    }

    const mapped = this.slotDb.setProjectTrackerMapping(identity.userId, identity.agentId, {
      project_id: project.project_id,
      tracker_type: payload.tracker.tracker_type,
      tracker_space_key: payload.tracker.tracker_space_key,
      tracker_project_id: payload.tracker.tracker_project_id,
      default_epic_key: payload.tracker.default_epic_key,
      board_key: payload.tracker.board_key,
      active_version: payload.tracker.active_version,
      external_project_url: payload.tracker.external_project_url,
    });

    return {
      project_id: project.project_id,
      tracker_mapping: {
        tracker_type: mapped.tracker_type,
        tracker_space_key: mapped.tracker_space_key,
        default_epic_key: mapped.default_epic_key,
        mapping_status: "linked",
        updated: true,
      },
      validation_status: "ok",
      warnings: [],
    };
  }

  private handleProjectTriggerIndex(payload: ProjectTriggerIndexPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref);
    const queuedAt = new Date().toISOString();
    const jobId = randomJobId();

    const normalizedPaths = this.hydrateIndexPathsFromRepo(
      project.repo_root,
      (payload.paths || []).filter((item) => String(item.relative_path || "").trim().length > 0),
    );

    this.scheduleProjectReindexJob({
      scopeUserId: identity.userId,
      scopeAgentId: identity.agentId,
      projectId: project.project_id,
      sourceRev: payload.source_rev || null,
      triggerType: payload.mode || "bootstrap",
      indexProfile: payload.index_profile || "default",
      paths: normalizedPaths,
      jobId,
    });

    return {
      project_id: project.project_id,
      accepted: true,
      enqueued: true,
      detached: true,
      run_id: null,
      job_id: jobId,
      queued_at: queuedAt,
      reason: payload.reason || "manual_trigger",
      path_count: normalizedPaths.length,
      note:
        normalizedPaths.length > 0
          ? "index request accepted/enqueued in background mode"
          : "index request accepted/enqueued in background mode; no concrete paths provided yet",
    };
  }

  private scheduleProjectReindexJob(input: {
    scopeUserId: string;
    scopeAgentId: string;
    projectId: string;
    sourceRev: string | null;
    triggerType: "bootstrap" | "incremental" | "manual" | "repair";
    indexProfile: string;
    paths: Array<{
      relative_path: string;
      checksum?: string | null;
      module?: string | null;
      language?: string | null;
      content?: string | null;
    }>;
    jobId: string;
  }): void {
    setTimeout(() => {
      try {
        const project = this.slotDb.getProjectById(input.scopeUserId, input.scopeAgentId, input.projectId);
        let paths = input.paths;
        if (paths.length === 0) {
          if (project?.repo_root) {
            paths = this.collectGitTrackedPaths(project.repo_root);
          }
        } else {
          paths = this.hydrateIndexPathsFromRepo(project?.repo_root, paths);
        }

        if (paths.length === 0) return;

        this.slotDb.reindexProjectByDiff(input.scopeUserId, input.scopeAgentId, {
          project_id: input.projectId,
          source_rev: input.sourceRev,
          trigger_type: input.triggerType,
          index_profile: input.indexProfile,
          full_snapshot: input.triggerType === "bootstrap",
          paths,
        });
      } catch {
        // Background-friendly fire-and-forget path: do not block foreground tool response.
      }
    }, 0);
  }

  private resolveProjectRef(
    scopeUserId: string,
    scopeAgentId: string,
    projectRef: { project_id?: string; project_alias?: string },
  ) {
    if (projectRef?.project_id) {
      const project = this.slotDb.getProjectById(scopeUserId, scopeAgentId, projectRef.project_id);
      if (!project) throw new Error(`project_id '${projectRef.project_id}' is not registered`);
      return project;
    }

    if (projectRef?.project_alias) {
      const byAlias = this.slotDb.getProjectByAlias(scopeUserId, scopeAgentId, projectRef.project_alias);
      if (!byAlias) throw new Error(`project_alias '${projectRef.project_alias}' is not registered`);
      return byAlias.project;
    }

    throw new Error("project reference requires project_id or project_alias");
  }

  private installProjectGitHooks(projectId: string, repoRoot: string | null): { installed: boolean; hooks: string[]; note?: string } {
    if (!repoRoot) return { installed: false, hooks: [], note: 'repo_root_missing' };
    const gitDir = resolve(repoRoot, '.git');
    if (!existsSync(gitDir)) return { installed: false, hooks: [], note: 'git_dir_missing' };

    let hooksDir = resolve(gitDir, 'hooks');
    try {
      const hooksPath = execSync('git config --get core.hooksPath', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
      if (hooksPath) hooksDir = resolve(repoRoot, hooksPath);
    } catch {}

    mkdirSync(hooksDir, { recursive: true });
    const listenerPath = resolve(hooksDir, 'asm-project-event.sh');
    const marker = '# ASM_AUTO_INDEX_HOOK';

    const listener = `#!/bin/sh
PROJECT_ID="${projectId}"
REPO_ROOT="${repoRoot}"
EVENT_TYPE="$1"
SOURCE_REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DEFAULT_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
WORKTREE_DIRTY="$(if git diff --quiet --ignore-submodules HEAD -- 2>/dev/null && git diff --cached --quiet --ignore-submodules -- 2>/dev/null; then echo 0; else echo 1; fi)"
TRUSTED_SYNC="0"
FULL_SNAPSHOT="0"
CHANGED_FILES=""
DELETED_FILES=""

if [ "$EVENT_TYPE" = "post_commit" ]; then
  CHANGED_FILES="$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | paste -sd, -)"
  DELETED_FILES="$(git diff-tree --no-commit-id --name-only --diff-filter=D -r HEAD 2>/dev/null | paste -sd, -)"
fi

if [ -n "$DEFAULT_BRANCH" ] && [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] && [ "$WORKTREE_DIRTY" = "0" ]; then
  if git rev-parse --verify "origin/$DEFAULT_BRANCH" >/dev/null 2>&1; then
    LOCAL_HEAD="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    REMOTE_HEAD="$(git rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null || echo unknown)"
    if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
      TRUSTED_SYNC="1"
      FULL_SNAPSHOT="1"
    fi
  fi
fi

if [ "$TRUSTED_SYNC" = "1" ]; then
  CHANGED_FILES="$(git ls-files 2>/dev/null | paste -sd, -)"
  DELETED_FILES=""
fi

asm project-event --project-id "$PROJECT_ID" --repo-root "$REPO_ROOT" --event-type "$EVENT_TYPE" --source-rev "$SOURCE_REV" --changed-files "$CHANGED_FILES" --deleted-files "$DELETED_FILES" --trusted-sync "$TRUSTED_SYNC" --full-snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1 || true
`;
    writeFileSync(listenerPath, listener, 'utf8');
    chmodSync(listenerPath, 0o755);

    const attachHook = (name: string, eventType: 'post_commit' | 'post_merge' | 'post_rewrite') => {
      const hookPath = resolve(hooksDir, name);
      const callLine = `${marker}\n\"${listenerPath}\" ${eventType} || true`;
      let content = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
      if (content.includes(marker)) return hookPath;

      if (!content.trim()) {
        content = `#!/bin/sh\n\n${callLine}\n`;
      } else {
        const backupPath = `${hookPath}.asm-backup`;
        if (!existsSync(backupPath)) writeFileSync(backupPath, content, 'utf8');
        if (!content.startsWith('#!')) {
          content = `#!/bin/sh\n${content}`;
        }
        if (!content.endsWith('\n')) content += '\n';
        content += `\n${callLine}\n`;
      }

      writeFileSync(hookPath, content, 'utf8');
      chmodSync(hookPath, 0o755);
      return hookPath;
    };

    const hooks = [
      attachHook('post-commit', 'post_commit'),
      attachHook('post-merge', 'post_merge'),
      attachHook('post-rewrite', 'post_rewrite'),
      listenerPath,
    ];
    return { installed: true, hooks };
  }

  private validateJiraTrackerFields(trackerSpaceKey?: string, defaultEpicKey?: string): void {
    const space = String(trackerSpaceKey || "").trim();
    if (!space) {
      throw new Error("jira tracker requires tracker_space_key");
    }

    if (!/^[A-Z][A-Z0-9_]*$/.test(space)) {
      throw new Error("jira tracker_space_key format is invalid");
    }

    const epic = String(defaultEpicKey || "").trim();
    if (epic) {
      const expectedPrefix = `${space}-`;
      if (!epic.toUpperCase().startsWith(expectedPrefix)) {
        throw new Error(`default_epic_key must match tracker_space_key prefix '${space}-*'`);
      }
    }
  }

  private tryResolveRepoRootFromCwd(): string | undefined {
    try {
      const output = execSync("git rev-parse --show-toplevel", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const value = String(output || "").trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private resolveWorkspaceRoot(req: CoreRequestEnvelope<unknown>): string {
    const candidates = [
      process.env.AGENT_MEMO_PROJECT_WORKSPACE_ROOT,
      process.env.AGENT_MEMO_REPO_CLONE_ROOT,
      process.env.PROJECT_WORKSPACE_ROOT,
      process.env.REPO_CLONE_ROOT,
      (req?.meta as any)?.projectWorkspaceRoot,
      (req?.context?.metadata as any)?.projectWorkspaceRoot,
      (req?.context?.metadata as any)?.workspaceRoot,
    ];

    for (const raw of candidates) {
      const value = String(raw || "").trim();
      if (!value) continue;
      const resolved = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
      try {
        mkdirSync(resolved, { recursive: true });
      } catch {
        // ignore and fallback
      }
      if (existsSync(resolved)) return resolved;
    }

    const sharedWorkspaceRoot = resolveAsmCoreProjectWorkspaceRoot({ env: process.env, homeDir: process.env.HOME });
    if (sharedWorkspaceRoot) {
      const resolved = isAbsolute(sharedWorkspaceRoot)
        ? resolve(sharedWorkspaceRoot)
        : resolve(process.cwd(), sharedWorkspaceRoot);
      try {
        mkdirSync(resolved, { recursive: true });
      } catch {
        // ignore and fallback
      }
      if (existsSync(resolved)) return resolved;
    }

    const fallback = resolve(process.env.HOME || process.cwd(), ".openclaw", "workspace", "projects");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  private resolveRepoForRegistration(
    scopeUserId: string,
    scopeAgentId: string,
    input: {
      explicitRepoRoot?: string;
      repoUrl?: string;
      workspaceRoot: string;
    },
  ): ResolvedRepoSelection {
    const notes: string[] = [];

    const explicitRepoRoot = this.normalizeRepoRootInput(input.explicitRepoRoot);
    if (explicitRepoRoot) {
      notes.push("repo_root provided explicitly by operator/request payload");
      return {
        repo_root: explicitRepoRoot,
        repo_remote: this.tryReadGitRemote(explicitRepoRoot) || input.repoUrl,
        resolution: "explicit_repo_root",
        clone_policy: "not_applicable",
        workspace_root: input.workspaceRoot,
        notes,
      };
    }

    const cwdRoot = this.tryResolveRepoRootFromCwd();
    const normalizedRepoUrl = this.normalizeRepoUrl(input.repoUrl);
    if (cwdRoot) {
      const cwdRemote = this.tryReadGitRemote(cwdRoot);
      const cwdMatchesRepoUrl = !normalizedRepoUrl || !cwdRemote || this.canonicalizeRemote(cwdRemote) === this.canonicalizeRemote(normalizedRepoUrl);
      if (cwdMatchesRepoUrl) {
        notes.push("resolved repo_root from current git working directory");
        return {
          repo_root: cwdRoot,
          repo_remote: cwdRemote || normalizedRepoUrl,
          resolution: "cwd_git_root",
          clone_policy: "not_applicable",
          workspace_root: input.workspaceRoot,
          notes,
        };
      }
      notes.push("current git root exists but remote does not match repo_url; skipped cwd reuse");
    }

    if (normalizedRepoUrl) {
      const registered = this.findRegisteredProjectByRemote(scopeUserId, scopeAgentId, normalizedRepoUrl);
      if (registered?.repo_root) {
        notes.push("matched existing registered project by repo remote; reusing repo_root");
        return {
          repo_root: registered.repo_root,
          repo_remote: registered.repo_remote_primary || normalizedRepoUrl,
          resolution: "registered_remote_match",
          clone_policy: "reuse_existing_clone",
          workspace_root: input.workspaceRoot,
          clone_target: registered.repo_root,
          notes,
        };
      }

      const imported = this.tryResolveLocalPathImport(normalizedRepoUrl, input.workspaceRoot);
      if (imported) {
        notes.push("repo_url points to a local path; imported without git clone");
        return {
          repo_root: imported,
          repo_remote: this.tryReadGitRemote(imported) || normalizedRepoUrl,
          resolution: "imported_local_path",
          clone_policy: "not_applicable",
          workspace_root: input.workspaceRoot,
          clone_target: imported,
          notes,
        };
      }

      const cloneAttempt = this.cloneOrReuseRepo(normalizedRepoUrl, input.workspaceRoot);
      notes.push(...cloneAttempt.notes);
      return {
        repo_root: cloneAttempt.repo_root,
        repo_remote: cloneAttempt.repo_remote,
        resolution: "cloned_from_repo_url",
        clone_policy: cloneAttempt.clone_policy,
        workspace_root: input.workspaceRoot,
        clone_target: cloneAttempt.clone_target,
        notes,
      };
    }

    notes.push("repo root unresolved: no explicit repo_root, not inside git repo, and no repo_url provided");
    return {
      repo_root: undefined,
      repo_remote: undefined,
      resolution: "repo_root_missing",
      clone_policy: "not_applicable",
      workspace_root: input.workspaceRoot,
      notes,
    };
  }

  private normalizeRepoRootInput(repoRoot?: string): string | undefined {
    const raw = String(repoRoot || "").trim();
    if (!raw) return undefined;
    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
    if (!existsSync(resolved)) return resolved;
    try {
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      // ignore
    }
    return resolved;
  }

  private normalizeRepoUrl(repoUrl?: string): string | undefined {
    const value = String(repoUrl || "").trim();
    return value || undefined;
  }

  private canonicalizeRemote(remote?: string): string | undefined {
    const value = String(remote || "").trim();
    if (!value) return undefined;
    if (value.startsWith("git@")) {
      const stripped = value.replace(/^git@/, "").replace(":", "/");
      return stripped.toLowerCase().replace(/\.git$/i, "");
    }
    return value
      .replace(/^https?:\/\//i, "")
      .replace(/^ssh:\/\//i, "")
      .toLowerCase()
      .replace(/\.git$/i, "");
  }

  private findRegisteredProjectByRemote(
    scopeUserId: string,
    scopeAgentId: string,
    repoUrl: string,
  ): { repo_root: string | null; repo_remote_primary: string | null } | null {
    const canonical = this.canonicalizeRemote(repoUrl);
    if (!canonical) return null;

    const projects = this.slotDb.listProjects(scopeUserId, scopeAgentId);
    for (const row of projects) {
      const remote = row.project.repo_remote_primary;
      if (!remote) continue;
      if (this.canonicalizeRemote(remote) === canonical) {
        return {
          repo_root: row.project.repo_root,
          repo_remote_primary: row.project.repo_remote_primary,
        };
      }
    }

    return null;
  }

  private deriveRepoFolderName(repoUrl: string): string {
    const cleaned = repoUrl.replace(/[#?].*$/, "").replace(/\/+$/, "");
    const base = cleaned.split(/[/:]/).pop() || "repo";
    const name = base.replace(/\.git$/i, "").trim() || "repo";
    return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "repo";
  }

  private tryResolveLocalPathImport(repoUrl: string, workspaceRoot: string): string | undefined {
    const looksLocal = repoUrl.startsWith("/") || repoUrl.startsWith("./") || repoUrl.startsWith("../") || repoUrl.startsWith("file://");
    if (!looksLocal) return undefined;

    const rawPath = repoUrl.startsWith("file://") ? repoUrl.slice("file://".length) : repoUrl;
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
    if (!existsSync(candidate)) return undefined;

    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private cloneOrReuseRepo(
    repoUrl: string,
    workspaceRoot: string,
  ): {
    repo_root: string;
    repo_remote: string;
    clone_policy: "reuse_existing_clone" | "cloned_new" | "cloned_to_conflict_suffix";
    clone_target: string;
    notes: string[];
  } {
    const notes: string[] = [];
    mkdirSync(workspaceRoot, { recursive: true });

    const folderName = this.deriveRepoFolderName(repoUrl);
    const preferredTarget = resolve(workspaceRoot, folderName);

    if (this.isMatchingExistingClone(preferredTarget, repoUrl)) {
      notes.push(`existing clone already present at ${preferredTarget}; reused`);
      return {
        repo_root: preferredTarget,
        repo_remote: this.tryReadGitRemote(preferredTarget) || repoUrl,
        clone_policy: "reuse_existing_clone",
        clone_target: preferredTarget,
        notes,
      };
    }

    if (!existsSync(preferredTarget)) {
      this.gitClone(repoUrl, preferredTarget);
      notes.push(`cloned repo_url into workspace root at ${preferredTarget}`);
      return {
        repo_root: preferredTarget,
        repo_remote: this.tryReadGitRemote(preferredTarget) || repoUrl,
        clone_policy: "cloned_new",
        clone_target: preferredTarget,
        notes,
      };
    }

    const conflictTarget = this.computeConflictCloneTarget(preferredTarget, repoUrl);
    this.gitClone(repoUrl, conflictTarget);
    notes.push(`preferred clone target occupied; cloned with suffix at ${conflictTarget}`);
    return {
      repo_root: conflictTarget,
      repo_remote: this.tryReadGitRemote(conflictTarget) || repoUrl,
      clone_policy: "cloned_to_conflict_suffix",
      clone_target: conflictTarget,
      notes,
    };
  }

  private computeConflictCloneTarget(preferredTarget: string, repoUrl: string): string {
    const canonical = this.canonicalizeRemote(repoUrl) || repoUrl;
    const digest = createHash("sha1").update(canonical).digest("hex").slice(0, 8);
    const parent = dirname(preferredTarget);
    const base = basename(preferredTarget);

    let candidate = resolve(parent, `${base}--${digest}`);
    let index = 1;
    while (existsSync(candidate)) {
      if (this.isMatchingExistingClone(candidate, repoUrl)) {
        return candidate;
      }
      candidate = resolve(parent, `${base}--${digest}-${index}`);
      index += 1;
    }
    return candidate;
  }

  private isMatchingExistingClone(targetDir: string, repoUrl: string): boolean {
    if (!existsSync(targetDir)) return false;
    try {
      if (!statSync(targetDir).isDirectory()) return false;
    } catch {
      return false;
    }

    if (!existsSync(resolve(targetDir, ".git"))) return false;

    const existingRemote = this.tryReadGitRemote(targetDir);
    if (!existingRemote) return false;

    return this.canonicalizeRemote(existingRemote) === this.canonicalizeRemote(repoUrl);
  }

  private gitClone(repoUrl: string, targetDir: string): void {
    execSync(`git clone ${shellEscape(repoUrl)} ${shellEscape(targetDir)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  }

  private tryReadGitRemote(repoRoot: string): string | undefined {
    try {
      const output = execSync("git remote get-url origin", {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const value = String(output || "").trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private collectGitTrackedPaths(repoRoot: string): Array<{
    relative_path: string;
    checksum: string;
    module?: string;
    language?: string;
    content?: string;
  }> {
    try {
      const output = execSync("git ls-files", {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const paths = String(output || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      return paths
        .filter((p) => !p.startsWith(".git/"))
        .map((relativePath) => {
          const ext = relativePath.includes(".") ? relativePath.split(".").pop() || "" : "";
          const abs = resolve(repoRoot, relativePath);
          let content: string | undefined;
          try {
            content = readFileSync(abs, "utf8");
          } catch {
            content = undefined;
          }
          return {
            relative_path: relativePath,
            checksum: content != null ? sha1(content) : `git:${relativePath}`,
            module: relativePath.split("/")[0] || undefined,
            language: ext || undefined,
            content,
          };
        });
    } catch {
      // fallback for non-git local import
      const files: string[] = [];
      const walk = (dir: string, prefix = "") => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const abs = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            walk(abs, rel);
            continue;
          }
          files.push(rel);
        }
      };

      try {
        walk(repoRoot);
      } catch {
        return [];
      }

      return files.map((relativePath) => {
        const abs = resolve(repoRoot, relativePath);
        let content: string | undefined;
        try {
          content = readFileSync(abs, "utf8");
        } catch {
          content = undefined;
        }
        return {
          relative_path: relativePath,
          checksum: content != null ? sha1(content) : `fs:${relativePath}`,
          module: relativePath.split("/")[0] || undefined,
          language: relativePath.includes(".") ? relativePath.split(".").pop() || undefined : undefined,
          content,
        };
      });
    }
  }

  private hydrateIndexPathsFromRepo(
    repoRoot: string | null | undefined,
    paths: Array<{
      relative_path: string;
      checksum?: string | null;
      module?: string | null;
      language?: string | null;
      content?: string | null;
    }>,
  ) {
    if (!repoRoot) return paths;
    return paths.map((item) => {
      const relativePath = String(item.relative_path || '').trim();
      if (!relativePath) return item;
      const abs = resolve(repoRoot, relativePath);
      let content = item.content;
      if ((content == null || content === '') && existsSync(abs)) {
        try {
          content = readFileSync(abs, 'utf8');
        } catch {
          content = item.content;
        }
      }
      const checksum = content != null && String(content).trim() !== ''
        ? sha1(String(content))
        : (item.checksum || null);
      return {
        ...item,
        checksum,
        content,
      };
    });
  }

  private handleProjectDeindex(payload: ProjectDeindexPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.deindex requires payload.project_id");
    }

    return this.slotDb.deindexProject(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      reason: payload.reason,
    });
  }

  private handleProjectDetach(payload: ProjectDetachPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref || {});

    return this.slotDb.detachProject(identity.userId, identity.agentId, {
      project_id: project.project_id,
      reason: payload.reason,
    });
  }

  private handleProjectUnregister(payload: ProjectUnregisterPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref || {});

    return this.slotDb.unregisterProject(identity.userId, identity.agentId, {
      project_id: project.project_id,
      confirm: payload.confirm,
      mode: payload.mode,
      reason: payload.reason,
    });
  }

  private handleProjectPurgePreview(payload: ProjectPurgePreviewPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref || {});

    return this.slotDb.purgePreviewProject(identity.userId, identity.agentId, {
      project_id: project.project_id,
    });
  }

  private handleProjectPurge(payload: ProjectPurgePayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, payload.project_ref || {});

    return this.slotDb.purgeProject(identity.userId, identity.agentId, {
      project_id: project.project_id,
      confirm: payload.confirm,
      reason: payload.reason,
    });
  }

  private handleProjectReindexDiff(payload: ProjectReindexDiffPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.reindex_diff requires payload.project_id");
    }

    return this.slotDb.reindexProjectByDiff(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      source_rev: payload.source_rev,
      trigger_type: payload.trigger_type,
      index_profile: payload.index_profile,
      full_snapshot: payload.full_snapshot === true,
      paths: payload.paths || [],
    });
  }

  private handleProjectIndexEvent(payload: ProjectIndexEventPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    if (!payload.project_id) {
      throw new Error("project.index_event requires payload.project_id");
    }

    const project = this.slotDb.getProjectById(identity.userId, identity.agentId, payload.project_id);
    if (!project || !project.repo_root) {
      throw new Error("project.index_event requires a registered project with repo_root");
    }

    const registeredRepoRoot = this.normalizeRepoRootInput(project.repo_root || undefined);
    const eventRepoRoot = this.normalizeRepoRootInput(payload.repo_root || undefined);
    if (eventRepoRoot && registeredRepoRoot && eventRepoRoot !== registeredRepoRoot) {
      throw new Error(`project.index_event repo_root mismatch: event='${eventRepoRoot}' registered='${registeredRepoRoot}'`);
    }

    const changedFiles = Array.from(new Set((payload.changed_files || []).map((x) => String(x || "").trim()).filter(Boolean)));
    const deletedFiles = Array.from(new Set((payload.deleted_files || []).map((x) => String(x || "").trim()).filter(Boolean)));
    const trustedSync = payload.trusted_sync === true;
    const fullSnapshot = payload.full_snapshot === true || trustedSync;

    const paths = changedFiles.map((relativePath) => {
      const abs = resolve(project.repo_root as string, relativePath);
      let content: string | null = null;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        content = null;
      }
      return {
        relative_path: relativePath,
        checksum: content != null && String(content).trim() !== '' ? sha1(String(content)) : `event:${relativePath}:${payload.source_rev || "unknown"}`,
        module: relativePath.split("/")[0] || undefined,
        language: relativePath.includes(".") ? relativePath.split(".").pop() || undefined : undefined,
        content,
      };
    });

    const reindex = this.slotDb.reindexProjectByDiff(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      source_rev: payload.source_rev || null,
      trigger_type: trustedSync ? "repair" : "incremental",
      index_profile: trustedSync ? "authoritative" : "default",
      full_snapshot: fullSnapshot,
      paths,
    });

    if (deletedFiles.length > 0) {
      const tombstoneAt = new Date().toISOString();
      for (const relativePath of deletedFiles) {
        this.slotDb.markProjectFileDeletedForEvent(identity.userId, identity.agentId, payload.project_id, relativePath, tombstoneAt);
      }
    }

    return {
      project_id: payload.project_id,
      event_type: payload.event_type || "manual",
      source_rev: payload.source_rev || null,
      trusted_sync: trustedSync,
      full_snapshot: fullSnapshot,
      changed_files: changedFiles,
      deleted_files: deletedFiles,
      reindex,
    };
  }

  private handleProjectInstallHooks(payload: ProjectInstallHooksPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    if (!payload.project_id) {
      throw new Error("project.install_hooks requires payload.project_id");
    }
    const project = this.slotDb.getProjectById(identity.userId, identity.agentId, payload.project_id);
    if (!project) {
      throw new Error("project.install_hooks requires a registered project");
    }
    return this.installProjectGitHooks(project.project_id, project.repo_root);
  }

  private handleProjectIndexWatchGet(payload: ProjectIndexWatchGetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.index_watch_get requires payload.project_id");
    }

    return this.slotDb.getProjectIndexWatchState(identity.userId, identity.agentId, payload.project_id);
  }

  private handleProjectTaskRegistryUpsert(payload: ProjectTaskRegistryUpsertPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.task_id || !payload.project_id || !payload.task_title) {
      throw new Error("project.task_registry_upsert requires payload.task_id, payload.project_id, payload.task_title");
    }

    return this.slotDb.upsertTaskRegistryRecord(identity.userId, identity.agentId, {
      task_id: payload.task_id,
      project_id: payload.project_id,
      task_title: payload.task_title,
      task_type: payload.task_type,
      task_status: payload.task_status,
      parent_task_id: payload.parent_task_id,
      related_task_ids: payload.related_task_ids || [],
      files_touched: payload.files_touched || [],
      symbols_touched: payload.symbols_touched || [],
      commit_refs: payload.commit_refs || [],
      diff_refs: payload.diff_refs || [],
      decision_notes: payload.decision_notes ?? null,
      tracker_issue_key: payload.tracker_issue_key ?? null,
    });
  }

  private handleProjectTaskLineageContext(payload: ProjectTaskLineageContextPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.task_lineage_context requires payload.project_id");
    }

    if (!payload.task_id && !payload.tracker_issue_key && !payload.task_title) {
      throw new Error("project.task_lineage_context requires one selector: task_id|tracker_issue_key|task_title");
    }

    return this.slotDb.getTaskLineageContext(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      task_id: payload.task_id,
      tracker_issue_key: payload.tracker_issue_key,
      task_title: payload.task_title,
      include_related: payload.include_related,
      include_parent_chain: payload.include_parent_chain,
    });
  }

  private handleProjectHybridSearch(payload: ProjectHybridSearchPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id || !payload.query) {
      throw new Error("project.hybrid_search requires payload.project_id and payload.query");
    }

    return this.slotDb.hybridSearchProjectContext(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      query: payload.query,
      limit: payload.limit,
      path_prefix: payload.path_prefix || [],
      module: payload.module || [],
      language: payload.language || [],
      task_id: payload.task_id || [],
      tracker_issue_key: payload.tracker_issue_key || [],
      task_context: payload.task_context,
    });
  }

  private handleProjectChangeOverlayQuery(
    payload: ProjectChangeOverlayQueryUseCasePayload,
    req: CoreRequestEnvelope<unknown>,
  ): ProjectChangeOverlayV1 {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.project_id) {
      throw new Error("project.change_overlay.query requires payload.project_id");
    }
    if (!payload.task_id && !payload.tracker_issue_key && !payload.task_title) {
      throw new Error("project.change_overlay.query requires one selector: task_id|tracker_issue_key|task_title");
    }

    const requestedFeature = payload.feature_key
      ? payload.feature_key
      : (payload.feature_name ? this.resolveFeatureKeyInput(undefined, payload.feature_name) : undefined);

    const result = this.slotDb.queryProjectChangeOverlay(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      task_id: payload.task_id,
      tracker_issue_key: payload.tracker_issue_key,
      task_title: payload.task_title,
      feature_key: requestedFeature,
      feature_name: payload.feature_name,
      include_related: payload.include_related,
      include_parent_chain: payload.include_parent_chain,
    });

    const baseEvidence: ProjectChangeOverlayEvidenceItem[] = [
      { type: "task", ref: result.focus.task_id, note: result.focus.task_title },
      ...(result.focus.tracker_issue_key
        ? [{ type: "tracker_issue" as const, ref: result.focus.tracker_issue_key }]
        : []),
      ...result.changed_files.map((file) => ({ type: "file" as const, ref: file })),
      ...result.related_symbols.slice(0, 20).map((symbol) => ({
        type: "symbol" as const,
        ref: symbol.symbol_fqn || symbol.symbol_name,
        note: symbol.relative_path,
      })),
      ...result.commit_refs.map((ref) => ({ type: "commit_ref" as const, ref })),
    ];

    const featurePackCandidates: FeaturePackKey[] = requestedFeature
      ? [requestedFeature]
      : [
          "project_onboarding_registration_indexing",
          "code_aware_retrieval",
          "heartbeat_health_runtime_integrity",
          "change_aware_impact",
          "post_entry_review_decision_support",
        ];

    const featurePackMatches: ProjectChangeOverlayFeaturePackMatch[] = [];
    for (const featureKey of featurePackCandidates) {
      let pack: FeaturePackV1 | null = null;
      try {
        pack = this.handleProjectFeaturePackGenerate(
          {
            project_id: result.project_id,
            feature_key: featureKey,
          },
          req,
        );
      } catch {
        // Optional mapping: skip packs without enough evidence/context for this project.
        continue;
      }

      const packEvidenceSet = new Set(
        (pack.evidence || []).map((item) => `${item.type}:${String(item.ref || "").toLowerCase()}`),
      );
      const matchedEvidence = baseEvidence.filter((item) =>
        packEvidenceSet.has(`${item.type}:${String(item.ref || "").toLowerCase()}`),
      );

      if (matchedEvidence.length === 0) {
        continue;
      }

      const trackerHit =
        Boolean(result.focus.tracker_issue_key) &&
        pack.evidence.some(
          (item) => item.type === "task" && String(item.ref || "") === String(result.focus.tracker_issue_key || ""),
        );
      const taskHit = pack.evidence.some(
        (item) => item.type === "task" && String(item.ref || "") === String(result.focus.task_id),
      );
      const commitHitCount = result.commit_refs.filter((ref) =>
        pack.related_commits.some((hint) => hint.toLowerCase().includes(String(ref || "").toLowerCase())),
      ).length;

      const overlapRatio = matchedEvidence.length / Math.max(baseEvidence.length, 1);
      const confidenceRaw =
        Math.min(1, overlapRatio * 0.75) +
        (trackerHit ? 0.12 : 0) +
        (taskHit ? 0.08 : 0) +
        Math.min(0.1, commitHitCount * 0.05);
      const confidence = Number(Math.min(1, confidenceRaw).toFixed(2));

      if (confidence < 0.25) {
        continue;
      }

      featurePackMatches.push({
        feature_key: featureKey,
        title: pack.title,
        confidence,
        matched_evidence: matchedEvidence.slice(0, 10),
        note: `matched ${matchedEvidence.length} evidence items`,
      });
    }

    featurePackMatches.sort((a, b) => b.confidence - a.confidence);

    const symbolsByPath = new Map<string, number>();
    for (const path of result.changed_files) {
      symbolsByPath.set(path, 0);
    }
    for (const symbol of result.related_symbols) {
      if (symbol.relative_path && symbolsByPath.has(symbol.relative_path)) {
        symbolsByPath.set(symbol.relative_path, Number(symbolsByPath.get(symbol.relative_path) || 0) + 1);
      }
    }

    const enrichedSymbols = result.related_symbols
      .map((symbol) => {
        const hasPath = Boolean(symbol.relative_path && result.changed_files.includes(symbol.relative_path));
        const pathDensity = hasPath
          ? Math.min(1, Number(symbolsByPath.get(symbol.relative_path || "") || 0) / 4)
          : 0;
        const name = String(symbol.symbol_name || "");
        const nameLower = name.toLowerCase();
        const symbolFromTask = result.focus.task_title
          .toLowerCase()
          .split(/[^a-z0-9_]+/)
          .filter((token) => token.length >= 3)
          .some((token) => nameLower.includes(token));

        const confidence = Number(
          Math.min(
            1,
            (symbol.source === "task_registry" ? 0.45 : 0.35) +
              (hasPath ? 0.25 : 0) +
              pathDensity * 0.2 +
              (symbolFromTask ? 0.1 : 0),
          ).toFixed(2),
        );

        return {
          ...symbol,
          confidence,
          evidence_refs: [
            ...(symbol.relative_path ? [`file:${symbol.relative_path}`] : []),
            ...(symbol.symbol_fqn ? [`symbol:${symbol.symbol_fqn}`] : [`symbol:${symbol.symbol_name}`]),
          ],
        };
      })
      .sort((a, b) => {
        const confidenceDiff = Number((b.confidence || 0) - (a.confidence || 0));
        if (confidenceDiff !== 0) return confidenceDiff;
        return String(a.symbol_name).localeCompare(String(b.symbol_name));
      });

    const confidence: ProjectChangeOverlayConfidence = {
      overall: Number(
        Math.min(
          1,
          (result.changed_files.length > 0 ? 0.3 : 0) +
            Math.min(0.25, result.related_symbols.length * 0.03) +
            Math.min(0.15, result.commit_refs.length * 0.05) +
            Math.min(0.3, featurePackMatches.length * 0.1),
        ).toFixed(2),
      ),
      signals: {
        changed_files: result.changed_files.length,
        related_symbols: result.related_symbols.length,
        commit_refs: result.commit_refs.length,
        feature_pack_matches: featurePackMatches.length,
      },
    };

    return {
      overlay_id: `change-overlay:${result.project_id}:${result.focus.task_id}${requestedFeature ? `:${requestedFeature}` : ""}`,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      selector: result.selector,
      recoverable: result.recoverable,
      project_id: result.project_id,
      focus: result.focus,
      changed_files: result.changed_files,
      related_symbols: enrichedSymbols,
      commit_refs: result.commit_refs,
      feature_packs: featurePackMatches,
      evidence: baseEvidence,
      confidence,
      generated_at: new Date().toISOString(),
      generator_version: "asm-94-slice3",
    };
  }

  private handleProjectLegacyBackfill(payload: ProjectLegacyBackfillPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    return this.slotDb.runLegacyCompatibilityBackfill(identity.userId, identity.agentId, {
      mode: payload.mode || "dry_run",
      only_project_ids: payload.only_project_ids || [],
      only_aliases: payload.only_aliases || [],
      force_registration_state: payload.force_registration_state === true,
      source: payload.source || "mixed",
    });
  }

  private handleProjectTelegramOnboarding(
    payload: ProjectTelegramOnboardingPayload,
    req: CoreRequestEnvelope<unknown>,
  ) {
    const mode = payload.mode || "preview";

    const workspaceRoot = this.normalizeRepoRootInput(payload.project_workspace_root) || this.resolveWorkspaceRoot(req);
    const draft = {
      command: String(payload.command || "").trim() || "/project",
      repo_url: String(payload.repo_url || "").trim(),
      project_alias: String(payload.project_alias || "").trim(),
      jira_space_key: String(payload.jira_space_key || "").trim().toUpperCase(),
      default_epic_key: String(payload.default_epic_key || "").trim().toUpperCase(),
      index_now: payload.index_now === true,
      project_name: String(payload.project_name || "").trim() || undefined,
      repo_root: String(payload.repo_root || "").trim() || undefined,
      active_version: String(payload.active_version || "").trim() || undefined,
      project_workspace_root: workspaceRoot,
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!draft.repo_url && !draft.repo_root) {
      errors.push("repo_url or repo_root is required");
    }

    if (!draft.project_alias) {
      warnings.push("project_alias is empty; alias should be confirmed before final commit");
    }

    if (draft.jira_space_key) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(draft.jira_space_key)) {
        errors.push("jira_space_key format is invalid");
      }

      if (draft.default_epic_key) {
        const expectedPrefix = `${draft.jira_space_key}-`;
        if (!draft.default_epic_key.startsWith(expectedPrefix)) {
          errors.push(`default_epic_key must match jira_space_key prefix '${draft.jira_space_key}-*'`);
        }
      }
    } else if (draft.default_epic_key) {
      errors.push("jira_space_key is required when default_epic_key is provided");
    }

    const selectionPreview = this.resolveRepoForRegistration(
      normalizePrivateIdentity(req.context).userId,
      normalizePrivateIdentity(req.context).agentId,
      {
        explicitRepoRoot: draft.repo_root,
        repoUrl: draft.repo_url || undefined,
        workspaceRoot,
      },
    );

    const summaryCard = {
      title: "Project onboarding preview",
      fields: {
        command: draft.command,
        repo_url: draft.repo_url || null,
        repo_root: selectionPreview.repo_root || null,
        project_alias: draft.project_alias || null,
        jira_space_key: draft.jira_space_key || null,
        default_epic_key: draft.default_epic_key || null,
        index_now: draft.index_now,
        project_workspace_root: workspaceRoot,
        repo_resolution: selectionPreview.resolution,
        clone_policy: selectionPreview.clone_policy || "not_applicable",
      },
      actions: ["confirm", "edit_alias", "edit_jira", "index_now", "cancel"],
      notes: selectionPreview.notes,
    };

    if (mode !== "confirm") {
      return {
        status: errors.length > 0 ? "validation_error" : "preview_ready",
        errors,
        warnings,
        summary_card: summaryCard,
        bridge_commands: {
          register: "project.register_command",
          link_tracker: "project.link_tracker",
          trigger_index: "project.trigger_index",
        },
      };
    }

    if (errors.length > 0) {
      return {
        status: "validation_error",
        errors,
        warnings,
        summary_card: summaryCard,
      };
    }

    const registerPayload: ProjectRegisterCommandPayload = {
      project_alias: draft.project_alias,
      project_name: draft.project_name,
      repo_root: draft.repo_root,
      repo_remote: draft.repo_url || undefined,
      repo_url: draft.repo_url || undefined,
      active_version: draft.active_version,
      options: {
        trigger_index: draft.index_now,
      },
      tracker: draft.jira_space_key
        ? {
            tracker_type: "jira",
            tracker_space_key: draft.jira_space_key,
            default_epic_key: draft.default_epic_key || undefined,
            active_version: draft.active_version,
          }
        : undefined,
    };

    const registered = this.handleProjectRegisterCommand(registerPayload, req);

    return {
      status: "committed",
      project_id: registered.project_id,
      project_alias: registered.project_alias,
      tracker_mapping: registered.tracker_mapping,
      repo_resolution: registered.repo_resolution,
      index_trigger: registered.index_trigger,
      warnings,
      used_commands: ["project.register_command", "project.link_tracker", "project.trigger_index"],
    };
  }

  private handleProjectFeaturePackGenerate(
    payload: ProjectFeaturePackGeneratePayload,
    req: CoreRequestEnvelope<unknown>,
  ): FeaturePackV1 {
    const identity = normalizePrivateIdentity(req.context);
    const featureKey = payload.feature_key || "project_onboarding_registration_indexing";

    const project = this.resolveProjectRef(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_alias: payload.project_alias,
    });

    const snapshot = this.slotDb.getProjectFeaturePackProjectOnboardingIndexingSnapshot(
      identity.userId,
      identity.agentId,
      project.project_id,
    );

    const primaryAlias =
      snapshot.aliases.find((item) => item.is_primary === 1)?.project_alias || payload.project_alias || project.project_name;

    switch (featureKey) {
      case "project_onboarding_registration_indexing":
        return this.buildProjectOnboardingRegistrationIndexingPack(snapshot, project.project_id, primaryAlias);
      case "code_aware_retrieval":
        return this.buildCodeAwareRetrievalPack(snapshot, project.project_id, primaryAlias);
      case "heartbeat_health_runtime_integrity":
        return this.buildHeartbeatHealthRuntimeIntegrityPack(snapshot, project.project_id, primaryAlias);
      case "change_aware_impact":
        return this.buildChangeAwareImpactPack(snapshot, project.project_id, primaryAlias);
      case "post_entry_review_decision_support":
        return this.buildPostEntryReviewDecisionSupportPack(snapshot, project.project_id, primaryAlias);
      default:
        throw new Error(`Unsupported feature_key: ${featureKey}`);
    }
  }

  private handleProjectFeaturePackQuery(
    payload: ProjectFeaturePackQueryPayload,
    req: CoreRequestEnvelope<unknown>,
  ): { project_id: string; project_alias: string | null; feature_key: FeaturePackKey; pack: FeaturePackV1 } {
    const identity = normalizePrivateIdentity(req.context);
    const project = this.resolveProjectRef(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_alias: payload.project_alias,
    });

    const requestedFeature = this.resolveFeatureKeyInput(payload.feature_key, payload.feature_name);

    const pack = this.handleProjectFeaturePackGenerate(
      {
        project_id: project.project_id,
        project_alias: payload.project_alias,
        feature_key: requestedFeature,
      },
      req,
    );

    return {
      project_id: project.project_id,
      project_alias: payload.project_alias || null,
      feature_key: requestedFeature,
      pack,
    };
  }

  private handleProjectDeveloperQuery(
    payload: ProjectDeveloperQueryPayload,
    req: CoreRequestEnvelope<unknown>,
  ): ProjectDeveloperQueryResponseV1 {
    const identity = normalizePrivateIdentity(req.context);
    const parsed = this.parseProjectDeveloperQueryPayload(payload);
    const query = parsed.query_text;

    const project = this.resolveProjectRef(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_alias: payload.project_alias,
    });

    const inferredIntent: ProjectDeveloperQueryIntent = parsed.legacy_intent;
    const retrievalPlan = this.buildDeveloperRetrievalPlan(parsed.canonical_intent, payload.limit, parsed);

    const queryFingerprint = createHash("sha1")
      .update(`${project.project_id}|${parsed.canonical_intent}|${query.toLowerCase()}`)
      .digest("hex")
      .slice(0, 16);
    const queryId = `pdevq:${queryFingerprint}`;
    const trackerIssueHint = parsed.tracker_issue_key || parsed.tracker_issue_keys?.[0] || query.match(/\b[A-Z][A-Z0-9_]+-\d+\b/)?.[0];

    const hybridTaskContext = retrievalPlan.use_task_context
      ? {
          tracker_issue_key: trackerIssueHint,
          task_id: parsed.task_id,
          task_title: parsed.task_title,
          include_related: true,
          include_parent_chain: inferredIntent === "trace_flow",
        }
      : undefined;

    let locate = this.handleProjectHybridSearch(
      {
        project_id: project.project_id,
        query,
        limit: retrievalPlan.locate_limit,
        debug: false,
        ...(hybridTaskContext ? { task_context: hybridTaskContext } : {}),
        ...(retrievalPlan.path_prefix_hint && retrievalPlan.path_prefix_hint.length > 0
          ? { path_prefix: retrievalPlan.path_prefix_hint }
          : {}),
      },
      req,
    );

    let locateFallbackUsed = false;
    if (locate.results.length === 0 && hybridTaskContext) {
      locate = this.handleProjectHybridSearch(
        {
          project_id: project.project_id,
          query,
          limit: retrievalPlan.locate_limit,
          debug: false,
          ...(retrievalPlan.path_prefix_hint && retrievalPlan.path_prefix_hint.length > 0
            ? { path_prefix: retrievalPlan.path_prefix_hint }
            : {}),
        },
        req,
      );
      locateFallbackUsed = true;
    }

    const topN = {
      primary_results: 12,
      files: 12,
      symbols: 16,
      snippets: 10,
      graph_paths: 8,
      change_context: 8,
      answer_points: 5,
    } as const;

    const sourceRank = retrievalPlan.source_priority.reduce<Record<DeveloperRetrievalSource, number>>(
      (acc, source, index) => {
        acc[source] = index;
        return acc;
      },
      {
        symbol_registry: 99,
        file_index_state: 99,
        chunk_registry: 99,
        task_registry: 99,
      },
    );

    const sourceBoostByPriority = retrievalPlan.source_priority.reduce<Record<DeveloperRetrievalSource, number>>(
      (acc, source, index) => {
        acc[source] = Math.max(0, 0.15 - index * 0.04);
        return acc;
      },
      {
        symbol_registry: 0,
        file_index_state: 0,
        chunk_registry: 0,
        task_registry: 0,
      },
    );

    const sortStringsStable = (values: string[]) => values.sort((a, b) => a.localeCompare(b));

    const locateScored = locate.results.map((item) => {
      const source = item.source as DeveloperRetrievalSource;
      const adjustedScore = Number((Number(item.score || 0) + (sourceBoostByPriority[source] || 0)).toFixed(4));
      return {
        ...item,
        adjusted_score: adjustedScore,
      };
    });

    const locateSorted = [...locateScored].sort((a, b) =>
      Number(b.adjusted_score || 0) - Number(a.adjusted_score || 0)
      || (sourceRank[a.source as DeveloperRetrievalSource] ?? 99) - (sourceRank[b.source as DeveloperRetrievalSource] ?? 99)
      || String(a.relative_path || "").localeCompare(String(b.relative_path || ""))
      || String(a.symbol_name || "").localeCompare(String(b.symbol_name || ""))
      || String(a.task_id || a.id).localeCompare(String(b.task_id || b.id)),
    );

    const locatePrimary: ProjectDeveloperQueryPrimaryResult[] = locateSorted.map((item) => ({
      type:
        item.source === "file_index_state"
          ? "file"
          : item.source === "symbol_registry"
            ? "symbol"
            : item.source === "chunk_registry"
              ? "chunk"
              : "task",
      id: item.id,
      title: item.symbol_name
        ? `${item.symbol_name}${item.relative_path ? ` (${item.relative_path})` : ""}`
        : item.relative_path || item.task_title || item.id,
      score: item.adjusted_score,
      relative_path: item.relative_path,
      symbol_name: item.symbol_name,
      snippet: item.snippet,
    }));

    const requestedFeature = this.pickFeatureKeyForIntent(
      inferredIntent,
      parsed.feature_key || payload.feature_key,
      payload.feature_name,
      query,
    );
    const shouldAttachFeaturePack =
      retrievalPlan.attach_feature_pack
      || Boolean(parsed.feature_key || payload.feature_key || payload.feature_name);

    let featurePacks: FeaturePackV1[] = [];
    if (shouldAttachFeaturePack && requestedFeature) {
      try {
        const featureQuery = this.handleProjectFeaturePackQuery(
          {
            project_id: project.project_id,
            feature_key: requestedFeature,
          },
          req,
        );
        featurePacks = [featureQuery.pack];
      } catch {
        featurePacks = [];
      }
    }

    const overlaySelector = this.pickOverlaySelectorFromLocate(locate.results, parsed);
    let overlay: ProjectChangeOverlayV1 | null = null;
    if (retrievalPlan.attach_overlay && (overlaySelector.task_id || overlaySelector.tracker_issue_key)) {
      try {
        overlay = this.handleProjectChangeOverlayQuery(
          {
            project_id: project.project_id,
            task_id: overlaySelector.task_id,
            tracker_issue_key: overlaySelector.tracker_issue_key,
            feature_key: requestedFeature || undefined,
            include_related: true,
            include_parent_chain: true,
          },
          req,
        );
      } catch {
        overlay = null;
      }
    }

    const featurePrimary: ProjectDeveloperQueryPrimaryResult[] = featurePacks
      .map((pack): ProjectDeveloperQueryPrimaryResult => ({
        type: "feature_pack",
        id: pack.pack_id,
        title: pack.title,
        score: 1,
        snippet: pack.summary,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const overlaySymbolPrimary: ProjectDeveloperQueryPrimaryResult[] =
      parsed.canonical_intent === "change_lookup"
        ? [...(overlay?.related_symbols || [])]
            .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)
              || String(a.relative_path || "").localeCompare(String(b.relative_path || ""))
              || String(a.symbol_name || "").localeCompare(String(b.symbol_name || "")))
            .slice(0, 3)
            .map((symbol) => ({
              type: "symbol" as const,
              id: symbol.symbol_fqn || symbol.symbol_name,
              title: `${symbol.symbol_name}${symbol.relative_path ? ` (${symbol.relative_path})` : ""}`,
              score: symbol.confidence,
              relative_path: symbol.relative_path,
              symbol_name: symbol.symbol_name,
            }))
        : [];

    const mergedPrimaryCandidates = [
      ...(retrievalPlan.prefer_feature_primary ? featurePrimary : []),
      ...overlaySymbolPrimary,
      ...locatePrimary,
      ...(!retrievalPlan.prefer_feature_primary ? featurePrimary : []),
    ];

    const mergedPrimaryDeduped = Array.from(
      new Map(
        mergedPrimaryCandidates.map((item) => {
          const key = `${item.type}:${item.id}`;
          return [key, item] as const;
        }),
      ).values(),
    );

    const mergedPrimary = mergedPrimaryDeduped
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)
        || String(a.type).localeCompare(String(b.type))
        || String(a.relative_path || "").localeCompare(String(b.relative_path || ""))
        || String(a.title).localeCompare(String(b.title)))
      .slice(0, topN.primary_results);

    const files = sortStringsStable(Array.from(
      new Set([
        ...locateSorted.map((item) => item.relative_path).filter(Boolean) as string[],
        ...(overlay?.changed_files || []),
        ...featurePacks.flatMap((pack) => pack.primary_files || []),
      ]),
    )).slice(0, topN.files);

    const symbols = sortStringsStable(Array.from(
      new Set([
        ...locateSorted.map((item) => item.symbol_name).filter(Boolean) as string[],
        ...(overlay?.related_symbols || []).map((item) => item.symbol_fqn || item.symbol_name).filter(Boolean) as string[],
        ...featurePacks.flatMap((pack) => pack.primary_symbols || []),
      ]),
    )).slice(0, topN.symbols);

    const snippets = sortStringsStable(Array.from(
      new Set([
        ...locateSorted.map((item) => String(item.snippet || "").trim()).filter(Boolean),
        ...featurePacks.map((pack) => pack.summary).filter(Boolean),
        ...(overlay
          ? [
              `overlay focus ${overlay.focus.task_id}${overlay.focus.tracker_issue_key ? ` (${overlay.focus.tracker_issue_key})` : ""}`,
              ...overlay.feature_packs.slice(0, 2).map((pack) => `${pack.feature_key}: ${pack.note || "overlay match"}`),
            ]
          : []),
      ]),
    )).slice(0, topN.snippets);

    const graphPaths = sortStringsStable(overlay
      ? Array.from(new Set(
        overlay.related_symbols
          .map((item) => `${item.relative_path || "unknown"}::${item.symbol_fqn || item.symbol_name}`),
      ))
      : []).slice(0, topN.graph_paths);

    const changeContext = sortStringsStable(Array.from(
      new Set([
        ...locateSorted
          .map((item) => item.task_id || item.tracker_issue_key)
          .filter((value): value is string => Boolean(value)),
        ...(overlay ? [overlay.focus.task_id, ...(overlay.focus.tracker_issue_key ? [overlay.focus.tracker_issue_key] : [])] : []),
        ...featurePacks.flatMap((pack) => pack.related_tasks || []),
      ]),
    )).slice(0, topN.change_context);

    const assemblySources = Array.from(
      new Set([
        ...(files.length > 0 ? (["file"] as const) : []),
        ...(symbols.length > 0 ? (["symbol"] as const) : []),
        ...(featurePacks.length > 0 ? (["feature_pack"] as const) : []),
        ...(overlay ? (["change_overlay"] as const) : []),
      ]),
    ).sort((a, b) => a.localeCompare(b));

    const confidenceOverall = Number(
      Math.min(
        0.97,
        (locate.results.length > 0 ? 0.45 : 0.1)
          + (featurePacks.length > 0 ? 0.2 : 0)
          + (overlay ? 0.2 : 0)
          + (parsed.canonical_intent === "change_lookup" && overlay ? 0.07 : 0)
          + (inferredIntent === "trace_flow" && !locateFallbackUsed ? 0.03 : 0)
          + Math.min(0.07, snippets.length * 0.01),
      ).toFixed(2),
    );

    const confidenceReasonParts: string[] = [];
    confidenceReasonParts.push(`intent=${inferredIntent}`);
    confidenceReasonParts.push(`locate_hits=${locate.results.length}`);
    confidenceReasonParts.push(`plan=${retrievalPlan.plan_key}`);
    if (featurePacks.length > 0) confidenceReasonParts.push(`feature_pack=${featurePacks[0].feature_key}`);
    if (overlay) confidenceReasonParts.push(`overlay_focus=${overlay.focus.task_id}`);
    if (locateFallbackUsed) confidenceReasonParts.push("trace_task_context_fallback=true");

    const whyThisResult = [
      "resolved via project.hybrid_search",
      `retrieval plan ${retrievalPlan.plan_key} source priority: ${retrievalPlan.source_priority.join(" > ")}`,
      ...(hybridTaskContext ? ["intent-aware task_context applied"] : []),
      ...(retrievalPlan.path_prefix_hint && retrievalPlan.path_prefix_hint.length > 0
        ? [`path_prefix hint: ${retrievalPlan.path_prefix_hint.join(", ")}`]
        : []),
      ...(featurePacks.length > 0 ? ["enriched via project.feature_pack.query"] : []),
      ...(overlay ? ["enriched via project.change_overlay.query"] : []),
      `result_count=${locate.count}`,
      "stable ordering: score desc -> source/path/title",
      "dedup key: primary(type:id), lists via set",
    ];

    const answerTemplate =
      parsed.canonical_intent === "locate_symbol" || parsed.canonical_intent === "locate_file"
        ? "locate"
        : parsed.canonical_intent === "feature_lookup"
          ? "feature_understanding"
          : "generic";

    const answerSummary = answerTemplate === "locate"
      ? `Located ${mergedPrimary.length} candidate result(s) for '${query}' in project ${project.project_id}.`
      : answerTemplate === "feature_understanding"
        ? `Feature understanding assembled for '${query}' with ${featurePacks.length} feature pack(s).`
        : `Developer query '${query}' resolved with ${assemblySources.length} assembly source(s).`;

    const answerPoints = (answerTemplate === "locate"
      ? [
          mergedPrimary[0] ? `Top hit: ${mergedPrimary[0].title}` : "Top hit: none",
          files.length > 0 ? `Files: ${files.slice(0, 3).join(", ")}` : "Files: none",
          symbols.length > 0 ? `Symbols: ${symbols.slice(0, 3).join(", ")}` : "Symbols: none",
          `Assembly sources: ${assemblySources.join(", ") || "none"}`,
        ]
      : answerTemplate === "feature_understanding"
        ? [
            featurePacks[0] ? `Feature pack: ${featurePacks[0].title}` : "Feature pack: none",
            featurePacks[0]?.summary ? `Summary: ${featurePacks[0].summary}` : "Summary: none",
            featurePacks[0]?.primary_files?.length ? `Primary files: ${featurePacks[0].primary_files.slice(0, 3).join(", ")}` : "Primary files: none",
            featurePacks[0]?.primary_symbols?.length ? `Primary symbols: ${featurePacks[0].primary_symbols.slice(0, 3).join(", ")}` : "Primary symbols: none",
          ]
        : [
            `Intent: ${inferredIntent}`,
            `Top result: ${mergedPrimary[0]?.title || "none"}`,
            `Assembly sources: ${assemblySources.join(", ") || "none"}`,
          ])
      .slice(0, topN.answer_points);

    return {
      query_id: queryId,
      intent: inferredIntent,
      project_id: project.project_id,
      project_alias: payload.project_alias || null,
      query,
      primary_results: mergedPrimary,
      files,
      symbols,
      snippets,
      graph_paths: graphPaths,
      feature_packs: featurePacks,
      change_context: changeContext,
      assembly_sources: assemblySources,
      answer_template: answerTemplate,
      answer_summary: answerSummary,
      answer_points: answerPoints,
      explainability: {
        ranking_rules: [
          "typed query parser maps query -> canonical intent/selectors deterministically",
          `retrieval plan ${retrievalPlan.plan_key} applies source priority ${retrievalPlan.source_priority.join(" > ")}`,
          "primary_results sorted by score desc, then type/path/title",
          "files/symbols/snippets/graph_paths/change_context sorted lexicographically",
          "hybrid locate candidates pre-sorted by score/source/path/symbol/task",
        ],
        top_n: topN,
        evidence_counts: {
          locate_hits: locate.results.length,
          feature_pack_hits: featurePacks.length,
          overlay_changed_files: overlay?.changed_files.length || 0,
          overlay_related_symbols: overlay?.related_symbols.length || 0,
        },
        dedup: {
          primary_results: true,
          files: true,
          symbols: true,
          snippets: true,
          graph_paths: true,
          change_context: true,
        },
        fallbacks: [
          ...(locateFallbackUsed ? ["trace_task_context_fallback=true"] : []),
          ...(featurePacks.length === 0 && shouldAttachFeaturePack ? ["feature_pack_unavailable_or_unresolved"] : []),
          ...(overlay === null && retrievalPlan.attach_overlay ? ["overlay_unavailable_or_unresolved"] : []),
        ],
      },
      confidence: {
        overall: confidenceOverall,
        reason: confidenceReasonParts.join("; ") || "minimal evidence",
      },
      why_this_result: whyThisResult,
      generated_at: new Date().toISOString(),
      generator_version: "asm-109-slice8",
    };
  }

  private buildDeveloperRetrievalPlan(
    intent: ProjectDeveloperQueryCanonicalIntent,
    requestedLimit: number | undefined,
    parsed: ProjectDeveloperQueryParsed,
  ): ProjectDeveloperRetrievalPlan {
    const locateLimit = Math.min(Math.max(Number(requestedLimit || 8), 1), 20);

    if (intent === "locate_symbol") {
      return {
        plan_key: "locate_symbol",
        source_priority: ["symbol_registry", "chunk_registry", "file_index_state", "task_registry"],
        locate_limit: locateLimit,
        use_task_context: false,
        attach_feature_pack: false,
        attach_overlay: false,
        prefer_feature_primary: false,
      };
    }

    if (intent === "locate_file") {
      return {
        plan_key: "locate_file",
        source_priority: ["file_index_state", "chunk_registry", "symbol_registry", "task_registry"],
        locate_limit: locateLimit,
        use_task_context: false,
        attach_feature_pack: false,
        attach_overlay: false,
        prefer_feature_primary: false,
        path_prefix_hint: this.buildLocatePathPrefixHint(parsed.relative_path || parsed.query_text),
      };
    }

    if (intent === "feature_lookup") {
      return {
        plan_key: "feature_lookup",
        source_priority: ["symbol_registry", "file_index_state", "task_registry", "chunk_registry"],
        locate_limit: Math.min(locateLimit, 12),
        use_task_context: false,
        attach_feature_pack: true,
        attach_overlay: false,
        prefer_feature_primary: true,
      };
    }

    return {
      plan_key: "change_lookup",
      source_priority: ["task_registry", "symbol_registry", "file_index_state", "chunk_registry"],
      locate_limit: locateLimit,
      use_task_context: true,
      attach_feature_pack: true,
      attach_overlay: true,
      prefer_feature_primary: false,
    };
  }

  private buildLocatePathPrefixHint(rawPath: string): string[] | undefined {
    const normalized = String(rawPath || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || !normalized.includes("/")) return undefined;

    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) return undefined;

    const hints = [normalized];
    if (segments.length > 1) {
      hints.push(segments.slice(0, -1).join("/"));
    }
    hints.push(segments[0]);

    return Array.from(new Set(hints)).filter(Boolean);
  }

  private parseProjectDeveloperQueryPayload(payload: ProjectDeveloperQueryPayload): ProjectDeveloperQueryParsed {
    const explicitIntent = payload.intent;
    const query = String(payload.query || "").trim();
    const symbolName = String(payload.symbol_name || "").trim();
    const relativePath = String(payload.relative_path || "").trim();
    const routePath = String(payload.route_path || "").trim();
    const trackerIssueKey = String(payload.tracker_issue_key || "").trim();
    const taskId = String(payload.task_id || "").trim();
    const taskTitle = String(payload.task_title || "").trim();
    const trackerIssueKeys = this.extractTrackerIssueKeys(query);
    const taskIds = this.extractTaskIds(query);
    const routePaths = this.extractRoutePaths(query);
    const inferredFeatureKey = this.extractFeatureKeyFromQuery(query);

    const canonicalFromExplicit: Record<ProjectDeveloperQueryIntent, ProjectDeveloperQueryCanonicalIntent> = {
      locate_symbol: "locate_symbol",
      locate_file: "locate_file",
      feature_lookup: "feature_lookup",
      change_lookup: "change_lookup",
      locate: "locate_symbol",
      trace_flow: "change_lookup",
      impact: "change_lookup",
      impact_analysis: "change_lookup",
      change_aware_lookup: "change_lookup",
      feature_understanding: "feature_lookup",
    };

    const canonical_intent = explicitIntent
      ? canonicalFromExplicit[explicitIntent]
      : this.inferCanonicalIntentFromQuery({
          query,
          symbolName,
          relativePath,
          routePath: routePath || routePaths[0],
          trackerIssueKey: trackerIssueKey || trackerIssueKeys[0],
          taskId: taskId || taskIds[0],
          taskTitle,
          hasFeatureSelector: Boolean(payload.feature_key || payload.feature_name),
        });

    const explicitLegacyIntents: ProjectDeveloperQueryIntent[] = [
      "locate",
      "trace_flow",
      "impact",
      "impact_analysis",
      "change_aware_lookup",
      "feature_understanding",
    ];
    const legacy_intent: ProjectDeveloperQueryIntent =
      explicitIntent && explicitLegacyIntents.includes(explicitIntent)
        ? explicitIntent
        : (canonical_intent === "feature_lookup"
            ? "feature_understanding"
            : canonical_intent === "change_lookup"
              ? "change_aware_lookup"
              : "locate");

    const feature_key = payload.feature_key
      || (payload.feature_name ? this.tryResolveFeatureKeyInput(undefined, payload.feature_name) : null)
      || ((canonical_intent === "feature_lookup" && !query && inferredFeatureKey) ? inferredFeatureKey : null)
      || (canonical_intent === "change_lookup" ? "change_aware_impact" : undefined);

    const query_text = String(
      canonical_intent === "locate_symbol"
        ? (symbolName || query)
        : canonical_intent === "locate_file"
          ? (relativePath || query)
          : canonical_intent === "feature_lookup"
            ? (query || payload.feature_name || feature_key || "")
            : (query || trackerIssueKey || taskId || taskTitle || ""),
    ).trim();

    if (!query_text) {
      throw new Error("project.developer_query requires payload.query or deterministic selectors");
    }

    return {
      canonical_intent,
      legacy_intent,
      query_text,
      ...(symbolName ? { symbol_name: symbolName } : {}),
      ...(relativePath ? { relative_path: relativePath } : {}),
      ...((routePath || routePaths[0]) ? { route_path: routePath || routePaths[0] } : {}),
      ...(routePaths.length > 0 ? { route_paths: routePaths } : {}),
      ...((trackerIssueKey || trackerIssueKeys[0]) ? { tracker_issue_key: trackerIssueKey || trackerIssueKeys[0] } : {}),
      ...((taskId || taskIds[0]) ? { task_id: taskId || taskIds[0] } : {}),
      ...(taskTitle ? { task_title: taskTitle } : {}),
      ...(trackerIssueKeys.length > 0 ? { tracker_issue_keys: trackerIssueKeys } : {}),
      ...(taskIds.length > 0 ? { task_ids: taskIds } : {}),
      ...(feature_key ? { feature_key } : {}),
    };
  }

  private inferCanonicalIntentFromQuery(input: {
    query: string;
    symbolName?: string;
    relativePath?: string;
    routePath?: string;
    trackerIssueKey?: string;
    taskId?: string;
    taskTitle?: string;
    hasFeatureSelector: boolean;
  }): ProjectDeveloperQueryCanonicalIntent {
    if (input.symbolName) return "locate_symbol";
    if (input.trackerIssueKey || input.taskId || input.taskTitle) return "change_lookup";
    if (input.relativePath || input.routePath) return "locate_file";

    const lowered = input.query.toLowerCase();
    if (/what breaks if|blast radius|affected|impact|impact analysis|change-aware|change aware|overlay|lookup/.test(lowered)) {
      return "change_lookup";
    }
    if (/where does .* flow|trace|flow/.test(lowered)) {
      return "change_lookup";
    }
    if (/who handles|entrypoint for|where is .* implemented|route|endpoint|api\//.test(lowered)) {
      return "locate_file";
    }
    if (/file|path|\.tsx?|\.jsx?|\/src\//.test(lowered)) {
      return "locate_file";
    }
    if (input.hasFeatureSelector || this.extractFeatureKeyFromQuery(input.query)) {
      return "feature_lookup";
    }
    return "locate_symbol";
  }

  private pickFeatureKeyForIntent(
    intent: ProjectDeveloperQueryIntent,
    featureKey?: FeaturePackKey,
    featureName?: string,
    query?: string,
  ): FeaturePackKey | null {
    if (featureKey || featureName) {
      const resolved = this.tryResolveFeatureKeyInput(featureKey, featureName);
      if (resolved) return resolved;
    }

    if (intent === "impact" || intent === "impact_analysis" || intent === "change_aware_lookup" || intent === "change_lookup") {
      return "change_aware_impact";
    }

    if (intent === "feature_understanding" || intent === "feature_lookup") {
      if (query) return this.tryResolveFeatureKeyInput(undefined, query);
    }

    return null;
  }

  private tryResolveFeatureKeyInput(featureKey?: FeaturePackKey, featureName?: string): FeaturePackKey | null {
    try {
      return this.resolveFeatureKeyInput(featureKey, featureName);
    } catch {
      return null;
    }
  }

  private pickOverlaySelectorFromLocate(
    items: Array<{ task_id?: string; tracker_issue_key?: string | null }>,
    parsed?: ProjectDeveloperQueryParsed,
  ): { task_id?: string; tracker_issue_key?: string } {
    const firstTaskId = items.map((item) => item.task_id).find((value): value is string => Boolean(value));
    const firstIssue = items
      .map((item) => item.tracker_issue_key)
      .find((value): value is string => Boolean(value));

    return {
      task_id: parsed?.task_id || parsed?.task_ids?.[0] || firstTaskId,
      tracker_issue_key: parsed?.tracker_issue_key || parsed?.tracker_issue_keys?.[0] || firstIssue,
    };
  }

  private extractTrackerIssueKeys(query: string): string[] {
    const matches = String(query || "").match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) || [];
    return Array.from(new Set(matches.map((item) => item.trim().toUpperCase()).filter(Boolean)));
  }

  private extractTaskIds(query: string): string[] {
    const matches = String(query || "").match(/\btask-[a-z0-9-]+\b/gi) || [];
    return Array.from(new Set(matches.map((item) => item.trim()).filter(Boolean)));
  }

  private extractRoutePaths(query: string): string[] {
    const matches = String(query || "").match(/\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?/g) || [];
    return Array.from(new Set(matches.map((item) => item.trim()).filter((item) => item.startsWith("/") && item.length >= 2)));
  }

  private extractFeatureKeyFromQuery(query: string): FeaturePackKey | null {
    const normalized = String(query || "").trim();
    if (!normalized) return null;
    return this.tryResolveFeatureKeyInput(undefined, normalized);
  }

  private resolveFeatureKeyInput(featureKey?: FeaturePackKey, featureName?: string): FeaturePackKey {
    if (featureKey) return featureKey;

    const raw = String(featureName || "").trim().toLowerCase();
    if (!raw) return "project_onboarding_registration_indexing";

    if (FEATURE_PACK_KEYS.includes(raw as FeaturePackKey)) {
      return raw as FeaturePackKey;
    }

    const compact = raw.replace(/[^a-z0-9]+/g, " ").trim();
    const has = (token: string) => compact.includes(token);

    if ((has("onboarding") || has("registration") || has("index")) && !has("retrieval")) {
      return "project_onboarding_registration_indexing";
    }
    if (has("retrieval") || has("code aware") || has("hybrid")) {
      return "code_aware_retrieval";
    }
    if (has("heartbeat") || has("health") || has("integrity") || has("runtime")) {
      return "heartbeat_health_runtime_integrity";
    }
    if (has("impact") || has("change aware") || has("change")) {
      return "change_aware_impact";
    }
    if (has("post entry") || has("post-entry") || has("review") || has("decision")) {
      return "post_entry_review_decision_support";
    }

    throw new Error(
      `Unsupported feature selector '${featureName}'. Supported keys: ${FEATURE_PACK_KEYS.join(", ")}`,
    );
  }

  private buildProjectOnboardingRegistrationIndexingPack(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    projectId: string,
    primaryAlias: string,
  ): FeaturePackV1 {
    const latestRun = snapshot.recent_index_runs[0] || null;

    const primaryFiles = Array.from(
      new Set(
        [
          "src/commands/telegram-addproject-command.ts",
          "src/tools/project-tools.ts",
          "src/core/usecases/default-memory-usecase-port.ts",
          ...snapshot.recent_files.map((item) => item.relative_path),
        ].filter(Boolean),
      ),
    ).slice(0, 12);

    const primarySymbols = this.rankPrimarySymbols(snapshot, [
      "project.telegram_onboarding",
      "project.register_command",
      "project.link_tracker",
      "project.trigger_index",
      "project.reindex_diff",
      "registerTelegramAddProjectCommand",
      "registerProjectTools",
      "handleProjectRegisterCommand",
      "handleProjectTriggerIndex",
    ]);

    return {
      pack_id: `feature-pack:project_onboarding_registration_indexing:${projectId}`,
      title: "Project onboarding / registration / indexing",
      feature_key: "project_onboarding_registration_indexing",
      summary:
        `Covers the cross-agent project setup flow from /project onboarding through registry persistence, optional tracker linking, and index/reindex execution for project '${primaryAlias}'.`,
      primary_files: primaryFiles,
      primary_symbols: primarySymbols,
      flow_steps: [
        {
          step: 1,
          title: "Operator enters onboarding",
          details: "Telegram /project command and project onboarding helper collect repo, alias, Jira, and index-now intent.",
          related_files: ["src/commands/telegram-addproject-command.ts", "src/tools/project-tools.ts"],
          related_symbols: ["registerTelegramAddProjectCommand", "project.telegram_onboarding"],
        },
        {
          step: 2,
          title: "Registration command resolves repo and persists registry state",
          details: `project.register_command normalizes alias '${primaryAlias}', resolves repo root/remote, writes project + alias + registration state, and can attach tracker mapping.`,
          related_files: ["src/core/usecases/default-memory-usecase-port.ts", "src/db/slot-db.ts"],
          related_symbols: ["handleProjectRegisterCommand", "project.register_command"],
        },
        {
          step: 3,
          title: "Tracker linking enriches project identity",
          details: "jira/github/other mapping is stored in project tracker mappings so later agents can navigate issue space consistently.",
          related_files: ["src/core/usecases/default-memory-usecase-port.ts", "src/tools/project-tools.ts"],
          related_symbols: ["handleProjectLinkTracker", "project.link_tracker"],
        },
        {
          step: 4,
          title: "Index bootstrap or reindex updates searchable project context",
          details: `latest known index state is '${latestRun?.state || "not_yet_indexed"}' via ${latestRun?.trigger_type || "bootstrap/manual"} path; background trigger and diff reindex feed file/symbol/chunk registries.`,
          related_files: ["src/core/usecases/default-memory-usecase-port.ts", "src/db/slot-db.ts"],
          related_symbols: ["handleProjectTriggerIndex", "project.trigger_index", "project.reindex_diff"],
        },
      ],
      risk_points: [
        "Repo resolution can bind to wrong working tree if repo_root/repo_url selection is inconsistent.",
        "Invalid Jira space/default epic pairing blocks confirm flow.",
        "Index trigger may be accepted before concrete paths exist, so first pack consumers should inspect recent index run/watch state.",
      ],
      test_points: [
        "project.telegram_onboarding preview rejects invalid Jira mapping and returns summary card.",
        "project.register_command persists project, alias, registration, and optional tracker mapping.",
        "project.trigger_index or project.reindex_diff updates index_runs and file/symbol registries for the target project.",
      ],
      related_tasks: this.collectRelatedTasks(snapshot),
      related_commits: this.collectRelatedCommitHints(snapshot, ["register", "index", "onboarding"]),
      related_prs: [],
      evidence: this.buildEvidenceOrdered(snapshot, {
        includeRegistration: true,
        includeTracker: true,
        includeIndexRuns: 2,
        includeTasks: 4,
        includeFiles: 4,
        includeSymbols: 4,
      }),
      generated_at: new Date().toISOString(),
      generator_version: "asm-93-slice2",
    };
  }

  private buildCodeAwareRetrievalPack(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    projectId: string,
    primaryAlias: string,
  ): FeaturePackV1 {
    const primaryFiles = Array.from(
      new Set(
        [
          "src/db/slot-db.ts",
          "src/core/usecases/default-memory-usecase-port.ts",
          "src/tools/project-tools.ts",
          ...snapshot.recent_files.map((item) => item.relative_path),
        ].filter(Boolean),
      ),
    ).slice(0, 12);

    const primarySymbols = this.rankPrimarySymbols(snapshot, [
      "project.hybrid_search",
      "project.task_lineage_context",
      "graph.code.upsert",
      "graph.code.chain",
      "project.reindex_diff",
    ]);

    return {
      pack_id: `feature-pack:code_aware_retrieval:${projectId}`,
      title: "Code-aware retrieval",
      feature_key: "code_aware_retrieval",
      summary:
        `Covers retrieving actionable code context for project '${primaryAlias}' from indexed files/symbols/chunks/tasks with optional lineage expansion and code-graph traversal signals.`,
      primary_files: primaryFiles,
      primary_symbols: primarySymbols,
      flow_steps: [
        {
          step: 1,
          title: "Ingest/reindex populates retrieval registries",
          details: "project.reindex_diff writes file_index_state, symbol_registry, and chunk_registry with active entries for changed files.",
          related_files: ["src/db/slot-db.ts", "src/core/usecases/default-memory-usecase-port.ts"],
          related_symbols: ["project.reindex_diff", "handleProjectReindexDiff"],
        },
        {
          step: 2,
          title: "Task lineage context narrows retrieval intent",
          details: "project.task_lineage_context assembles focus task, parent chain, related tasks, and touched symbols/files before ranking.",
          related_files: ["src/db/slot-db.ts", "src/core/usecases/default-memory-usecase-port.ts"],
          related_symbols: ["project.task_lineage_context", "handleProjectTaskLineageContext"],
        },
        {
          step: 3,
          title: "Hybrid retrieval ranks candidates across registries",
          details: "project.hybrid_search blends file/symbol/chunk/task candidates and supports debug candidate buckets for conformance checks.",
          related_files: ["src/db/slot-db.ts", "src/tools/project-tools.ts"],
          related_symbols: ["project.hybrid_search", "handleProjectHybridSearch"],
        },
        {
          step: 4,
          title: "Code graph traversal augments symbol relations",
          details: "graph.code.upsert / graph.code.chain provide relation-level traversal for dependency/call chains when symbol-level context is needed.",
          related_files: ["src/core/usecases/default-memory-usecase-port.ts", "src/tools/graph-tools.ts"],
          related_symbols: ["graph.code.upsert", "graph.code.chain"],
        },
      ],
      risk_points: [
        "Hybrid retrieval quality depends on freshness of reindex runs and active symbol/chunk state.",
        "Weak or missing task metadata can reduce lineage-assisted ranking quality.",
      ],
      test_points: [
        "project.reindex_diff persists symbols/chunks for changed files.",
        "project.task_lineage_context returns parent/related context for known task ids.",
        "project.hybrid_search returns ranked results with debug buckets when requested.",
      ],
      related_tasks: this.collectRelatedTasks(snapshot),
      related_commits: this.collectRelatedCommitHints(snapshot, ["hybrid", "retrieval", "reindex", "graph", "symbol"]),
      related_prs: [],
      evidence: this.buildEvidenceOrdered(snapshot, {
        includeRegistration: false,
        includeTracker: false,
        includeIndexRuns: 2,
        includeTasks: 6,
        includeFiles: 6,
        includeSymbols: 8,
      }),
      generated_at: new Date().toISOString(),
      generator_version: "asm-93-slice2",
    };
  }

  private buildHeartbeatHealthRuntimeIntegrityPack(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    projectId: string,
    primaryAlias: string,
  ): FeaturePackV1 {
    const latestRun = snapshot.recent_index_runs[0] || null;

    return {
      pack_id: `feature-pack:heartbeat_health_runtime_integrity:${projectId}`,
      title: "Heartbeat / health / runtime integrity",
      feature_key: "heartbeat_health_runtime_integrity",
      summary:
        `Covers runtime integrity signals for project '${primaryAlias}' via registration validation state, tracker linkage consistency, and latest index run heartbeat evidence.`,
      primary_files: Array.from(
        new Set([
          "src/core/usecases/default-memory-usecase-port.ts",
          "src/db/slot-db.ts",
          "src/tools/project-tools.ts",
          ...snapshot.recent_files.map((item) => item.relative_path),
        ]),
      ).slice(0, 10),
      primary_symbols: this.rankPrimarySymbols(snapshot, [
        "project.get",
        "project.set_registration_state",
        "project.link_tracker",
        "project.trigger_index",
        "project.index_watch_get",
      ]),
      flow_steps: [
        {
          step: 1,
          title: "Registration lifecycle state is the control baseline",
          details: "project registration_status + validation_status represent current readiness and integrity posture.",
          related_files: ["src/db/slot-db.ts"],
          related_symbols: ["project.set_registration_state", "project.get"],
        },
        {
          step: 2,
          title: "Tracker mapping coherence is validated",
          details: "Jira/GitHub tracker mappings are validated and persisted, reducing cross-agent drift in runtime operations.",
          related_files: ["src/core/usecases/default-memory-usecase-port.ts"],
          related_symbols: ["project.link_tracker", "handleProjectLinkTracker"],
        },
        {
          step: 3,
          title: "Index runs provide heartbeat for data-plane readiness",
          details: `latest run is '${latestRun?.state || "none"}' (${latestRun?.trigger_type || "n/a"}); index_runs are used as runtime heartbeat checkpoints.`,
          related_files: ["src/db/slot-db.ts"],
          related_symbols: ["project.trigger_index", "project.index_watch_get"],
        },
      ],
      risk_points: [
        "No recent index run can indicate stale runtime context even if registration is valid.",
        "Validation status can be stale if lifecycle updates are not maintained after tracker/repo changes.",
      ],
      test_points: [
        "project.get exposes registration + tracker mapping state for an alias/project id.",
        "project.trigger_index updates index_runs and can be used as heartbeat signal.",
        "project.index_watch_get returns checksum/revision watch state for integrity checks.",
      ],
      related_tasks: this.collectRelatedTasks(snapshot),
      related_commits: this.collectRelatedCommitHints(snapshot, ["health", "integrity", "watch", "registration", "index"]),
      related_prs: [],
      evidence: this.buildEvidenceOrdered(snapshot, {
        includeRegistration: true,
        includeTracker: true,
        includeIndexRuns: 3,
        includeTasks: 3,
        includeFiles: 3,
        includeSymbols: 3,
      }),
      generated_at: new Date().toISOString(),
      generator_version: "asm-93-slice2",
    };
  }

  private buildChangeAwareImpactPack(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    projectId: string,
    primaryAlias: string,
  ): FeaturePackV1 {
    const latestRun = snapshot.recent_index_runs[0] || null;

    return {
      pack_id: `feature-pack:change_aware_impact:${projectId}`,
      title: "Change-aware impact",
      feature_key: "change_aware_impact",
      summary:
        `Covers impact-oriented flow for project '${primaryAlias}' where changed files/symbols are reindexed and then consumed by lineage/hybrid retrieval to estimate downstream effect scope.`,
      primary_files: Array.from(
        new Set([
          "src/db/slot-db.ts",
          "src/core/usecases/default-memory-usecase-port.ts",
          "src/tools/project-tools.ts",
          ...snapshot.recent_files.map((item) => item.relative_path),
        ]),
      ).slice(0, 12),
      primary_symbols: this.rankPrimarySymbols(snapshot, [
        "project.reindex_diff",
        "project.index_event",
        "project.index_watch_get",
        "project.task_registry_upsert",
        "project.task_lineage_context",
        "project.hybrid_search",
      ]),
      flow_steps: [
        {
          step: 1,
          title: "Diff/event ingestion captures changed paths",
          details: "project.reindex_diff (or project.index_event) accepts changed/deleted files and updates index/watch state.",
          related_files: ["src/db/slot-db.ts", "src/core/usecases/default-memory-usecase-port.ts"],
          related_symbols: ["project.reindex_diff", "project.index_event", "project.index_watch_get"],
        },
        {
          step: 2,
          title: "Task lineage stores declared impact hints",
          details: "project.task_registry_upsert tracks files_touched/symbols_touched/related tasks to enrich later impact analysis.",
          related_files: ["src/db/slot-db.ts"],
          related_symbols: ["project.task_registry_upsert", "project.task_lineage_context"],
        },
        {
          step: 3,
          title: "Hybrid retrieval assembles impact candidates",
          details: "project.hybrid_search combines changed files/symbols and lineage context to return practical impact candidates.",
          related_files: ["src/db/slot-db.ts", "src/tools/project-tools.ts"],
          related_symbols: ["project.hybrid_search"],
        },
      ],
      risk_points: [
        "Placeholder checksums or stale watch state can hide true file deltas.",
        "Impact accuracy depends on discipline in task_registry_upsert metadata quality.",
      ],
      test_points: [
        "project.reindex_diff updates file index and watch state for changed/deleted paths.",
        "project.task_registry_upsert captures files_touched and symbols_touched.",
        "project.hybrid_search can be constrained by task context for impact-oriented queries.",
      ],
      related_tasks: this.collectRelatedTasks(snapshot),
      related_commits: this.collectRelatedCommitHints(snapshot, ["reindex", "diff", "impact", "lineage", "watch"]),
      related_prs: [],
      evidence: this.buildEvidenceOrdered(snapshot, {
        includeRegistration: false,
        includeTracker: false,
        includeIndexRuns: 3,
        includeTasks: 6,
        includeFiles: 8,
        includeSymbols: 6,
      }),
      generated_at: new Date().toISOString(),
      generator_version: "asm-93-slice2",
    };
  }

  private buildPostEntryReviewDecisionSupportPack(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    projectId: string,
    primaryAlias: string,
  ): FeaturePackV1 {
    const keywordMatchers = ["post-entry", "post entry", "review", "decision", "outcome", "policy", "trace"];
    const matchingTasks = snapshot.recent_tasks.filter((task) => {
      const title = task.task_title.toLowerCase();
      return keywordMatchers.some((kw) => title.includes(kw));
    });
    const matchingSymbols = snapshot.recent_symbols.filter((symbol) => {
      const s = `${symbol.symbol_name} ${symbol.symbol_fqn}`.toLowerCase();
      return keywordMatchers.some((kw) => s.includes(kw));
    });

    if (matchingTasks.length === 0 && matchingSymbols.length === 0) {
      throw new Error(
        "feature_key post_entry_review_decision_support does not have enough indexed evidence yet (need task/symbol signals for post-entry/review/decision).",
      );
    }

    return {
      pack_id: `feature-pack:post_entry_review_decision_support:${projectId}`,
      title: "Post-entry review decision support",
      feature_key: "post_entry_review_decision_support",
      summary:
        `Covers post-entry decision support for project '${primaryAlias}' by prioritizing review/outcome evidence from task + symbol history and mapping it into retrieval-ready surfaces.`,
      primary_files: Array.from(
        new Set([
          ...matchingSymbols.map((item) => item.relative_path),
          ...snapshot.recent_files.map((item) => item.relative_path),
          "src/core/usecases/default-memory-usecase-port.ts",
          "src/db/slot-db.ts",
        ].filter(Boolean)),
      ).slice(0, 10),
      primary_symbols: this.rankPrimarySymbols(snapshot, [
        "project.task_registry_upsert",
        "project.task_lineage_context",
        "project.hybrid_search",
        ...matchingSymbols.map((item) => item.symbol_fqn || item.symbol_name),
      ]),
      flow_steps: [
        {
          step: 1,
          title: "Review/decision traces are captured in task metadata",
          details: "task_registry entries store decision_notes, task_status, tracker key, and touched files/symbols to preserve post-entry context.",
          related_files: ["src/db/slot-db.ts"],
          related_symbols: ["project.task_registry_upsert"],
        },
        {
          step: 2,
          title: "Lineage context reconstructs decision chain",
          details: "project.task_lineage_context can reconstruct parent/related chain to explain why a post-entry action was taken.",
          related_files: ["src/core/usecases/default-memory-usecase-port.ts"],
          related_symbols: ["project.task_lineage_context"],
        },
        {
          step: 3,
          title: "Hybrid retrieval surfaces decision-support evidence",
          details: "project.hybrid_search ranks symbols/files/tasks so agents can consume review evidence with minimal manual browsing.",
          related_files: ["src/db/slot-db.ts", "src/tools/project-tools.ts"],
          related_symbols: ["project.hybrid_search"],
        },
      ],
      risk_points: [
        "If task titles/notes do not contain explicit review/decision markers, this pack can become too weak.",
        "Without indexed symbols related to review/outcome logic, evidence may skew toward generic tasks.",
      ],
      test_points: [
        "project.task_registry_upsert stores decision-oriented metadata for review tasks.",
        "project.task_lineage_context returns parent/related chain for decision tasks.",
        "project.hybrid_search retrieves decision keywords from task/symbol/file registries.",
      ],
      related_tasks: Array.from(
        new Set(
          matchingTasks
            .flatMap((task) => [task.tracker_issue_key, task.task_id])
            .filter(Boolean) as string[],
        ),
      ).slice(0, 12),
      related_commits: this.collectRelatedCommitHints(snapshot, ["post-entry", "review", "decision", "outcome", "trace"]),
      related_prs: [],
      evidence: this.buildEvidenceOrdered(snapshot, {
        includeRegistration: false,
        includeTracker: false,
        includeIndexRuns: 2,
        includeTasks: 8,
        includeFiles: 6,
        includeSymbols: 8,
      }),
      generated_at: new Date().toISOString(),
      generator_version: "asm-93-slice2",
    };
  }

  private rankPrimarySymbols(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    preferred: string[],
  ): string[] {
    const snapshotSymbols = snapshot.recent_symbols.flatMap((item) => [item.symbol_fqn, item.symbol_name]);
    return Array.from(new Set([...preferred, ...snapshotSymbols].filter(Boolean))).slice(0, 16);
  }

  private collectRelatedTasks(snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>): string[] {
    return Array.from(
      new Set(
        snapshot.recent_tasks
          .flatMap((task) => [task.tracker_issue_key, task.task_id])
          .filter(Boolean) as string[],
      ),
    ).slice(0, 12);
  }

  private collectRelatedCommitHints(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    keywords: string[],
  ): string[] {
    const lowered = keywords.map((kw) => kw.toLowerCase());
    return Array.from(
      new Set(
        snapshot.recent_tasks
          .map((task) => {
            const title = task.task_title.toLowerCase();
            const hit = lowered.find((kw) => title.includes(kw));
            return hit ? `task:${hit.replace(/\s+/g, "-")}` : null;
          })
          .filter(Boolean) as string[],
      ),
    );
  }

  private buildEvidenceOrdered(
    snapshot: ReturnType<SlotDB["getProjectFeaturePackProjectOnboardingIndexingSnapshot"]>,
    options: {
      includeRegistration: boolean;
      includeTracker: boolean;
      includeIndexRuns: number;
      includeTasks: number;
      includeFiles: number;
      includeSymbols: number;
    },
  ): FeaturePackV1["evidence"] {
    const registrationState = snapshot.registration;
    const jiraMapping = snapshot.tracker_mappings.find((item) => item.tracker_type === "jira") || snapshot.tracker_mappings[0] || null;

    return [
      { type: "project", ref: snapshot.project.project_id, note: snapshot.project.project_name },
      ...snapshot.aliases.slice(0, 3).map((item) => ({ type: "project" as const, ref: item.project_alias, note: item.is_primary === 1 ? "primary_alias" : "alias" })),
      ...(options.includeRegistration && registrationState
        ? [{ type: "registration" as const, ref: registrationState.registration_status, note: registrationState.validation_status }]
        : []),
      ...(options.includeTracker && jiraMapping
        ? [{ type: "tracker" as const, ref: jiraMapping.tracker_type, note: jiraMapping.tracker_space_key || jiraMapping.default_epic_key || undefined }]
        : []),
      ...snapshot.recent_index_runs.slice(0, options.includeIndexRuns).map((item) => ({ type: "index" as const, ref: item.run_id, note: `${item.trigger_type}:${item.state}` })),
      ...snapshot.recent_tasks.slice(0, options.includeTasks).map((item) => ({ type: "task" as const, ref: item.tracker_issue_key || item.task_id, note: item.task_title })),
      ...snapshot.recent_files.slice(0, options.includeFiles).map((item) => ({ type: "file" as const, ref: item.relative_path })),
      ...snapshot.recent_symbols.slice(0, options.includeSymbols).map((item) => ({ type: "symbol" as const, ref: item.symbol_fqn || item.symbol_name, note: item.relative_path })),
    ];
  }

  private handleGraphEntityGet(payload: GraphEntityGetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (payload.id) {
      return this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.id);
    }

    return this.slotDb.graph.listEntities(identity.userId, identity.agentId, {
      type: payload.type,
      name: payload.name,
    });
  }

  private handleGraphEntitySet(payload: GraphEntitySetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.name || !payload.type) {
      throw new Error("graph.entity.set requires payload.name and payload.type");
    }

    if (payload.id) {
      const updated = this.slotDb.graph.updateEntity(identity.userId, identity.agentId, payload.id, {
        name: payload.name,
        type: payload.type,
        properties: payload.properties,
      });
      if (!updated) {
        throw new Error(`Entity with ID '${payload.id}' not found`);
      }
      return updated;
    }

    return this.slotDb.graph.createEntity(identity.userId, identity.agentId, {
      name: payload.name,
      type: payload.type,
      properties: payload.properties,
    });
  }

  private handleGraphRelAdd(payload: GraphRelAddPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.source_id || !payload.target_id || !payload.relation_type) {
      throw new Error("graph.rel.add requires source_id, target_id, relation_type");
    }

    const source = this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.source_id);
    if (!source) throw new Error(`Source entity '${payload.source_id}' not found`);

    const target = this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.target_id);
    if (!target) throw new Error(`Target entity '${payload.target_id}' not found`);

    return this.slotDb.graph.createRelationship(identity.userId, identity.agentId, {
      source_entity_id: payload.source_id,
      target_entity_id: payload.target_id,
      relation_type: payload.relation_type,
      weight: payload.weight,
      properties: payload.properties,
    });
  }

  private handleGraphRelRemove(payload: GraphRelRemovePayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (payload.id) {
      return { deleted: this.slotDb.graph.deleteRelationship(identity.userId, identity.agentId, payload.id) };
    }

    if (!payload.source_id || !payload.target_id || !payload.relation_type) {
      throw new Error("graph.rel.remove requires id OR source_id + target_id + relation_type");
    }

    const rels = this.slotDb.graph.getRelationships(identity.userId, identity.agentId, payload.source_id, "outgoing");
    const rel = rels.find(
      (item) => item.target_entity_id === payload.target_id && item.relation_type === payload.relation_type,
    );

    if (!rel) {
      return { deleted: false };
    }

    return { deleted: this.slotDb.graph.deleteRelationship(identity.userId, identity.agentId, rel.id) };
  }

  private async handleMemoryCapture(payload: Record<string, unknown>, req: CoreRequestEnvelope<unknown>) {
    if (!this.semanticUseCase) {
      throw new Error("memory.capture is not available: semantic runtime dependencies are not wired");
    }
    return this.semanticUseCase.capture(payload as any, req.context);
  }

  private async handleMemorySearch(payload: Record<string, unknown>, req: CoreRequestEnvelope<unknown>) {
    if (!this.semanticUseCase) {
      throw new Error("memory.search is not available: semantic runtime dependencies are not wired");
    }
    return this.semanticUseCase.search(payload as any, req.context);
  }

  private handleGraphSearch(payload: GraphSearchPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.entity_id) {
      throw new Error("graph.search requires entity_id");
    }

    const depth = Math.min(Math.max(payload.depth || 2, 1), 3);
    const traversed = this.slotDb.graph.traverseGraph(identity.userId, identity.agentId, payload.entity_id, depth);

    if (!payload.relation_type) {
      return traversed;
    }

    return {
      entities: traversed.entities,
      relationships: traversed.relationships.filter((rel) => rel.relation_type === payload.relation_type),
    };
  }

  private handleGraphCodeUpsert(payload: GraphCodeUpsertPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const relations = Array.isArray(payload.relations) ? payload.relations : [];

    if (nodes.length === 0) {
      throw new Error("graph.code.upsert requires non-empty nodes");
    }

    for (const node of nodes) {
      if (!node.node_id || !isUniversalGraphNodeType(node.node_type) || !node.name) {
        throw new Error("graph.code.upsert node invalid: require node_id, node_type, name");
      }
      upsertUniversalGraphNode(this.slotDb.graph, identity.userId, identity.agentId, node);
    }

    for (const relation of relations) {
      if (
        !relation.source_node_id ||
        !relation.target_node_id ||
        !isUniversalGraphRelationType(relation.relation_type) ||
        !isValidUniversalGraphProvenance(relation.provenance)
      ) {
        throw new Error("graph.code.upsert relation invalid: require source_node_id, target_node_id, relation_type, provenance");
      }

      const source = this.slotDb.graph.getEntity(identity.userId, identity.agentId, relation.source_node_id);
      if (!source) {
        throw new Error(`graph.code.upsert relation source '${relation.source_node_id}' not found`);
      }
      const target = this.slotDb.graph.getEntity(identity.userId, identity.agentId, relation.target_node_id);
      if (!target) {
        throw new Error(`graph.code.upsert relation target '${relation.target_node_id}' not found`);
      }

      upsertUniversalGraphRelation(this.slotDb.graph, identity.userId, identity.agentId, relation);
    }

    return {
      graph_model: UNIVERSAL_GRAPH_MODEL_VERSION,
      nodes_upserted: nodes.length,
      relations_upserted: relations.length,
    };
  }

  private handleGraphCodeChain(payload: GraphCodeChainPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);
    const nodeId = String(payload.node_id || "").trim();
    if (!nodeId) {
      throw new Error("graph.code.chain requires node_id");
    }

    const depth = Math.min(Math.max(payload.depth || 2, 1), 4);
    const traversed = this.slotDb.graph.traverseCodeGraph(
      identity.userId,
      identity.agentId,
      nodeId,
      depth,
      payload.relation_type,
    );

    const relationships = traversed.relationships;

    return {
      graph_model: UNIVERSAL_GRAPH_MODEL_VERSION,
      start_node_id: nodeId,
      depth,
      entities: traversed.entities,
      relationships,
    };
  }
}
