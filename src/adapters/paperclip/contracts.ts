export interface PaperclipRuntimeContext {
  userId?: string;
  sessionId?: string;
  workspaceId?: string;
  traceId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

export interface PaperclipRequestEnvelope<TPayload> {
  action: string;
  payload: TPayload;
  context?: PaperclipRuntimeContext;
  namespace?: string;
}

export interface PaperclipResponseEnvelope<TData> {
  ok: boolean;
  data?: TData;
  error?: {
    code: string;
    message: string;
  };
}
