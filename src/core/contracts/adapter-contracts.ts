import type { MemoryNamespace } from "../../shared/memory-config.js";

export interface MemoryContext {
  userId: string;
  agentId: string;
  sessionId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface CoreRequestEnvelope<TPayload> {
  context: MemoryContext;
  namespace?: MemoryNamespace;
  payload: TPayload;
  meta?: {
    source: "openclaw" | "paperclip" | "cli" | "test";
    traceId?: string;
    toolName?: string;
    requestId?: string;
  };
}

export type MemoryUseCaseName =
  | "slot.get"
  | "slot.set"
  | "slot.list"
  | "slot.delete"
  | "project.register"
  | "project.get"
  | "project.list"
  | "project.set_registration_state"
  | "project.set_tracker_mapping"
  | "project.register_command"
  | "project.link_tracker"
  | "project.trigger_index"
  | "project.reindex_diff"
  | "project.index_event"
  | "project.install_hooks"
  | "project.index_watch_get"
  | "project.task_registry_upsert"
  | "project.task_lineage_context"
  | "project.hybrid_search"
  | "project.change_overlay.query"
  | "project.legacy_backfill"
  | "project.telegram_onboarding"
  | "project.feature_pack.generate"
  | "project.feature_pack.query"
  | "project.developer_query"
  | "memory.capture"
  | "memory.search"
  | "graph.entity.get"
  | "graph.entity.set"
  | "graph.rel.add"
  | "graph.rel.remove"
  | "graph.search"
  | "graph.code.upsert"
  | "graph.code.chain";

export interface MemoryUseCasePort {
  run<TReq, TRes>(
    useCase: MemoryUseCaseName,
    req: CoreRequestEnvelope<TReq>,
  ): Promise<TRes>;
}

export interface RuntimeContextMapper<TRuntimeCtx> {
  toMemoryContext(runtimeCtx: TRuntimeCtx): MemoryContext;
  toNamespace(input: unknown): MemoryNamespace | undefined;
}

export interface RuntimeErrorPresenter<TRuntimeErr> {
  fromMemoryError(error: unknown): TRuntimeErr;
}
