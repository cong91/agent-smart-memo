import { randomUUID } from "node:crypto";
import {
  AGENT_MEMO_CONFIG_SCHEMA,
  AGENT_MEMO_PLUGIN_DESCRIPTION,
  AGENT_MEMO_PLUGIN_NAME,
  AGENT_MEMO_UI_HINTS,
} from "../index.js";
import { createPaperclipRuntime } from "../adapters/paperclip/runtime.js";
import type {
  PaperclipRequestEnvelope,
  PaperclipResponseEnvelope,
  PaperclipRuntimeContext,
} from "../adapters/paperclip/contracts.js";

export { createPaperclipRuntime } from "../adapters/paperclip/runtime.js";
export type {
  PaperclipRuntime,
  PaperclipRuntimeOptions,
} from "../adapters/paperclip/runtime.js";
export type {
  PaperclipRequestEnvelope,
  PaperclipResponseEnvelope,
  PaperclipRuntimeContext,
} from "../adapters/paperclip/contracts.js";

export const ASM_MEMORY_PLUGIN_ID = "@paperclip/plugin-asm-memory";

export const ASM_MEMORY_TOOL_NAMES = {
  recall: "memory_recall",
  capture: "memory_capture",
  feedback: "memory_feedback",
} as const;

export const ASM_MEMORY_EVENT_NAMES = {
  runStarted: "agent.run.started",
  runFinished: "agent.run.finished",
  runFailed: "agent.run.failed",
  activityLogged: "activity.logged",
  captureAccepted: "plugin.@paperclip/plugin-asm-memory.capture.accepted",
  captureRejected: "plugin.@paperclip/plugin-asm-memory.capture.rejected",
  recallInjected: "plugin.@paperclip/plugin-asm-memory.recall.injected",
  fallbackUsed: "plugin.@paperclip/plugin-asm-memory.fallback.used",
} as const;

export const ASM_MEMORY_JOB_NAMES = {
  captureCompact: "asm_capture_compact",
  recallQualityCheck: "asm_recall_quality_check",
  fallbackSync: "asm_fallback_sync",
} as const;

export const instanceConfigSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true },
    capture: {
      type: "object",
      properties: {
        mode: { enum: ["event", "event+batch"], default: "event+batch" },
        minConfidence: { type: "number", minimum: 0, maximum: 1, default: 0.62 },
        maxItemsPerRun: { type: "integer", minimum: 1, default: 12 },
        dedupWindowHours: { type: "integer", minimum: 1, default: 72 },
      },
    },
    recall: {
      type: "object",
      properties: {
        topK: { type: "integer", minimum: 1, default: 8 },
        minScore: { type: "number", minimum: 0, maximum: 1, default: 0.45 },
      },
    },
    markdownFallback: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        rootDir: { type: "string", default: "skills/para-memory-files" },
      },
    },
    runtime: {
      type: "object",
      properties: {
        stateDir: { type: "string" },
        slotDbDir: { type: "string" },
        qdrantHost: { type: "string" },
        qdrantPort: { type: "number" },
        qdrantCollection: { type: "string" },
        qdrantVectorSize: { type: "number" },
        embedBaseUrl: { type: "string" },
        embedBackend: { enum: ["ollama", "openai", "docker"] },
        embedModel: { type: "string" },
        embedDimensions: { type: "number" },
      },
    },
  },
} as const;

function toPaperclipFieldType(schema: Record<string, any> = {}): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "select";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "string";
}

