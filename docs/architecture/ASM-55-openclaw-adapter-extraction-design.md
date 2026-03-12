# ASM-55 — Thiết kế tách OpenClaw adapter khỏi memory core

> Issue: ASM-55 (Sub-task của ASM-43)  
> Strategy: code_light (thiết kế + lộ trình bóc tách, chưa đổi runtime)

## 1) Mục tiêu

Thiết kế biên kiến trúc để memory core **không phụ thuộc trực tiếp OpenClaw runtime**; OpenClaw chỉ còn là một adapter ở outer layer.

Mục tiêu cụ thể:
- Xác định interface adapter tối thiểu giữa core và runtime.
- Chuẩn hóa mapping responsibility (tool payload ↔ core contract).
- Đề xuất kế hoạch bóc tách theo pha, giảm rủi ro breaking change.

## 2) Bối cảnh hiện tại (từ ASM-53/54)

- ASM đã có baseline phân lớp `core / services / adapters` (ASM-53).
- Đã có contract `MemoryContext`, `MemoryNamespace`, `MemoryError`, registry abstraction (ASM-54).
- Điểm cần chốt ở ASM-55: đặt OpenClaw vào đúng vai trò `runtime adapter` + xác định anti-corruption layer.

## 3) Đề xuất kiến trúc bóc tách OpenClaw adapter

## 3.1 Nguyên tắc

1. **Dependency direction một chiều**: `OpenClaw adapter -> memory core`, không ngược lại.
2. **Core không biết wire format OpenClaw** (tool args/ctx đặc thù).
3. **Error normalization tại adapter biên** trước khi trả về runtime.
4. **Compatibility-first**: giữ API plugin hiện hành, chỉ thay wiring nội bộ.

## 3.2 Boundary interfaces (type-level)

```ts
// core-facing input chuẩn hóa bởi adapter
export interface CoreRequestEnvelope<TPayload> {
  context: MemoryContext;
  namespace?: MemoryNamespace;
  payload: TPayload;
  meta?: {
    source: 'openclaw' | 'cli' | 'test';
    traceId?: string;
    toolName?: string;
  };
}

// adapter contract để runtime gọi use-case core
export interface MemoryUseCasePort {
  run<TReq, TRes>(
    useCase: 'slot.get' | 'slot.set' | 'slot.list' | 'slot.delete' | 'memory.capture' | 'memory.search',
    req: CoreRequestEnvelope<TReq>
  ): Promise<TRes>;
}

// adapter-level mapper từ OpenClaw context sang core context
export interface RuntimeContextMapper<TRuntimeCtx> {
  toMemoryContext(runtimeCtx: TRuntimeCtx): MemoryContext;
  toNamespace(input: unknown): MemoryNamespace | undefined;
}

// adapter-level presenter để map core error -> runtime response shape
export interface RuntimeErrorPresenter<TRuntimeErr> {
  fromMemoryError(error: MemoryError): TRuntimeErr;
}
```

## 3.3 Module layout đề xuất

```text
src/
  core/
    contracts/
    usecases/
  services/
    registry/
    validation/
  adapters/
    openclaw/
      openclaw-context-mapper.ts
      openclaw-error-presenter.ts
      openclaw-tool-router.ts
      openclaw-plugin-bootstrap.ts
    cli/
    test/
```

Vai trò:
- `openclaw-tool-router`: nhận tool call, chọn use-case core.
- `openclaw-context-mapper`: map runtime ctx + input cũ -> contract mới.
- `openclaw-error-presenter`: chuẩn hóa lỗi từ `MemoryError` sang output runtime.
- `openclaw-plugin-bootstrap`: chỉ composition/wiring, không chứa business logic.

## 4) Mapping responsibilities (RACI gọn)

- **OpenClaw Adapter**
  - Parse/validate input wire-level.
  - Map `ctx` runtime -> `MemoryContext`.
  - Map fields `scope/category/key` -> `MemoryNamespace`.
  - Chuyển lỗi core -> runtime error shape.

- **Memory Core / Services**
  - Validate invariants nghiệp vụ (namespace/context rules).
  - Thực thi use-case, gọi registry/capabilities.
  - Trả `MemoryError` chuẩn nếu fail.

- **Infrastructure adapters (slot/vector/graph)**
  - Triển khai capability cụ thể.
  - Không truy cập trực tiếp OpenClaw context.

## 5) Kế hoạch bóc tách theo pha (không breaking)

### Phase A — Introduce adapter seams
- Thêm `MemoryUseCasePort`, mapper/presenter interfaces.
- Dựng `openclaw-tool-router` gọi qua port, chưa đổi hành vi external.

### Phase B — Move mapping out of core
- Chuyển toàn bộ mapping runtime-specific khỏi services/core sang `openclaw-context-mapper`.
- Core chỉ nhận `CoreRequestEnvelope` chuẩn hóa.

### Phase C — Isolate bootstrap
- Tách phần đăng ký tool/plugin OpenClaw vào `openclaw-plugin-bootstrap`.
- Bảo đảm bootstrap chỉ composition, không logic domain.

### Phase D — Enable strict boundaries
- Bật lint/contract test cấm import ngược `core -> adapters/openclaw`.
- Theo dõi telemetry lỗi mapping/contract.

## 6) Quyết định kỹ thuật và trade-off

1. **Dùng anti-corruption layer tại adapter**
   - Ưu: chặn runtime leakage vào core.
   - Trade-off: tăng số lớp map/presenter cần test.

2. **UseCasePort generic thay vì gọi service trực tiếp**
   - Ưu: testability cao, dễ thay runtime.
   - Trade-off: cần chuẩn hóa tên use-case và typing discipline.

3. **Giữ compatibility wire-level ở ASM-55**
   - Ưu: rollout an toàn.
   - Trade-off: tạm thời tồn tại dual-path mapping trong thời gian ngắn.

## 7) Checklist câu hỏi mở (cho ASM-56/57)

- [ ] Có cần tách read/write ports riêng để giảm coupling use-case?
- [ ] Có cần batch API cho `slot.get/list` để giảm overhead adapter?
- [ ] Mapping error code -> runtime status/message nên centralized ở presenter hay theo tool?
- [ ] Cần policy rõ cho telemetry fields bắt buộc (`traceId`, `requestId`, `toolName`)?
- [ ] Khi nào có thể deprecate hoàn toàn legacy direct wiring?

## 8) Tiêu chí xác nhận hoàn tất ASM-55

- Có tài liệu thiết kế độc lập cho adapter extraction.
- Chỉ rõ interface boundary + mapping responsibility + phase plan.
- Có quyết định kỹ thuật, trade-off và checklist mở cho bước kế tiếp.

## 9) Kết luận

ASM-55 chốt thiết kế tách OpenClaw thành runtime adapter độc lập, với boundary contract rõ ràng để core giữ tính runtime-agnostic. Thiết kế này kế thừa ASM-53/54 và tạo nền cho implementation phases kế tiếp mà không phá compatibility ở plugin hiện tại.
