import {
  parseExplicitNamespace,
  type MemoryNamespace,
} from "../../shared/memory-config.js";
import type {
  MemoryContext,
  RuntimeContextMapper,
} from "../../core/contracts/adapter-contracts.js";
import type { PaperclipRuntimeContext } from "./contracts.js";

export class PaperclipContextMapper
  implements RuntimeContextMapper<PaperclipRuntimeContext | undefined>
{
  toMemoryContext(runtimeCtx: PaperclipRuntimeContext | undefined): MemoryContext {
    return {
      userId: runtimeCtx?.userId?.trim() || "default",
      agentId: "paperclip",
      sessionId: runtimeCtx?.sessionId?.trim() || undefined,
      traceId: runtimeCtx?.traceId?.trim() || undefined,
      metadata: {
        workspaceId: runtimeCtx?.workspaceId,
        locale: runtimeCtx?.locale,
        ...(runtimeCtx?.metadata || {}),
      },
    };
  }

  toNamespace(input: unknown): MemoryNamespace | undefined {
    if (typeof input !== "string" || input.trim().length === 0) {
      return undefined;
    }
    return parseExplicitNamespace(input, "assistant");
  }
}
