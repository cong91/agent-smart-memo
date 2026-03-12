# ASM-54 — Thiết kế registry abstraction + namespace/context contract

> Issue: ASM-54 (Sub-task của ASM-43)  
> Strategy: code_light (thiết kế contract + migration plan, chưa refactor runtime)

## 1) Mục tiêu thiết kế

Định nghĩa một contract thống nhất cho:
- **Registry abstraction**: cơ chế đăng ký và resolve memory adapters/services theo capability.
- **Namespace/context contract**: chuẩn dữ liệu đầu vào/đầu ra giữa hooks, tools, services.
- **Error model**: mã lỗi + metadata để observability và debug nhất quán.
- **Backward compatibility**: tương thích API/plugin hiện có trong giai đoạn migration.

## 2) Registry abstraction (đề xuất)

## 2.1 Khái niệm
Registry là lớp trung gian để tách **use-case orchestration** khỏi concrete implementations (`SlotDB`, `Qdrant`, embedding provider, graph store).

## 2.2 Capability keys
Các capability tối thiểu:
- `slot.store`
- `graph.store`
- `vector.store`
- `embedding.provider`
- `dedupe.service`
- `extractor.service`
- `clock`
- `id.generator`

## 2.3 Interface đề xuất (type-level)
```ts
export type CapabilityKey =
  | 'slot.store'
  | 'graph.store'
  | 'vector.store'
  | 'embedding.provider'
  | 'dedupe.service'
  | 'extractor.service'
  | 'clock'
  | 'id.generator';

export interface MemoryRegistry {
  register<T>(key: CapabilityKey, impl: T, meta?: RegistryMeta): void;
  resolve<T>(key: CapabilityKey, ctx: MemoryContext): T;
  has(key: CapabilityKey, ctx?: Partial<MemoryContext>): boolean;
  list(): RegistryEntry[];
}

export interface RegistryMeta {
  scope?: 'global' | 'agent' | 'session';
  priority?: number;          // fallback/override strategy
  tags?: string[];            // e.g. ['openclaw', 'local-first']
  deprecated?: boolean;
}
```

## 2.4 Resolution rules
1. Resolve theo thứ tự: `session > agent > global`.
2. Cùng scope: chọn `priority` cao hơn.
3. Nếu trùng key + priority: fail-fast với `REGISTRY_CONFLICT`.
4. Không tìm thấy impl: trả lỗi chuẩn `REGISTRY_MISSING_CAPABILITY`.

## 3) Namespace/context contract (đề xuất)

## 3.1 Namespace model
```ts
export type MemoryScope = 'private' | 'team' | 'public';

export interface MemoryNamespace {
  scope: MemoryScope;
  category: 'profile' | 'preferences' | 'project' | 'environment' | 'custom';
  key?: string;               // dot-notation (optional cho list/search)
  tags?: string[];
}
```

## 3.2 Context model (runtime-agnostic)
```ts
export interface MemoryContext {
  agentId: string;
  sessionId?: string;
  userId?: string;
  requestId?: string;
  runtime: 'openclaw' | 'cli' | 'test';
  mode?: 'read' | 'write' | 'search' | 'capture';
  timestampMs: number;
}
```

## 3.3 Namespace + context invariants
- `scope=private` ⇒ bắt buộc có `agentId`.
- `scope=team` ⇒ cần `userId` hoặc `sessionId` để audit trail.
- `scope=public` ⇒ cấm ghi đè key hệ thống (reserved prefix như `system.*`).
- `category=custom` ⇒ bắt buộc `key` rõ ràng (không wildcard khi write).

## 3.4 Compatibility mapping
Để tương thích tool hiện tại:
- `memory_slot_set/get/list/delete` giữ nguyên input API hiện hữu.
- Adapter layer chịu trách nhiệm map input cũ -> `MemoryNamespace` + `MemoryContext` mới.
- Không đổi wire contract bên ngoài trong ASM-54.

## 4) Error model contract

```ts
export type MemoryErrorCode =
  | 'REGISTRY_MISSING_CAPABILITY'
  | 'REGISTRY_CONFLICT'
  | 'NAMESPACE_INVALID'
  | 'NAMESPACE_FORBIDDEN'
  | 'CONTEXT_INCOMPLETE'
  | 'COMPAT_MAPPING_FAILED'
  | 'STORE_UNAVAILABLE'
  | 'VECTOR_BACKEND_ERROR';

export interface MemoryError {
  code: MemoryErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

Nguyên tắc:
- Tool/hook không throw raw error trực tiếp ra ngoài.
- Luôn normalize về `MemoryError` để log + test assertions nhất quán.

## 5) Quyết định kỹ thuật & trade-off

1. **Registry tách khỏi concrete adapter**
   - Ưu: giảm coupling, test doubles dễ hơn.
   - Trade-off: thêm lớp indirection, cần tài liệu rõ để tránh “over-engineer”.

2. **Context runtime-agnostic**
   - Ưu: tái dùng cho OpenClaw/CLI/test.
   - Trade-off: cần adapter mapping ở biên runtime.

3. **Compatibility-first ở ASM-54**
   - Ưu: không phá plugin API hiện tại.
   - Trade-off: tạm thời tồn tại dual-model (old input + new contract) tới phase impl.

4. **Fail-fast với conflict**
   - Ưu: tránh behavior mơ hồ khi nhiều implementation cùng key.
   - Trade-off: cần quy trình override minh bạch khi deploy multi-environment.

## 6) Checklist câu hỏi mở cho phase implementation (ASM-55+)

- [ ] Có cần generic `PolicyEngine` capability riêng hay giữ ở service layer?
- [ ] Registry nên immutable sau bootstrap hay cho phép dynamic re-register?
- [ ] Conflict resolution có cần deterministic tie-break theo adapter name/version?
- [ ] Error codes có cần mapping trực tiếp sang HTTP status ở adapter web?
- [ ] Cần telemetry schema riêng cho event `registry.resolve`/`namespace.validate`?

## 7) Gợi ý migration không breaking

1. Phase A: thêm types/contracts + contract tests (không đổi runtime behavior).
2. Phase B: tạo compat adapter map input cũ sang contract mới.
3. Phase C: chuyển dần hooks/tools resolve dependency qua registry.
4. Phase D: bật strict validation (feature flag), theo dõi metrics lỗi.
5. Phase E: deprecate đường cũ khi error rate ổn định.

## 8) Kết luận

ASM-54 chốt được bản thiết kế registry abstraction và namespace/context contract ở mức có thể review độc lập, đủ làm baseline cho các task implementation tiếp theo (ASM-55..ASM-57) mà vẫn giữ an toàn tương thích ngược ở runtime hiện tại.
