import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  configureOpenClawRuntime,
  createOpenClawResult,
  getMemoryUseCasePortForContext,
  getSessionKey,
  parseOpenClawSessionIdentity,
} from "../adapters/openclaw/tool-runtime.js";
import type { SemanticMemoryUseCase } from "../core/usecases/semantic-memory-usecase.js";

function createResult(text: string, isError = false) {
  return createOpenClawResult(text, isError);
}

export function registerProjectTools(
  api: OpenClawPluginApi,
  options?: {
    stateDir?: string;
    slotDbDir?: string;
    semanticUseCaseFactory?: (slotDbDir: string) => SemanticMemoryUseCase | undefined;
  },
): void {
  configureOpenClawRuntime(options);

  api.registerTool({
    name: "project_registry_register",
    label: "Project Registry Register",
    description:
      "Register project identity lifecycle in ASM v5.1. Creates/updates project_id-centric registry, alias mapping, and registration state.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Optional canonical project id. If omitted, system auto-generates." },
        project_name: { type: "string", description: "Optional display name for project." },
        project_alias: { type: "string", description: "Required human alias (unique within scope)." },
        repo_root: { type: "string", description: "Optional repo root path." },
        repo_remote: { type: "string", description: "Optional primary git remote URL." },
        active_version: { type: "string", description: "Optional active architecture/runtime version." },
        allow_alias_update: { type: "boolean", description: "Allow re-binding existing alias to another project_id." },
      },
      required: ["project_alias"],
    },
    async execute(
      _id: string,
      params: {
        project_id?: string;
        project_name?: string;
        project_alias: string;
        repo_root?: string;
        repo_remote?: string;
        active_version?: string;
        allow_alias_update?: boolean;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.register", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_registry_register",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_registry_get",
    label: "Project Registry Get",
    description: "Get project registry record by project_id or project_alias.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        project_alias: { type: "string" },
      },
    },
    async execute(_id: string, params: { project_id?: string; project_alias?: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.get", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_registry_get",
            requestId: _id,
          },
        });

        if (!data) {
          return createResult("No project registry record found.");
        }

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_registry_list",
    label: "Project Registry List",
    description: "List all registered projects and registration states in current scope.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_id: string, _params: {}, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<{}, any>("project.list", {
          context: { userId, agentId },
          payload: {},
          meta: {
            source: "openclaw",
            toolName: "project_registry_list",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_registration_state_set",
    label: "Project Registration State Set",
    description: "Update registration/validation state for a project registry identity.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        registration_status: { type: "string", enum: ["draft", "registered", "validated", "blocked"] },
        validation_status: { type: "string", enum: ["pending", "ok", "warn", "error"] },
        validation_notes: { type: "string" },
        completeness_score: { type: "number" },
        missing_required_fields: { type: "array", items: { type: "string" } },
        last_validated_at: { type: "string" },
      },
      required: [
        "project_id",
        "registration_status",
        "validation_status",
        "completeness_score",
        "missing_required_fields",
      ],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        registration_status: "draft" | "registered" | "validated" | "blocked";
        validation_status: "pending" | "ok" | "warn" | "error";
        validation_notes?: string;
        completeness_score: number;
        missing_required_fields: string[];
        last_validated_at?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.set_registration_state", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_registration_state_set",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_tracker_mapping_set",
    label: "Project Tracker Mapping Set",
    description: "Attach/update external tracker mapping (Jira/GitHub/other) for a registered project.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        tracker_type: { type: "string", enum: ["jira", "github", "other"] },
        tracker_space_key: { type: "string" },
        tracker_project_id: { type: "string" },
        default_epic_key: { type: "string" },
        board_key: { type: "string" },
        active_version: { type: "string" },
        external_project_url: { type: "string" },
      },
      required: ["project_id", "tracker_type"],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        tracker_type: "jira" | "github" | "other";
        tracker_space_key?: string;
        tracker_project_id?: string;
        default_epic_key?: string;
        board_key?: string;
        active_version?: string;
        external_project_url?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.set_tracker_mapping", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_tracker_mapping_set",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_reindex_diff",
    label: "Project Reindex Diff",
    description:
      "Run incremental reindex by diff/checksum and update watch state. Tracks changed/unchanged/deleted paths and updates index run lifecycle.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_rev: { type: "string" },
        trigger_type: { type: "string", enum: ["bootstrap", "incremental", "manual", "repair"] },
        index_profile: { type: "string" },
        paths: {
          type: "array",
          items: {
            type: "object",
            properties: {
              relative_path: { type: "string" },
              checksum: { type: "string" },
              module: { type: "string" },
              language: { type: "string" },
            },
            required: ["relative_path"],
          },
        },
      },
      required: ["project_id", "paths"],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        source_rev?: string;
        trigger_type?: "bootstrap" | "incremental" | "manual" | "repair";
        index_profile?: string;
        paths: Array<{
          relative_path: string;
          checksum?: string;
          module?: string;
          language?: string;
        }>;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.reindex_diff", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_reindex_diff",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_index_watch_get",
    label: "Project Index Watch Get",
    description: "Get current project index watch-state snapshot (last source rev + checksum map).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      required: ["project_id"],
    },
    async execute(_id: string, params: { project_id: string }, ctx: any) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.index_watch_get", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_index_watch_get",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_task_registry_upsert",
    label: "Project Task Registry Upsert",
    description:
      "Upsert task-lineage metadata for a project task (parent/related links, touched files/symbols, decisions, tracker key).",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        project_id: { type: "string" },
        task_title: { type: "string" },
        task_type: { type: "string" },
        task_status: { type: "string" },
        parent_task_id: { type: "string" },
        related_task_ids: { type: "array", items: { type: "string" } },
        files_touched: { type: "array", items: { type: "string" } },
        symbols_touched: { type: "array", items: { type: "string" } },
        commit_refs: { type: "array", items: { type: "string" } },
        diff_refs: { type: "array", items: { type: "string" } },
        decision_notes: { type: "string" },
        tracker_issue_key: { type: "string" },
      },
      required: ["task_id", "project_id", "task_title"],
    },
    async execute(
      _id: string,
      params: {
        task_id: string;
        project_id: string;
        task_title: string;
        task_type?: string;
        task_status?: string;
        parent_task_id?: string;
        related_task_ids?: string[];
        files_touched?: string[];
        symbols_touched?: string[];
        commit_refs?: string[];
        diff_refs?: string[];
        decision_notes?: string;
        tracker_issue_key?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.task_registry_upsert", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_task_registry_upsert",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_task_lineage_context",
    label: "Project Task Lineage Context",
    description:
      "Assemble compact task-lineage context (focus task, parent chain, related tasks, touched files/symbols, commit refs, decisions).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        tracker_issue_key: { type: "string" },
        task_title: { type: "string" },
        include_related: { type: "boolean" },
        include_parent_chain: { type: "boolean" },
      },
      required: ["project_id"],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        task_id?: string;
        tracker_issue_key?: string;
        task_title?: string;
        include_related?: boolean;
        include_parent_chain?: boolean;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.task_lineage_context", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_task_lineage_context",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  api.registerTool({
    name: "project_hybrid_search",
    label: "Project Hybrid Search",
    description:
      "Hybrid retrieval over file/symbol/task registries with optional task-lineage context assembly and project/task filters.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        path_prefix: { type: "array", items: { type: "string" } },
        module: { type: "array", items: { type: "string" } },
        language: { type: "array", items: { type: "string" } },
        task_id: { type: "array", items: { type: "string" } },
        tracker_issue_key: { type: "array", items: { type: "string" } },
        task_context: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            tracker_issue_key: { type: "string" },
            task_title: { type: "string" },
            include_related: { type: "boolean" },
            include_parent_chain: { type: "boolean" },
          },
        },
      },
      required: ["project_id", "query"],
    },
    async execute(
      _id: string,
      params: {
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
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.hybrid_search", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_hybrid_search",
            requestId: _id,
          },
        });

        return createResult(JSON.stringify(data, null, 2));
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
}
