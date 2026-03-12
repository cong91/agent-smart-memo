import type {
  CoreRequestEnvelope,
  MemoryUseCasePort,
} from "../../core/contracts/adapter-contracts.js";
import type {
  PaperclipRequestEnvelope,
  PaperclipResponseEnvelope,
} from "./contracts.js";
import { PaperclipContextMapper } from "./paperclip-context-mapper.js";
import { PaperclipErrorPresenter } from "./paperclip-error-presenter.js";

export class PaperclipAdapter {
  constructor(
    private readonly useCasePort: MemoryUseCasePort,
    private readonly mapper = new PaperclipContextMapper(),
    private readonly errorPresenter = new PaperclipErrorPresenter(),
  ) {}

  async execute<TReq = unknown, TRes = unknown>(
    req: PaperclipRequestEnvelope<TReq>,
  ): Promise<PaperclipResponseEnvelope<TRes>> {
    try {
      const envelope: CoreRequestEnvelope<TReq> = {
        context: this.mapper.toMemoryContext(req.context),
        namespace: this.mapper.toNamespace(req.namespace),
        payload: req.payload,
        meta: {
          source: "paperclip",
          toolName: req.action,
          traceId: req.context?.traceId,
        },
      };

      const data = await this.useCasePort.run<TReq, TRes>(
        req.action as any,
        envelope,
      );

      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: this.errorPresenter.fromMemoryError(error) };
    }
  }
}