function buildPaperclipConfigSchema() {
  const props = AGENT_MEMO_CONFIG_SCHEMA.properties ?? {};
  const fields = Object.entries(props).map(([key, spec]) => {
    const hint = (AGENT_MEMO_UI_HINTS as Record<string, any>)[key] ?? {};
    const field: Record<string, any> = {
      key,
      type: toPaperclipFieldType(spec as Record<string, any>),
      label: hint.label || key,
      description: (spec as Record<string, any>).description,
    };

    if ((spec as Record<string, any>).default !== undefined) {
      field.defaultValue = (spec as Record<string, any>).default;
    }
    if (hint.placeholder) {
      field.placeholder = hint.placeholder;
    }

    const lower = key.toLowerCase();
    if (lower.endsWith("apikey") || lower.endsWith("api_key") || lower.endsWith("token") || lower.endsWith("secret")) {
      field.type = "password";
      field.secret = true;
    }

    if (field.type === "select") {
      field.options = ((spec as Record<string, any>).enum || []).map((value: unknown) => ({
        label: String(value),
        value,
      }));
    }

    return field;
  });

  return {
    title: "ASM Memory Plugin Config",
    description: "Shared production config contract for ASM across OpenClaw and Paperclip.",
    restartRequired: true,
    fields,
  };
}

export const manifest = {
  id: ASM_MEMORY_PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ASM Memory",
  description: AGENT_MEMO_PLUGIN_DESCRIPTION,
  categories: ["automation", "workspace", "memory"],
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "activity.log.write",
  ],
  tools: [
    {
      name: ASM_MEMORY_TOOL_NAMES.recall,
      displayName: "ASM Recall",
      description: "Query memory from ASM core based on current context",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          namespace: { type: "string" },
          topK: { type: "integer", minimum: 1 },
          minScore: { type: "number", minimum: 0, maximum: 1 },
          context: { type: "object" },
        },
        required: ["query"],
      },
    },
    {
      name: ASM_MEMORY_TOOL_NAMES.capture,
      displayName: "ASM Capture",
      description: "Capture a memory item intentionally",
      parametersSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          namespace: { type: "string" },
          source: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          context: { type: "object" },
        },
        required: ["text"],
      },
    },
    {
      name: ASM_MEMORY_TOOL_NAMES.feedback,
      displayName: "ASM Feedback",
      description: "Submit feedback for recalled/captured memory quality",
      parametersSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          feedback: { enum: ["upvote", "downvote"] },
          reason: { type: "string" },
          context: { type: "object" },
        },
        required: ["memoryId", "feedback"],
      },
    },
  ],
  events: {
    subscribes: [
      ASM_MEMORY_EVENT_NAMES.runStarted,
      ASM_MEMORY_EVENT_NAMES.runFinished,
      ASM_MEMORY_EVENT_NAMES.runFailed,
      ASM_MEMORY_EVENT_NAMES.activityLogged,
    ],
    emits: [
      ASM_MEMORY_EVENT_NAMES.captureAccepted,
      ASM_MEMORY_EVENT_NAMES.captureRejected,
      ASM_MEMORY_EVENT_NAMES.recallInjected,
      ASM_MEMORY_EVENT_NAMES.fallbackUsed,
    ],
  },
  jobs: [
    { name: ASM_MEMORY_JOB_NAMES.captureCompact, cron: "*/10 * * * *" },
    { name: ASM_MEMORY_JOB_NAMES.recallQualityCheck, cron: "*/30 * * * *" },
    { name: ASM_MEMORY_JOB_NAMES.fallbackSync, cron: "0 */6 * * *" },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "asm-memory-run",
        displayName: AGENT_MEMO_PLUGIN_NAME,
        exportName: "RunMemoryTab",
        entityTypes: ["run", "agent"],
      },
    ],
  },
  configSchema: buildPaperclipConfigSchema(),
  instanceConfigSchema,
} as const;

type HostWorkerInput = {
  config?: {
    enabled?: boolean;
    runtime?: {
      stateDir?: string;
      slotDbDir?: string;
      qdrantHost?: string;
      qdrantPort?: number;
      qdrantCollection?: string;
      qdrantVectorSize?: number;
      embedBaseUrl?: string;
      embedBackend?: "ollama" | "openai" | "docker";
      embedModel?: string;
      embedDimensions?: number;
    };
  };
  now?: string;
};

