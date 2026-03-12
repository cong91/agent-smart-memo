import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveAgentId } from "../shared/memory-config.js";

type HookCtx = {
  agentId?: string;
  sessionKey?: string;
};

type BeforeToolCallEvent = {
  toolName?: string;
  params?: Record<string, unknown>;
};

function deriveIdentity(ctx: HookCtx) {
  const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const agentFromCtx = typeof ctx?.agentId === "string" ? ctx.agentId.trim() : "";

  const parts = sessionKey ? sessionKey.split(":") : [];
  const agentFromSession = parts.length >= 2 ? parts[1] : "";
  const userFromSession = parts.length >= 3 ? parts.slice(2).join(":") : "";

  return {
    agentId: resolveAgentId(agentFromCtx || agentFromSession || "assistant"),
    sessionKey: sessionKey || undefined,
    userId: userFromSession || "default",
  };
}

function ensureMemoryStoreDefaults(params: Record<string, unknown>, agentId: string) {
  const next = { ...params };
  if (typeof next.namespace !== "string" || next.namespace.trim().length === 0) {
    next.namespace = `agent.${agentId}.working_memory`;
  }
  return next;
}

/**
 * Inject runtime agent/session identity into memory tool params.
 *
 * Runtime provides identity in before_tool_call hook context; memory tools previously
 * fell back to assistant when params.agentId was missing.
 */
export function registerMemoryToolContextInjector(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event: BeforeToolCallEvent, ctx: HookCtx) => {
    const toolName = String(event?.toolName || "").trim();
    if (toolName !== "memory_store" && toolName !== "memory_search") {
      return;
    }

    const originalParams = event?.params && typeof event.params === "object"
      ? event.params
      : {};

    const identity = deriveIdentity(ctx || {});

    const merged: Record<string, unknown> = {
      ...originalParams,
      agentId:
        typeof originalParams.agentId === "string" && originalParams.agentId.trim().length > 0
          ? originalParams.agentId
          : identity.agentId,
      sessionId:
        typeof originalParams.sessionId === "string" && originalParams.sessionId.trim().length > 0
          ? originalParams.sessionId
          : identity.sessionKey,
      userId:
        typeof originalParams.userId === "string" && originalParams.userId.trim().length > 0
          ? originalParams.userId
          : identity.userId,
    };

    const params =
      toolName === "memory_store"
        ? ensureMemoryStoreDefaults(merged, identity.agentId)
        : merged;

    return { params };
  });
}
