# Loop Guards and Deterministic Apply Layer (ASM-133 / r4t.17)

## Checklist of Loop Vectors

### Vectors Already Eliminated (Baseline)
- [x] **Heartbeat Loops**: Handled via `messageProvider === "heartbeat"` check, preventing re-scans of unchanged text.
- [x] **Internal Text Self-Triggering**: Handled via `hasAutoCaptureSource` check (matches `[AutoCapture]`, `Memory stored`).
- [x] **Unchanged Content Loops**: Handled via SlotDB `_autocapture_hash` deduplication over the last N messages.
- [x] **Synchronous Re-entrancy**: Handled via `isCapturing` lock mutex inside the hook.
- [x] **Recapture of Noise**: Handled by routing noise to `noise.filtered` and excluding it from canonical memory injection.

### Remaining Unsafe Loop Vectors (Addressed in r4t.17)
- [ ] **Event Metadata Bypass**: An event could be emitted (e.g. by a future agent capability) that doesn't use the `heartbeat` provider or exact filtered text, but still shouldn't be captured.
- [ ] **Distill Apply Lifecycle Recapture**: If the apply layer (SlotDB/Wiki writes) emits a status event or alters state in a way that triggers `AGENT_END_EVENT`, it could recapture its own output.
- [ ] **Tool Use Loops**: The `memory_auto_capture` tool processes and writes data, then the agent responds, triggering a new turn. The manual tool execution currently shares the same inline apply logic as the hook, risking mismatched guardrails.
- [ ] **Tangled Apply Logic**: The SlotDB and Wiki write operations are inline within the auto-capture hook, making it impossible to reuse the apply logic safely from an isolated continuation worker or manual tool without duplicating code and missing loop guards.

## Implementation of Deterministic Apply-Layer Guardrails
1. **Explicit Metadata Loop Guards**: Check `autoCaptureSkip`, `eventKind`, and `internalLifecycle` directly from `event.metadata` in `auto-capture.ts`.
2. **Deterministic Apply Usecase**: Extract the mutation logic (SlotDB/Wiki writes) into `DistillApplyUseCase` (e.g. `src/core/usecases/distill-apply-usecase.ts`). This ensures all distill writes use the same deterministic, non-capturable path, whether triggered by hook, tool, or isolated worker.
3. **Guardrail Enforced**: The apply usecase injects `autoCaptureSkip` and `internalLifecycle: "distill_apply"` into any metadata it touches, ensuring downstream subscribers know this is a distill write.
