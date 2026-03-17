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
    name: "project_binding_preview",
    label: "Project Binding Preview",
    description: "Read-only OpenCode-style project binding preview. Resolves active project by project_id/project_alias/repo_root/session alias, blocks ambiguous multi-project binding unless cross-project is explicit.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        project_alias: { type: "string" },
        repo_root: { type: "string" },
        session_project_alias: { type: "string" },
        allow_cross_project: { type: "boolean" },
      },
    },
    async execute(
      _id: string,
      params: {
        project_id?: string;
        project_alias?: string;
        repo_root?: string;
        session_project_alias?: string;
        allow_cross_project?: boolean;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.binding_preview", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_binding_preview",
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
    name: "project_register_command",
    label: "Project Register Command",
    description:
      "Canonical ASM v5.1 add/register project command flow. Supports optional Jira mapping attach and optional initial index trigger.",
    parameters: {
      type: "object",
      properties: {
        project_alias: { type: "string" },
        project_name: { type: "string" },
        project_id: { type: "string" },
        repo_root: { type: "string" },
        repo_remote: { type: "string" },
        active_version: { type: "string" },
        tracker: {
          type: "object",
          properties: {
            tracker_type: { type: "string", enum: ["jira", "github", "other"] },
            tracker_space_key: { type: "string" },
            tracker_project_id: { type: "string" },
            default_epic_key: { type: "string" },
            board_key: { type: "string" },
            active_version: { type: "string" },
            external_project_url: { type: "string" },
          },
        },
        options: {
          type: "object",
          properties: {
            trigger_index: { type: "boolean" },
            allow_alias_update: { type: "boolean" },
          },
        },
      },
      required: ["project_alias"],
    },
    async execute(
      _id: string,
      params: {
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
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.register_command", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_register_command",
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
    name: "project_link_tracker",
    label: "Project Link Tracker",
    description: "Canonical ASM v5.1 link jira/tracker command flow by project_id or project_alias.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
        tracker: {
          type: "object",
          properties: {
            tracker_type: { type: "string", enum: ["jira", "github", "other"] },
            tracker_space_key: { type: "string" },
            tracker_project_id: { type: "string" },
            default_epic_key: { type: "string" },
            board_key: { type: "string" },
            active_version: { type: "string" },
            external_project_url: { type: "string" },
          },
          required: ["tracker_type"],
        },
        mode: { type: "string", enum: ["attach_or_update"] },
      },
      required: ["project_ref", "tracker"],
    },
    async execute(
      _id: string,
      params: {
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
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.link_tracker", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_link_tracker",
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
    name: "project_trigger_index",
    label: "Project Trigger Index",
    description: "Canonical ASM v5.1 index project/index now command flow after registration/linking.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
        mode: { type: "string", enum: ["bootstrap", "incremental", "manual", "repair"] },
        scope: {
          type: "object",
          properties: {
            path_prefix: { type: "array", items: { type: "string" } },
            module: { type: "array", items: { type: "string" } },
            task_id: { type: "array", items: { type: "string" } },
          },
        },
        reason: { type: "string" },
        source_rev: { type: "string" },
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
              content: { type: "string" },
            },
            required: ["relative_path"],
          },
        },
      },
      required: ["project_ref"],
    },
    async execute(
      _id: string,
      params: {
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
        source_rev?: string;
        index_profile?: string;
        paths?: Array<{
          relative_path: string;
          checksum?: string;
          module?: string;
          language?: string;
          content?: string;
        }>;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.trigger_index", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_trigger_index",
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
    name: "project_deindex",
    label: "Project Deindex",
    description:
      "Mark a project as deindexed (non-destructive): keep registry identity but tombstone indexed artifacts so retrieval/search no longer returns them.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["project_id"],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        reason?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.deindex", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_deindex",
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
    name: "project_detach",
    label: "Project Detach",
    description:
      "Detach a project from active bindings (aliases/repo/tracker) after deindex safety step. Non-purge and reversible via re-register.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
        reason: { type: "string" },
      },
      required: ["project_ref"],
    },
    async execute(
      _id: string,
      params: {
        project_ref: { project_id?: string; project_alias?: string };
        reason?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.detach", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_detach",
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
    name: "project_unregister",
    label: "Project Unregister",
    description:
      "Safe unregister lifecycle step: requires explicit confirm=true, deindexes first, then disables project and detaches active bindings without destructive purge.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
        confirm: { type: "boolean" },
        mode: { type: "string", enum: ["safe"] },
        reason: { type: "string" },
      },
      required: ["project_ref", "confirm"],
    },
    async execute(
      _id: string,
      params: {
        project_ref: { project_id?: string; project_alias?: string };
        confirm: boolean;
        mode?: "safe";
        reason?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.unregister", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_unregister",
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
    name: "project_purge_preview",
    label: "Project Purge Preview",
    description:
      "Preview destructive purge impact with guardrails. Purge is only allowed when lifecycle_status=disabled and still requires explicit confirm in the purge call.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
      },
      required: ["project_ref"],
    },
    async execute(
      _id: string,
      params: {
        project_ref: { project_id?: string; project_alias?: string };
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.purge_preview", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_purge_preview",
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
    name: "project_purge",
    label: "Project Purge",
    description:
      "Destructive lifecycle endpoint. Requires project to be disabled first and explicit confirm=true. Use project_purge_preview before execution.",
    parameters: {
      type: "object",
      properties: {
        project_ref: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            project_alias: { type: "string" },
          },
        },
        confirm: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["project_ref", "confirm"],
    },
    async execute(
      _id: string,
      params: {
        project_ref: { project_id?: string; project_alias?: string };
        confirm: boolean;
        reason?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.purge", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_purge",
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
    name: "project_telegram_onboarding",
    label: "Project Telegram Onboarding",
    description:
      "Operator-facing Telegram onboarding helper for project registration + Jira mapping + optional index-now. Preview/confirm flow that bridges to ASM-80 command layer.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Slash command trigger, e.g. /project" },
        repo_url: { type: "string", description: "Repo URL/import source from Telegram step." },
        project_alias: { type: "string", description: "Operator-confirmed project alias." },
        jira_space_key: { type: "string", description: "Jira space key (uppercase format)." },
        default_epic_key: { type: "string", description: "Default epic key, must match <SPACE>-* when provided." },
        index_now: { type: "boolean", description: "Whether to trigger index immediately after confirm." },
        project_name: { type: "string", description: "Optional project display name." },
        repo_root: { type: "string", description: "Optional resolved repo root." },
        active_version: { type: "string", description: "Optional active version." },
        mode: { type: "string", enum: ["preview", "confirm"], description: "preview validates and returns confirm card; confirm executes." },
      },
    },
    async execute(
      _id: string,
      params: {
        command?: string;
        repo_url?: string;
        project_alias?: string;
        jira_space_key?: string;
        default_epic_key?: string;
        index_now?: boolean;
        project_name?: string;
        repo_root?: string;
        active_version?: string;
        mode?: "preview" | "confirm";
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.telegram_onboarding", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_telegram_onboarding",
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
              content: { type: "string" },
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
          content?: string;
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
    name: "project_index_event",
    label: "Project Index Event",
    description: "Event-driven partial project reindex using explicit changed/deleted file lists from git hooks or local automation.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_rev: { type: "string" },
        event_type: { type: "string", enum: ["post_commit", "post_merge", "manual"] },
        changed_files: { type: "array", items: { type: "string" } },
        deleted_files: { type: "array", items: { type: "string" } },
      },
      required: ["project_id"],
    },
    async execute(
      _id: string,
      params: {
        project_id: string;
        source_rev?: string;
        event_type?: "post_commit" | "post_merge" | "manual";
        changed_files?: string[];
        deleted_files?: string[];
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.index_event", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_index_event",
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
    name: "project_install_hooks",
    label: "Project Install Hooks",
    description: "Install local git hooks for an already-registered project so commit/merge events auto-trigger ASM indexing.",
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

        const data = await useCasePort.run<typeof params, any>("project.install_hooks", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_install_hooks",
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
    name: "project_legacy_backfill",
    label: "Project Legacy Backfill",
    description:
      "Run legacy compatibility migration/backfill for indexed-but-unregistered projects: alias/tracker inference, registration state normalization, migration_state upsert.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["dry_run", "apply"] },
        only_project_ids: { type: "array", items: { type: "string" } },
        only_aliases: { type: "array", items: { type: "string" } },
        force_registration_state: { type: "boolean" },
        source: { type: "string", enum: ["repo_root", "repo_remote", "task_registry", "mixed"] },
      },
    },
    async execute(
      _id: string,
      params: {
        mode?: "dry_run" | "apply";
        only_project_ids?: string[];
        only_aliases?: string[];
        force_registration_state?: boolean;
        source?: "repo_root" | "repo_remote" | "task_registry" | "mixed";
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.legacy_backfill", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_legacy_backfill",
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
    name: "project_change_overlay_query",
    label: "Project Change Overlay Query",
    description:
      "Query ASM-94 change-aware overlay with explicit selector (task/tracker) and optional feature filter.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        tracker_issue_key: { type: "string" },
        task_title: { type: "string" },
        feature_key: {
          type: "string",
          enum: [
            "project_onboarding_registration_indexing",
            "code_aware_retrieval",
            "heartbeat_health_runtime_integrity",
            "change_aware_impact",
            "post_entry_review_decision_support",
          ],
        },
        feature_name: { type: "string" },
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
        feature_key?:
          | "project_onboarding_registration_indexing"
          | "code_aware_retrieval"
          | "heartbeat_health_runtime_integrity"
          | "change_aware_impact"
          | "post_entry_review_decision_support";
        feature_name?: string;
        include_related?: boolean;
        include_parent_chain?: boolean;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.change_overlay.query", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_change_overlay_query",
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
    name: "project_feature_pack_generate",
    label: "Project Feature Pack Generate",
    description:
      "Generate a minimal feature/capability pack for a registered project flow. ASM-93 Slice 2 supports multiple priority feature packs.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        project_alias: { type: "string" },
        feature_key: {
          type: "string",
          enum: [
            "project_onboarding_registration_indexing",
            "code_aware_retrieval",
            "heartbeat_health_runtime_integrity",
            "change_aware_impact",
            "post_entry_review_decision_support",
          ],
        },
      },
    },
    async execute(
      _id: string,
      params: {
        project_id?: string;
        project_alias?: string;
        feature_key?:
          | "project_onboarding_registration_indexing"
          | "code_aware_retrieval"
          | "heartbeat_health_runtime_integrity"
          | "change_aware_impact"
          | "post_entry_review_decision_support";
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.feature_pack.generate", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_feature_pack_generate",
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
    name: "project_feature_pack_query",
    label: "Project Feature Pack Query",
    description:
      "Query feature pack by feature_key or feature name (human-friendly) for a registered project.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        project_alias: { type: "string" },
        feature_key: {
          type: "string",
          enum: [
            "project_onboarding_registration_indexing",
            "code_aware_retrieval",
            "heartbeat_health_runtime_integrity",
            "change_aware_impact",
            "post_entry_review_decision_support",
          ],
        },
        feature_name: { type: "string" },
      },
    },
    async execute(
      _id: string,
      params: {
        project_id?: string;
        project_alias?: string;
        feature_key?:
          | "project_onboarding_registration_indexing"
          | "code_aware_retrieval"
          | "heartbeat_health_runtime_integrity"
          | "change_aware_impact"
          | "post_entry_review_decision_support";
        feature_name?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.feature_pack.query", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_feature_pack_query",
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
    name: "project_opencode_search",
    label: "Project OpenCode Search",
    description:
      "Read-only OpenCode retrieval surface. Resolves project binding first, then runs project-scoped developer query. Cross-project behavior requires explicit opt-in.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        project_id: { type: "string" },
        project_alias: { type: "string" },
        repo_root: { type: "string" },
        session_project_alias: { type: "string" },
        explicit_project_id: { type: "string" },
        explicit_project_alias: { type: "string" },
        explicit_cross_project: { type: "boolean" },
      },
      required: ["query"],
    },
    async execute(
      _id: string,
      params: {
        query: string;
        limit?: number;
        project_id?: string;
        project_alias?: string;
        repo_root?: string;
        session_project_alias?: string;
        explicit_project_id?: string;
        explicit_project_alias?: string;
        explicit_cross_project?: boolean;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.opencode_search", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_opencode_search",
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
    name: "project_developer_query",
    label: "Project Developer Query",
    description:
      "ASM-112 typed developer query parser surface with deterministic intent/selector normalization over existing hybrid_search/feature_pack/change_overlay capabilities.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        project_alias: { type: "string" },
        query: { type: "string" },
        intent: {
          type: "string",
          enum: [
            "locate_symbol",
            "locate_file",
            "feature_lookup",
            "change_lookup",
            "locate",
            "trace_flow",
            "impact",
            "impact_analysis",
            "change_aware_lookup",
            "feature_understanding",
          ],
        },
        limit: { type: "number" },
        symbol_name: { type: "string" },
        relative_path: { type: "string" },
        route_path: { type: "string" },
        tracker_issue_key: { type: "string" },
        task_id: { type: "string" },
        task_title: { type: "string" },
        tracker_issue_keys: { type: "array", items: { type: "string" } },
        task_ids: { type: "array", items: { type: "string" } },
        route_paths: { type: "array", items: { type: "string" } },
        feature_key: {
          type: "string",
          enum: [
            "project_onboarding_registration_indexing",
            "code_aware_retrieval",
            "heartbeat_health_runtime_integrity",
            "change_aware_impact",
            "post_entry_review_decision_support",
          ],
        },
        feature_name: { type: "string" },
      },
      required: [],
    },
    async execute(
      _id: string,
      params: {
        project_id?: string;
        project_alias?: string;
        query?: string;
        intent?:
          | "locate_symbol"
          | "locate_file"
          | "feature_lookup"
          | "change_lookup"
          | "locate"
          | "trace_flow"
          | "impact"
          | "impact_analysis"
          | "change_aware_lookup"
          | "feature_understanding";
        limit?: number;
        symbol_name?: string;
        relative_path?: string;
        route_path?: string;
        tracker_issue_key?: string;
        task_id?: string;
        task_title?: string;
        tracker_issue_keys?: string[];
        task_ids?: string[];
        route_paths?: string[];
        feature_key?:
          | "project_onboarding_registration_indexing"
          | "code_aware_retrieval"
          | "heartbeat_health_runtime_integrity"
          | "change_aware_impact"
          | "post_entry_review_decision_support";
        feature_name?: string;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("project.developer_query", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "project_developer_query",
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
        debug: { type: "boolean", description: "Return candidate-generation and ranking debug info for conformance/debugging." },
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
