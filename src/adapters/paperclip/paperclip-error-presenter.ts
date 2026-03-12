import type { RuntimeErrorPresenter } from "../../core/contracts/adapter-contracts.js";

export interface PaperclipError {
  code: string;
  message: string;
}

export class PaperclipErrorPresenter implements RuntimeErrorPresenter<PaperclipError> {
  fromMemoryError(error: unknown): PaperclipError {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    if (/unknown namespace|namespace cannot be empty/i.test(message)) {
      return { code: "VALIDATION_ERROR", message };
    }
    if (/not found/i.test(message)) {
      return { code: "NOT_FOUND", message };
    }
    return { code: "INTERNAL_ERROR", message };
  }
}
