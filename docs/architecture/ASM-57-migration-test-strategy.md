# ASM-57 — Migration & test strategy cho ASM refactor

> **Historical note (2026-04-09, bead agent-smart-memo-r4t.26):** Paperclip support was removed from active ASM runtime/package/test surfaces. Any Paperclip references below are archived design history, not current supported runtime behavior.

> Issue: ASM-57 (Sub-task của ASM-43)
>
> Strategy: `code_with_build` (ra tài liệu triển khai + verify build để đảm bảo baseline không vỡ)

## 1) Mục tiêu

Thiết kế kế hoạch migration theo pha cho refactor kiến trúc ASM (core/services/adapters), đồng thời chốt test strategy và checklist rollout/rollback để giảm rủi ro breaking change.

Mục tiêu cụ thể:

- Có lộ trình migration rõ ràng, incremental, có điểm kiểm soát.
- Có chiến lược test theo tầng: unit, integration, contract, regression.
- Có tiêu chí go/no-go trước khi bật strict mode và trước khi deprecate đường cũ.
- Có checklist vận hành rollback nhanh theo feature flag.

## 2) Input/baseline kế thừa (ASM-53..56)

- **ASM-53**: audit boundary + điểm coupling.
- **ASM-54**: chốt contract nền (registry abstraction, namespace/context, error model).
- **ASM-55**: chốt boundary extraction cho OpenClaw adapter.
- **ASM-56**: chốt blueprint compatibility-first cho Paperclip adapter.

ASM-57 dùng các baseline trên để chốt **kế hoạch migration thực thi** và **test strategy end-to-end**.

## 3) Kế hoạch migration theo pha

## Phase 0 — Contract freeze & compatibility inventory

**Mục tiêu**: đóng băng contract baseline trước khi đổi runtime.

Deliverables:

- Danh sách contract chuẩn dùng chung:
  - `MemoryContext`, `MemoryNamespace`, `MemoryError`, `CapabilityKey`.
- Inventory các API/hook/tool đang public (wire shape hiện tại) để chống drift.
- Mapping matrix `legacy input -> canonical contract`.

Exit criteria:

- Không đổi runtime behavior.
- Có test contract snapshot cho payload chính.

## Phase 1 — Introduce compatibility adapters (không đổi caller)

**Mục tiêu**: thêm adapter map input cũ sang use-case port mới, giữ wire behavior cũ.

Deliverables:

- `openclaw-compat-adapter` (nếu chưa complete theo ASM-55).
- `paperclip-compat-adapter` skeleton theo ASM-56.
- `error-presenter` chuẩn hoá lỗi theo `MemoryError`.

Exit criteria:

- Caller hiện tại không cần đổi code.
- Tỷ lệ pass regression contract >= 100% cho golden payloads.

## Phase 2 — Internal dependency switch to registry/use-case

**Mục tiêu**: chuyển dần logic nội bộ sang `MemoryUseCasePort` + registry resolve.

Deliverables:

- Thay thế direct dependency access bằng registry capability resolution.
- Thêm telemetry event:
  - `registry.resolve` (key, scope, outcome, latency)
  - `namespace.validate` (status, violation)

Exit criteria:

- Build xanh, unit/integration pass.
- Không tăng lỗi runtime vượt ngân sách (error budget) đã định.

## Phase 3 — Strict validation under feature flag

**Mục tiêu**: bật validate chặt cho namespace/context nhưng có kill-switch.

Deliverables:

- Feature flags đề xuất:
  - `ASM_STRICT_NAMESPACE_VALIDATION`
  - `ASM_STRICT_CONTEXT_VALIDATION`
  - `ASM_ADAPTER_PAPERCLIP_ENABLED`
- Runbook bật/tắt theo tenant/session (nếu có scope).

Exit criteria:

- Canary pass theo KPI.
- No P0/P1 incidents trong cửa sổ theo dõi.

## Phase 4 — Deprecation & cleanup

**Mục tiêu**: loại bỏ đường cũ khi ổn định.

Deliverables:

- Deprecation notice (versioned) + timeline.
- Gỡ bypass path legacy đã có đường thay thế.
- Cập nhật README/ops docs.

Exit criteria:

- Error rate trong ngưỡng ổn định.
- Adoption contract mới đạt target.

## 4) Test strategy (unit/integration/contract/regression)

## 4.1 Unit tests

Phạm vi:

- Mapper tests:
  - context mapper (OpenClaw/Paperclip -> `MemoryContext`)
  - namespace mapper (legacy -> canonical)
- Error presenter tests (`MemoryError` -> adapter response codes)
- Registry resolution tests:
  - ưu tiên scope (`session > agent > global`)
  - conflict handling (`REGISTRY_CONFLICT`)

