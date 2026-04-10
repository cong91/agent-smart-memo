# ASM-56 — Thiết kế Paperclip adapter (compatibility-first)

> **Historical note (2026-04-09, bead agent-smart-memo-r4t.26):** Paperclip support was removed from active ASM runtime/package/test surfaces. Any Paperclip references below are archived design history, not current supported runtime behavior.

> Issue: ASM-56 (Sub-task của ASM-43)  
> Strategy: code_light (thiết kế + lộ trình tích hợp, **chưa đổi runtime code**)

## 1) Mục tiêu

Thiết kế `Paperclip adapter` theo hướng **compatibility-first** để có thể tích hợp vào kiến trúc memory core platform mà **không phá hành vi hiện tại** của plugin/runtime đang chạy.

Mục tiêu cụ thể:

- Xác định vai trò `Paperclip adapter` trong boundary `core / services / adapters`.
- Đề xuất **capability matrix** rõ ràng (must/should/later) cho giai đoạn rollout.
- Chốt **yêu cầu tối thiểu** để adapter có thể được tích hợp an toàn ở phase implementation.
- Liệt kê quyết định kỹ thuật + trade-off + checklist câu hỏi mở cho bước tiếp theo.

## 2) Bối cảnh kiến trúc kế thừa (ASM-53/54/55)

- ASM-53 đã audit baseline phân lớp và các điểm coupling.
- ASM-54 đã chốt contract nền: namespace/context/registry abstraction.
- ASM-55 đã chốt boundary runtime adapter cho OpenClaw và anti-corruption layer.

ASM-56 kế thừa các nguyên tắc trên để thêm một adapter mới (`Paperclip`) theo cùng triết lý:

- **Core runtime-agnostic**.
- Adapter chịu trách nhiệm map wire/runtime shape sang contract core.
- Rollout theo hướng không breaking.

## 3) Vai trò Paperclip adapter trong kiến trúc

`Paperclip adapter` là **runtime adapter** ngang hàng với `openclaw adapter`, có trách nhiệm:

1. Nhận request/context từ Paperclip runtime.
2. Chuẩn hóa thành `CoreRequestEnvelope` + `MemoryContext` + `MemoryNamespace`.
3. Gọi `MemoryUseCasePort` của core.
4. Map `MemoryError`/result về response shape tương thích Paperclip.

### 3.1 Boundary contract đề xuất (type-level)

```ts
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

export interface PaperclipAdapter {
  execute<TReq = unknown, TRes = unknown>(req: PaperclipRequestEnvelope<TReq>): Promise<TRes>;
}
```

Ghi chú:

- Đây là contract ở mức thiết kế để lock boundary; chưa áp vào runtime hiện tại.
- Mapping thực tế vẫn đi qua `MemoryUseCasePort` để giữ consistency với ASM-55.

## 4) Capability matrix (compatibility-first)

### 4.1 Phase-0 (Minimum viable compatibility) — MUST

| Capability                  | Mô tả                                                    | Trạng thái mong muốn |
| --------------------------- | -------------------------------------------------------- | -------------------- |
| Context mapping             | Map `userId/sessionId/workspaceId` -> `MemoryContext`    | Bắt buộc             |
| Namespace normalization     | Chuẩn hóa namespace đầu vào Paperclip theo contract core | Bắt buộc             |
| Slot read/write/delete/list | Route các thao tác slot cơ bản qua `MemoryUseCasePort`   | Bắt buộc             |
| Error normalization         | Map `MemoryError` -> mã lỗi/shape Paperclip ổn định      | Bắt buộc             |
| Backward compatibility mode | Giữ wire-level cũ (nếu có), không phá caller hiện tại    | Bắt buộc             |
| Observability cơ bản        | `traceId`, action, outcome, latency buckets              | Bắt buộc             |

### 4.2 Phase-1 (Operational hardening) — SHOULD

| Capability           | Mô tả                                                       | Trạng thái mong muốn |
| -------------------- | ----------------------------------------------------------- | -------------------- |
| Idempotency key      | Tránh duplicate side-effect khi retry timeout               | Nên có               |
| Retry policy rõ ràng | Retry có điều kiện cho lỗi transient                        | Nên có               |
| Contract tests       | Test chống drift giữa Paperclip wire shape và core contract | Nên có               |
| Feature flags        | Bật/tắt adapter theo env/tenant để rollout an toàn          | Nên có               |

### 4.3 Phase-2 (Extended capabilities) — LATER

