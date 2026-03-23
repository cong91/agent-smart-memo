import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getMemoryUseCasePortForContext } from "../adapters/openclaw/tool-runtime.js";

export interface AddProjectCommandPayload {
  mode: "preview" | "confirm";
  repo_url?: string;
  project_alias?: string;
  jira_space_key?: string;
  default_epic_key?: string;
  index_now?: boolean;
  project_name?: string;
  repo_root?: string;
  active_version?: string;
}

export interface AddProjectCommandDependencies {
  getUseCasePortForContext?: typeof getMemoryUseCasePortForContext;
  now?: () => number;
}

const DEFAULT_AGENT_ID = "main";
const TELEGRAM_PROJECT_COMMAND = "/asm_project_index";

function parseBooleanLike(raw: string): boolean | undefined {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return undefined;
}

function normalizeTokenValue(value: string): string {
  return String(value || "").trim();
}

function extractKeyValue(token: string): { key: string; value: string } | null {
  const idx = token.indexOf("=");
  if (idx <= 0) return null;
  return {
    key: token.slice(0, idx).trim().toLowerCase(),
    value: token.slice(idx + 1).trim(),
  };
}

function looksLikeRepoUrl(value: string): boolean {
  const txt = String(value || "").trim();
  if (!txt) return false;
  return txt.startsWith("http://") || txt.startsWith("https://") || txt.startsWith("git@") || txt.includes("github.com") || txt.includes("gitlab.com");
}

