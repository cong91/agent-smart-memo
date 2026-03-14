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
  source_rev?: string | null;
  event_type?: "post_commit" | "post_merge" | "manual";
  changed_files?: string[];
  deleted_files?: string[];
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
      case "project.legacy_backfill":
        return this.handleProjectLegacyBackfill(payload as unknown as ProjectLegacyBackfillPayload, req) as TRes;
      case "project.telegram_onboarding":
        return this.handleProjectTelegramOnboarding(payload as unknown as ProjectTelegramOnboardingPayload, req) as TRes;
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

    const normalizedPaths = (payload.paths || []).filter((item) => String(item.relative_path || "").trim().length > 0);

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
        let paths = input.paths;
        if (paths.length === 0) {
          const project = this.slotDb.getProjectById(input.scopeUserId, input.scopeAgentId, input.projectId);
          if (project?.repo_root) {
            paths = this.collectGitTrackedPaths(project.repo_root);
          }
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
SOURCE_REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
CHANGED_FILES="$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | paste -sd, -)"
DELETED_FILES="$(git diff-tree --no-commit-id --name-only --diff-filter=D -r HEAD 2>/dev/null | paste -sd, -)"
asm project-event --project-id "$PROJECT_ID" --repo-root "$REPO_ROOT" --event-type "$1" --source-rev "$SOURCE_REV" --changed-files "$CHANGED_FILES" --deleted-files "$DELETED_FILES" >/dev/null 2>&1 || true
`;
    writeFileSync(listenerPath, listener, 'utf8');
    chmodSync(listenerPath, 0o755);

    const attachHook = (name: string, eventType: 'post_commit' | 'post_merge') => {
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

    const hooks = [attachHook('post-commit', 'post_commit'), attachHook('post-merge', 'post_merge'), listenerPath];
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
      (req?.meta as any)?.repoCloneRoot,
      (req?.context?.metadata as any)?.projectWorkspaceRoot,
      (req?.context?.metadata as any)?.repoCloneRoot,
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
            checksum: `git:${relativePath}`,
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
          checksum: `fs:${relativePath}`,
          module: relativePath.split("/")[0] || undefined,
          language: relativePath.includes(".") ? relativePath.split(".").pop() || undefined : undefined,
          content,
        };
      });
    }
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

    const changedFiles = Array.from(new Set((payload.changed_files || []).map((x) => String(x || "").trim()).filter(Boolean)));
    const deletedFiles = Array.from(new Set((payload.deleted_files || []).map((x) => String(x || "").trim()).filter(Boolean)));

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
        checksum: `event:${relativePath}:${payload.source_rev || "unknown"}`,
        module: relativePath.split("/")[0] || undefined,
        language: relativePath.includes(".") ? relativePath.split(".").pop() || undefined : undefined,
        content,
      };
    });

    const reindex = this.slotDb.reindexProjectByDiff(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      source_rev: payload.source_rev || null,
      trigger_type: "incremental",
      index_profile: "default",
      full_snapshot: false,
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
}