| Capability              | Mô tả                                               | Trạng thái mong muốn |
| ----------------------- | --------------------------------------------------- | -------------------- |
| Batch APIs              | Gom nhiều thao tác slot giảm round-trip             | Để sau               |
| Streaming/event hooks   | Trả tiến trình theo event cho runtime hỗ trợ stream | Để sau               |
| Advanced policy plugins | Policy theo tenant/workspace/custom guardrails      | Để sau               |

## 5) Yêu cầu tối thiểu để tích hợp (integration minimum requirements)

## 5.1 Contract & mapping

- Có `paperclip-context-mapper` map runtime context -> `MemoryContext`.
- Có `paperclip-namespace-mapper` chuẩn hóa namespace/scope đầu vào.
- Tất cả call vào core đi qua `MemoryUseCasePort` (không gọi trực tiếp storage adapters).

## 5.2 Error handling

- Có `paperclip-error-presenter` chuẩn hóa:
  - `VALIDATION_ERROR`
  - `NOT_FOUND`
  - `CONFLICT`
  - `RATE_LIMITED` (nếu có)
  - `INTERNAL_ERROR`
- Không rò stack trace/internal detail ra runtime response mặc định.

## 5.3 Compatibility guardrails

- Giữ nguyên public behavior/wire shape đã cam kết với Paperclip caller.
- Nếu cần field mới, chỉ thêm theo hướng backward-compatible (optional fields).
- Có fallback path khi mapping thiếu field không-critical.

## 5.4 Observability & vận hành

- Log chuẩn hóa tối thiểu: `traceId`, `action`, `namespace`, `status`, `latencyMs`.
- Metric tối thiểu:
  - request_total (by action/status)
  - request_error_total (by error_code)
  - request_latency_ms (histogram)
- Có runbook rollback nhanh theo feature flag.

## 6) Thiết kế module layout đề xuất

```text
src/
  adapters/
    paperclip/
      paperclip-adapter.ts
      paperclip-tool-router.ts
      paperclip-context-mapper.ts
      paperclip-namespace-mapper.ts
      paperclip-error-presenter.ts
      paperclip-bootstrap.ts
```

Nguyên tắc:

- `paperclip-bootstrap.ts` chỉ làm composition.
- `paperclip-tool-router.ts` chỉ route action -> use-case.
- Không đặt business logic domain trong adapter layer.

## 7) Quyết định kỹ thuật và trade-off

1. **Compatibility-first rollout**
   - Quyết định: ưu tiên giữ API/wire behavior ổn định trước khi tối ưu.
   - Trade-off: tạm chấp nhận lớp mapping dày hơn trong giai đoạn đầu.

2. **UseCasePort làm entrypoint duy nhất vào core**
   - Ưu điểm: nhất quán với OpenClaw adapter, testability tốt.
   - Trade-off: cần governance chặt cho naming và schema use-case.

3. **Centralized error presenter tại adapter**
   - Ưu điểm: response nhất quán, giảm leak chi tiết nội bộ.
   - Trade-off: cần duy trì mapping table khi core error model mở rộng.

4. **Feature-flag rollout**
   - Ưu điểm: giảm blast radius, rollback nhanh.
   - Trade-off: tăng complexity vận hành giai đoạn chuyển tiếp.

## 8) Checklist câu hỏi mở (handoff cho ASM-57/implementation)

- [ ] Nên định danh action Paperclip theo enum cứng hay registry động?
- [ ] Namespace policy nên strict reject hay permissive normalize cho input legacy?
- [ ] Retry policy áp ở adapter hay ở caller/runtime?
- [ ] Mức telemetry bắt buộc tối thiểu cho debugging production là gì?
- [ ] Khi nào có thể bật mặc định Paperclip adapter cho tất cả tenant/workspace?
- [ ] Cần compatibility test suite riêng theo “golden payloads” hay tích hợp vào contract tests chung?

## 9) Tiêu chí xác nhận hoàn tất ASM-56 (cho scope thiết kế)

- Có tài liệu thiết kế độc lập, review được.
- Có capability matrix + minimum integration requirements.
- Có danh sách quyết định kỹ thuật, trade-off và open checklist.
- Chưa thay runtime code (đúng `code_light`).

## 10) Kết luận

ASM-56 chốt blueprint cho `Paperclip adapter` theo hướng compatibility-first, tương thích với ranh giới kiến trúc đã xác lập ở ASM-53/54/55. Thiết kế này đủ làm đầu vào cho phase implementation kế tiếp mà vẫn kiểm soát rủi ro breaking change ở runtime hiện hành.