export function parseAddProjectCommandArgs(args?: string): AddProjectCommandPayload | { help: true } {
  const raw = String(args || "").trim();
  if (!raw) return { help: true };

  const tokens = raw.split(/\s+/).filter(Boolean);
  const payload: AddProjectCommandPayload = {
    mode: "preview",
  };

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (lowered === "help" || lowered === "-h" || lowered === "--help") {
      return { help: true };
    }

    if (lowered === "preview" || lowered === "confirm") {
      payload.mode = lowered;
      continue;
    }

    const kv = extractKeyValue(token);
    if (kv) {
      const value = normalizeTokenValue(kv.value);
      switch (kv.key) {
        case "repo":
        case "repo_url":
        case "url":
          payload.repo_url = value || undefined;
          break;
        case "alias":
        case "project_alias":
          payload.project_alias = value || undefined;
          break;
        case "jira":
        case "jira_space":
        case "jira_space_key":
          payload.jira_space_key = value ? value.toUpperCase() : undefined;
          break;
        case "epic":
        case "default_epic":
        case "default_epic_key":
          payload.default_epic_key = value ? value.toUpperCase() : undefined;
          break;
        case "index":
        case "index_now": {
          const bool = parseBooleanLike(value);
          if (typeof bool === "boolean") payload.index_now = bool;
          break;
        }
        case "name":
        case "project_name":
          payload.project_name = value || undefined;
          break;
        case "root":
        case "repo_root":
          payload.repo_root = value || undefined;
          break;
        case "version":
        case "active_version":
          payload.active_version = value || undefined;
          break;
        case "mode":
          if (value === "preview" || value === "confirm") payload.mode = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (typeof payload.repo_url === "undefined" && looksLikeRepoUrl(token)) {
      payload.repo_url = normalizeTokenValue(token);
      continue;
    }

    if (typeof payload.project_alias === "undefined") {
      payload.project_alias = normalizeTokenValue(token);
      continue;
    }
  }

  return payload;
}

type AddProjectCommandContext = {
  senderId?: string;
  channel: string;
  accountId?: string;
  from?: string;
  messageThreadId?: number;
};

export function composeAddProjectScopeUserId(ctx: AddProjectCommandContext): string {
  const channel = String(ctx.channel || "telegram").toLowerCase();
  const account = String(ctx.accountId || "default").trim() || "default";
  const sender = String(ctx.senderId || ctx.from || "unknown").trim() || "unknown";
  const thread = typeof ctx.messageThreadId === "number" ? `:thread:${ctx.messageThreadId}` : "";
  return `${channel}:account:${account}:sender:${sender}${thread}`;
}

export function formatAddProjectUsage(): string {
  return [
    "Usage:",
    "/asm_project_index <repo_url> [alias=<project_alias>] [jira=<SPACE>] [epic=<SPACE-123>] [index=true|false]",
    "/asm_project_index confirm <repo_url> alias=<project_alias> jira=<SPACE> [epic=<SPACE-123>] [index=true|false]",
    "",
    "Examples:",
    "/asm_project_index git@github.com:org/repo.git alias=my-repo jira=ASM epic=ASM-82",
    "/asm_project_index confirm git@github.com:org/repo.git alias=my-repo jira=ASM index=true",
  ].join("\n");
}

export function formatAddProjectResult(result: any): string {
  const status = String(result?.status || "unknown");
  if (status === "committed") {
    return [
      "✅ /asm_project_index committed",
      `- project_id: ${result?.project_id || "n/a"}`,
      `- project_alias: ${result?.project_alias || "n/a"}`,
      `- tracker: ${result?.tracker_mapping?.tracker_type || "none"}`,
      `- index_requested: ${result?.index_trigger?.requested === true ? "yes" : "no"}`,
    ].join("\n");
  }

  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const fields = result?.summary_card?.fields || {};

  const lines = [
    status === "preview_ready" ? "🧭 /asm_project_index preview" : "⚠️ /asm_project_index validation",
    `- mode: ${status}`,
    `- command: ${fields.command || TELEGRAM_PROJECT_COMMAND}`,
    `- repo_url: ${fields.repo_url || "(missing)"}`,
    `- project_alias: ${fields.project_alias || "(missing)"}`,
    `- jira_space_key: ${fields.jira_space_key || "(none)"}`,
    `- default_epic_key: ${fields.default_epic_key || "(none)"}`,
    `- index_now: ${fields.index_now === true ? "true" : "false"}`,
  ];

  if (errors.length > 0) {
    lines.push("- errors:");
    for (const item of errors) lines.push(`  - ${String(item)}`);
  }
  if (warnings.length > 0) {
    lines.push("- warnings:");
    for (const item of warnings) lines.push(`  - ${String(item)}`);
  }

  if (status !== "committed") {
    lines.push("- next: run /asm_project_index confirm ... after fields are valid");
  }

  return lines.join("\n");
}

export function registerTelegramAddProjectCommand(api: OpenClawPluginApi, deps?: AddProjectCommandDependencies): void {
  const getPort = deps?.getUseCasePortForContext || getMemoryUseCasePortForContext;
  const now = deps?.now || (() => Date.now());

  api.registerCommand({
    name: "asm_project_index",
    description: "Project onboarding (preview/confirm) routed to project.telegram_onboarding",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (String(ctx.channel || "").toLowerCase() !== "telegram") {
        return { text: "This command is intended for Telegram channel usage." };
      }

      const parsed = parseAddProjectCommandArgs(ctx.args);
      if ((parsed as any).help) {
        return { text: formatAddProjectUsage() };
      }

      const payload = parsed as AddProjectCommandPayload;
      const userId = composeAddProjectScopeUserId(ctx);
      const sessionKey = `agent:${DEFAULT_AGENT_ID}:${userId}`;
      const useCasePort = getPort({
        sessionKey,
        pluginConfig: api.pluginConfig,
        config: api.config,
      });

      const response = await useCasePort.run<any, any>("project.telegram_onboarding", {
        context: { userId, agentId: DEFAULT_AGENT_ID },
        payload: {
          command: TELEGRAM_PROJECT_COMMAND,
          ...payload,
        },
        meta: {
          source: "openclaw",
          toolName: "command.asm_project_index",
          requestId: `asm_project_index:${now()}`,
        },
      });

      return { text: formatAddProjectResult(response) };
    },
  });
}