type ToolContext = {
  companyId?: string;
  projectId?: string;
  agentId?: string;
  runId?: string;
  projectWorkspaceId?: string;
  sessionDisplayId?: string;
  sessionParams?: string;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toRuntimeContext(input: unknown): PaperclipRuntimeContext {
  const ctx = asRecord(input);
  return {
    userId: asString(ctx.userId) || asString(ctx.companyId) || "paperclip",
    sessionId: asString(ctx.sessionId) || asString(ctx.runId) || asString(ctx.sessionDisplayId) || asString(ctx.sessionParams),
    workspaceId: asString(ctx.workspaceId) || asString(ctx.projectWorkspaceId) || asString(ctx.projectId),
    traceId: asString(ctx.traceId) || asString(ctx.runId),
    locale: asString(ctx.locale),
    metadata: { ...ctx },
  };
}

function toEnvelope(action: string, payload: Record<string, any>): PaperclipRequestEnvelope<Record<string, any>> {
  const runtimeContext = toRuntimeContext(payload.context);
  const nextPayload = { ...payload };
  delete nextPayload.context;

  return {
    action,
    payload: nextPayload,
    namespace: asString(payload.namespace),
    context: runtimeContext,
  };
}

function toToolResponse<T>(response: PaperclipResponseEnvelope<T>, correlationId = randomUUID(), reasonCodes: string[] = []) {
  if (response.ok) {
    return {
      ok: true,
      correlationId,
      decision: "accepted",
      reasonCodes,
      data: response.data,
    };
  }

  return {
    ok: false,
    correlationId,
    decision: "rejected",
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : [String(response.error?.code || "internal_error").toLowerCase()],
    error: response.error,
    data: response.data,
  };
}

function validateWorkerConfig(raw: Record<string, any>) {
  const enabled = raw.enabled ?? true;
  const runtime = asRecord(raw.runtime);
  const errors: string[] = [];

  if (runtime.embedBackend && !["ollama", "openai", "docker"].includes(String(runtime.embedBackend))) {
    errors.push("runtime.embedBackend must be ollama, openai, or docker");
  }

  for (const numericKey of ["qdrantPort", "qdrantVectorSize", "embedDimensions"] as const) {
    if (runtime[numericKey] !== undefined && (!Number.isFinite(Number(runtime[numericKey])) || Number(runtime[numericKey]) <= 0)) {
      errors.push(`runtime.${numericKey} must be a positive number`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      enabled: enabled !== false,
      runtime: {
        stateDir: asString(runtime.stateDir),
        slotDbDir: asString(runtime.slotDbDir),
        qdrantHost: asString(runtime.qdrantHost),
        qdrantPort: runtime.qdrantPort === undefined ? undefined : Number(runtime.qdrantPort),
        qdrantCollection: asString(runtime.qdrantCollection),
        qdrantVectorSize: runtime.qdrantVectorSize === undefined ? undefined : Number(runtime.qdrantVectorSize),
        embedBaseUrl: asString(runtime.embedBaseUrl),
        embedBackend: runtime.embedBackend,
        embedModel: asString(runtime.embedModel),
        embedDimensions: runtime.embedDimensions === undefined ? undefined : Number(runtime.embedDimensions),
      },
    },
  };
}

export class AsmMemoryPaperclipWorker {
  private initialized = false;
  private startedAt: string | null = null;
  private runtime = createPaperclipRuntime();
  private config = validateWorkerConfig({}).normalized;

  initialize(input?: HostWorkerInput) {
    const validation = validateWorkerConfig(asRecord(input?.config));
    if (!validation.valid) {
      throw new Error(`Invalid ASM plugin config: ${validation.errors.join("; ")}`);
    }

    this.config = validation.normalized;
    this.runtime = createPaperclipRuntime(validation.normalized.runtime);
    this.initialized = true;
    this.startedAt = input?.now || new Date().toISOString();
    return { ok: true, config: this.config };
  }

  health() {
    return {
      ok: true,
      pluginId: ASM_MEMORY_PLUGIN_ID,
      initialized: this.initialized,
      startedAt: this.startedAt,
    };
  }

  async shutdown() {
    this.runtime.slotDb.close();
    this.initialized = false;
    return { ok: true };
  }

  async executeTool(toolName: string, payload: unknown) {
    const input = asRecord(payload);

    if (toolName === ASM_MEMORY_TOOL_NAMES.capture) {
      return toToolResponse(await this.runtime.adapter.execute(toEnvelope("memory.capture", input)));
    }

    if (toolName === ASM_MEMORY_TOOL_NAMES.recall) {
      const response = await this.runtime.adapter.execute(toEnvelope("memory.search", {
        ...input,
        minScore: input.minScore,
      }));
      return toToolResponse(response);
    }

    if (toolName === ASM_MEMORY_TOOL_NAMES.feedback) {
      return {
        ok: true,
        correlationId: randomUUID(),
        decision: "accepted",
        reasonCodes: ["feedback_recorded_stub"],
        data: {
          memoryId: asString(input.memoryId),
          feedback: asString(input.feedback),
          reason: asString(input.reason),
        },
      };
    }

    return {
      ok: false,
      correlationId: randomUUID(),
      decision: "rejected",
      reasonCodes: ["unknown_tool"],
      data: { toolName },
    };
  }

  async onEvent(eventName: string, payload: unknown) {
    const input = asRecord(payload);

    if (eventName === ASM_MEMORY_EVENT_NAMES.activityLogged || eventName === ASM_MEMORY_EVENT_NAMES.runFinished) {
      const summary = asString(input.summary) || asString(input.outputText) || asString(input.result);
      if (!summary) {
        return { accepted: false, reasonCodes: ["empty_event_payload"] };
      }

      const response = await this.runtime.adapter.execute(toEnvelope("memory.capture", {
        text: summary,
        source: `event:${eventName}`,
        context: input.context,
        namespace: input.namespace,
      }));
      return { accepted: response.ok, reasonCodes: response.ok ? ["captured"] : [String(response.error?.code || "capture_failed").toLowerCase()] };
    }

    if (eventName === ASM_MEMORY_EVENT_NAMES.runStarted || eventName === ASM_MEMORY_EVENT_NAMES.runFailed) {
      return { accepted: true, reasonCodes: ["event_acknowledged"] };
    }

    return { accepted: false, reasonCodes: ["event_not_supported"] };
  }

  async runJob(jobName: string, _payload?: unknown) {
    if ([ASM_MEMORY_JOB_NAMES.captureCompact, ASM_MEMORY_JOB_NAMES.recallQualityCheck, ASM_MEMORY_JOB_NAMES.fallbackSync].includes(jobName as any)) {
      return { ok: true, reason: `${jobName}_noop`, processed: 0 };
    }
    return { ok: false, reason: "unknown_job" };
  }

  async getData(key: string, params?: unknown) {
    if (key === "recall.preview" || key === "recall.history") {
      const response = await this.runtime.adapter.execute(toEnvelope("memory.search", {
        ...(asRecord(params)),
        query: asString(asRecord(params).query) || "*",
        minScore: 0,
      }));
      return { ok: response.ok, data: response.ok ? response.data : response.error };
    }
    return { ok: false, data: { reasonCodes: ["unknown_data_key"], key } };
  }

  async performAction(action: string, payload?: unknown) {
    return { ok: false, reason: "not_implemented", action, payload: asRecord(payload) };
  }
}

export function createAsmMemoryWorker() {
  return new AsmMemoryPaperclipWorker();
}

const singletonWorker = createAsmMemoryWorker();

export function initialize(input?: HostWorkerInput) {
  return singletonWorker.initialize(input);
}

export function health() {
  return singletonWorker.health();
}

export function shutdown() {
  return singletonWorker.shutdown();
}

export function executeTool(toolName: string, payload: unknown) {
  return singletonWorker.executeTool(toolName, payload);
}

export function onEvent(eventName: string, payload: unknown) {
  return singletonWorker.onEvent(eventName, payload);
}

export function runJob(jobName: string, payload?: unknown) {
  return singletonWorker.runJob(jobName, payload);
}

export function getData(key: string, params?: unknown) {
  return singletonWorker.getData(key, params);
}

export function performAction(action: string, payload?: unknown) {
  return singletonWorker.performAction(action, payload);
}
