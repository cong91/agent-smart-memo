import {
  buildPluginCallbackDedupeKey,
  parseTaggedSessionTitle
} from "../chunk-TDVN5AFB.js";

// opencode-plugin/openclaw-bridge-callback.ts
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function ensureAuditDir(directory) {
  mkdirSync(directory, { recursive: true });
  return directory;
}
function getAuditPath(directory) {
  const auditDir = asString(process.env.OPENCLAW_BRIDGE_AUDIT_DIR) || join(directory, ".opencode");
  ensureAuditDir(auditDir);
  return join(auditDir, "bridge-callback-audit.jsonl");
}
function appendAudit(directory, record) {
  const path = getAuditPath(directory);
  appendFileSync(path, JSON.stringify({ ...record, created_at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n", "utf8");
}
function getOpenClawAuditPath() {
  const explicit = asString(process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH);
  if (explicit) {
    ensureAuditDir(join(explicit, ".."));
    return explicit;
  }
  const home = asString(process.env.HOME);
  if (!home) return null;
  const auditDir = join(home, ".openclaw", "opencode-bridge", "audit");
  ensureAuditDir(auditDir);
  return join(auditDir, "callbacks.jsonl");
}
function appendOpenClawAudit(record) {
  const path = getOpenClawAuditPath();
  if (!path) return;
  appendFileSync(path, JSON.stringify({ ...record, createdAt: (/* @__PURE__ */ new Date()).toISOString() }) + "\n", "utf8");
}
function buildCallbackPayload(tags, eventType) {
  const agentId = tags.requested || tags.requested_agent_id;
  const sessionKey = tags.callbackSession || tags.callback_target_session_key;
  const sessionId = tags.callbackSessionId || tags.callback_target_session_id;
  if (!agentId || !sessionKey) return null;
  return {
    message: `OpenCode plugin event=${eventType} run=${tags.runId || tags.run_id || "unknown"} task=${tags.taskId || tags.task_id || "unknown"}`,
    name: "OpenCode",
    agentId,
    sessionKey,
    ...sessionId ? { sessionId } : {},
    wakeMode: "now",
    deliver: false
  };
}
async function postCallback(directory, payload, meta) {
  const hookBaseUrl = asString(process.env.OPENCLAW_HOOK_BASE_URL);
  const hookToken = asString(process.env.OPENCLAW_HOOK_TOKEN);
  if (!hookBaseUrl || !hookToken) {
    appendAudit(directory, { ok: false, status: 0, reason: "missing_hook_env", payload, meta });
    appendOpenClawAudit({
      taskId: meta?.taskId,
      runId: meta?.runId,
      agentId: payload?.agentId,
      requestedAgentId: meta?.requestedAgentId,
      resolvedAgentId: meta?.resolvedAgentId,
      sessionKey: void 0,
      callbackTargetSessionKey: meta?.callbackTargetSessionKey,
      callbackTargetSessionId: meta?.callbackTargetSessionId,
      event: meta?.eventType,
      callbackStatus: 0,
      callbackOk: false,
      callbackBody: "missing_hook_env"
    });
    return { ok: false, status: 0, reason: "missing_hook_env" };
  }
  const response = await fetch(`${hookBaseUrl.replace(/\/$/, "")}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hookToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  appendAudit(directory, { ok: response.ok, status: response.status, body: text, payload, meta });
  const openClawAuditRecord = {
    taskId: meta?.taskId,
    runId: meta?.runId,
    agentId: payload?.agentId,
    requestedAgentId: meta?.requestedAgentId,
    resolvedAgentId: meta?.resolvedAgentId,
    sessionKey: void 0,
    callbackTargetSessionKey: meta?.callbackTargetSessionKey,
    callbackTargetSessionId: meta?.callbackTargetSessionId,
    event: meta?.eventType,
    callbackStatus: response.status,
    callbackOk: response.ok,
    callbackBody: text
  };
  appendAudit(directory, { phase: "openclaw_audit_mirror", record: openClawAuditRecord });
  appendOpenClawAudit(openClawAuditRecord);
  return { ok: response.ok, status: response.status, body: text };
}
var callbackDedupe = /* @__PURE__ */ new Set();
var sessionTagCache = /* @__PURE__ */ new Map();
function readSessionId(event) {
  return asString(event?.session?.id) || asString(event?.session?.sessionID) || asString(event?.data?.session?.id) || asString(event?.data?.sessionID) || asString(event?.properties?.sessionID) || asString(event?.properties?.info?.sessionID) || asString(event?.properties?.info?.id) || asString(event?.payload?.sessionID);
}
function isTerminalEvent(_event, type) {
  return type === "session.idle" || type === "session.error";
}
var OpenClawBridgeCallbackPlugin = async ({ client, directory }) => {
  await client.app.log({
    body: {
      service: "openclaw-bridge-callback",
      level: "info",
      message: "OpenClaw bridge callback plugin initialized",
      extra: { directory }
    }
  });
  return {
    event: async ({ event }) => {
      const type = asString(event?.type) || "unknown";
      const sessionId = readSessionId(event);
      const title = asString(event?.session?.title) || asString(event?.data?.session?.title) || asString(event?.data?.title) || asString(event?.properties?.info?.title) || asString(event?.properties?.title) || asString(event?.payload?.session?.title) || asString(event?.payload?.title);
      const parsedTags = parseTaggedSessionTitle(title);
      if (sessionId && parsedTags && (parsedTags.callbackSession || parsedTags.callback_target_session_key)) {
        sessionTagCache.set(sessionId, parsedTags);
      }
      const tags = parsedTags || (sessionId ? sessionTagCache.get(sessionId) || null : null);
      appendAudit(directory, { phase: "event_seen", event_type: type, session_id: sessionId, title, tags, raw: event });
      if (!tags || !(tags.callbackSession || tags.callback_target_session_key)) return;
      if (!isTerminalEvent(event, type)) return;
      const dedupeKey = buildPluginCallbackDedupeKey({ sessionId, runId: tags.runId || tags.run_id });
      if (callbackDedupe.has(dedupeKey)) {
        appendAudit(directory, { phase: "deduped", event_type: type, session_id: sessionId, dedupeKey, tags });
        return;
      }
      callbackDedupe.add(dedupeKey);
      const payload = buildCallbackPayload(tags, type);
      if (!payload) {
        appendAudit(directory, { phase: "skipped_no_payload", event_type: type, session_id: sessionId, tags });
        return;
      }
      await postCallback(directory, payload, {
        eventType: type,
        sessionId,
        runId: tags.runId || tags.run_id,
        taskId: tags.taskId || tags.task_id,
        requestedAgentId: tags.requested || tags.requested_agent_id,
        resolvedAgentId: tags.resolved || tags.resolved_agent_id,
        callbackTargetSessionKey: tags.callbackSession || tags.callback_target_session_key,
        callbackTargetSessionId: tags.callbackSessionId || tags.callback_target_session_id
      });
    }
  };
};
var openclaw_bridge_callback_default = OpenClawBridgeCallbackPlugin;
export {
  OpenClawBridgeCallbackPlugin,
  openclaw_bridge_callback_default as default
};
