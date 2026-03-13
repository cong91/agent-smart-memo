import type {
  CoreRequestEnvelope,
  MemoryUseCaseName,
  MemoryUseCasePort,
} from "../contracts/adapter-contracts.js";
import { execSync } from "node:child_process";
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
  paths?: Array<{
    relative_path: string;
    checksum?: string | null;
    module?: string | null;
    language?: string | null;
  }>;
  source_rev?: string | null;
  index_profile?: string;
}

interface ProjectReindexDiffPayload {
  project_id: string;
  source_rev?: string | null;
  trigger_type?: "bootstrap" | "incremental" | "manual" | "repair";
  index_profile?: string;
  paths?: Array<{
    relative_path: string;
    checksum?: string | null;
    module?: string | null;
    language?: string | null;
  }>;
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
      case "project.index_watch_get":
        return this.handleProjectIndexWatchGet(payload as unknown as ProjectIndexWatchGetPayload, req) as TRes;
      case "project.task_registry_upsert":
        return this.handleProjectTaskRegistryUpsert(payload as unknown as ProjectTaskRegistryUpsertPayload, req) as TRes;
      case "project.task_lineage_context":
        return this.handleProjectTaskLineageContext(payload as unknown as ProjectTaskLineageContextPayload, req) as TRes;
      case "project.hybrid_search":
        return this.handleProjectHybridSearch(payload as unknown as ProjectHybridSearchPayload, req) as TRes;
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

    const resolvedRepoRoot = payload.repo_root || this.tryResolveRepoRootFromCwd();

    const registered = this.slotDb.registerProject(identity.userId, identity.agentId, {
      project_id: payload.project_id,
      project_name: payload.project_name,
      project_alias: alias,
      repo_root: resolvedRepoRoot,
      repo_remote: payload.repo_remote,
      active_version: payload.active_version,
      allow_alias_update: payload.options?.allow_alias_update,
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
      enqueued: false,
      run_id: null,
      note: triggerRequested ? "code_light: no paths provided for immediate diff indexing" : null,
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
        enqueued: Boolean(triggerResult?.enqueued),
        run_id: triggerResult?.run_id || null,
        note: triggerResult?.note || null,
      };
    }

    return {
      project_id: registered.project.project_id,
      project_alias: registered.alias.project_alias,
      registration_status: registered.registration.registration_status,
      validation_status: registered.registration.validation_status,
      completeness_score: Number((registered.registration.completeness_score / 100).toFixed(2)),
      warnings: [],
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

    const normalizedPaths = (payload.paths || []).filter((item) => String(item.relative_path || "").trim().length > 0);
    if (normalizedPaths.length === 0) {
      return {
        project_id: project.project_id,
        accepted: true,
        enqueued: false,
        run_id: null,
        queued_at: new Date().toISOString(),
        note: "code_light: trigger accepted but no concrete paths supplied",
      };
    }

    const result = this.slotDb.reindexProjectByDiff(identity.userId, identity.agentId, {
      project_id: project.project_id,
      source_rev: payload.source_rev || null,
      trigger_type: payload.mode || "bootstrap",
      index_profile: payload.index_profile || "default",
      paths: normalizedPaths,
    });

    return {
      project_id: project.project_id,
      accepted: true,
      enqueued: true,
      run_id: result.run_id,
      queued_at: new Date().toISOString(),
      reason: payload.reason || "manual_trigger",
      diff_summary: {
        changed: result.changed.length,
        unchanged: result.unchanged.length,
        deleted: result.deleted.length,
      },
    };
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
      paths: payload.paths || [],
    });
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