Tiêu chí:

- Branch coverage ưu tiên các đường lỗi/edge cases.
- Bắt buộc test cho reserved namespace (`system.*`) và `category=custom`.

## 4.2 Integration tests

Phạm vi:

- Adapter -> UseCasePort -> store path (happy + sad path).
- Feature-flag behavior (strict on/off).
- Retry/idempotency (nếu bật ở adapter/service).

Tiêu chí:

- Có scenario timeout/transient error để verify retry policy không gây duplicate side-effects.
- Có scenario missing context/namespace invalid.

## 4.3 Contract tests (anti-drift)

Phạm vi:

- Golden payload tests cho public tools/API hiện hữu:
  - `memory_slot_set/get/list/delete`
  - graph-related payload shape
- Snapshot response shape cho từng adapter runtime (OpenClaw/Paperclip).

Tiêu chí:

- Contract tests là gate bắt buộc trước merge.
- Mọi thay đổi payload phải đi kèm migration note và version bump phù hợp.

## 4.4 Regression & compatibility tests

Phạm vi:

- Chạy bộ smoke/regression ở chế độ legacy + strict mode.
- So sánh outcome (`status`, `error_code`, side-effects) giữa trước/sau migration.

Tiêu chí:

- Không regression ở hành vi đã cam kết.
- Nếu khác biệt có chủ đích phải có changelog + deprecation note.

## 5) Rollout checklist

- [ ] Freeze contract + cập nhật docs baseline.
- [ ] Bật metrics/dashboard cho error rate/latency theo action.
- [ ] Enable flag theo canary cohort nhỏ.
- [ ] Theo dõi 24h/48h với SLO đã định.
- [ ] Mở rộng rollout theo từng wave.
- [ ] Chốt deprecation timeline đường cũ.

## 6) Rollback strategy

Rollback cấp 1 (nhanh):

- Tắt `ASM_STRICT_*` flags về chế độ compatibility.

Rollback cấp 2 (adapter):

- Tắt `ASM_ADAPTER_PAPERCLIP_ENABLED` để quay về OpenClaw-only path.

Rollback cấp 3 (release):

- Revert release về commit ổn định trước migration.
- Chạy lại contract smoke để xác nhận recovery.

Điều kiện kích hoạt rollback:

- Tăng đột biến `INTERNAL_ERROR`/`COMPAT_MAPPING_FAILED`.
- SLA latency vượt ngưỡng liên tục theo cửa sổ quan sát.
- Phát hiện data corruption hoặc duplicate side-effects.

## 7) Go / No-Go criteria

## Go

- Build + test gates pass.
- Contract regression pass 100% cho golden payloads.
- Canary đạt KPI (error rate, latency, retry outcome) trong ngưỡng.
- Có runbook rollback đã kiểm thử.

## No-Go

- Còn mismatch contract chưa có migration note.
- Chưa có telemetry tối thiểu hoặc không đọc được outcome theo trace.
- Tồn tại P1/P0 chưa đóng liên quan mapping/error normalization.

## 8) Quyết định kỹ thuật & trade-off

1. **Compatibility-first trước strictness**
   - Ưu: giảm blast radius.
   - Trade-off: tạm duy trì dual-path lâu hơn.

2. **Contract tests làm merge gate chính**
   - Ưu: chống drift wire/API hiệu quả.
   - Trade-off: tăng cost maintain snapshot/golden payloads.

3. **Feature flag cho strict validation và adapter rollout**
   - Ưu: rollback nhanh.
   - Trade-off: tăng complexity vận hành.

4. **Telemetry-first cho migration phases**
   - Ưu: quyết định rollout dựa trên dữ liệu.
   - Trade-off: overhead instrumentation ban đầu.

## 9) Checklist câu hỏi mở

- [ ] Tỷ lệ coverage tối thiểu cho contract tests nên đặt bao nhiêu để làm release gate?
- [ ] Có cần version hoá payload theo adapter (OpenClaw v1 / Paperclip v1) ngay từ phase đầu?
- [ ] Tie-break deterministic cho registry conflict có cần thêm `adapterName/version`?
- [ ] Có cần cơ chế replay-safe chuẩn hoá idempotency key ở mọi write path?
- [ ] Cửa sổ quan sát canary tối thiểu (24h/48h/72h) cho từng môi trường là bao nhiêu?

## 10) Kết luận

ASM-57 chốt migration plan theo pha + test strategy đa tầng + checklist rollout/rollback + tiêu chí go/no-go. Kế hoạch này bám sát baseline ASM-53..56 và ưu tiên compatibility-first để đảm bảo refactor kiến trúc ASM diễn ra an toàn, có đo lường và có khả năng quay lui nhanh khi cần.
