# ASM-53 — Audit ranh giới module ASM (core/services/adapters)

> Issue: ASM-53 (Sub-task của ASM-43)  
> Scope: Audit hiện trạng module boundaries, dependencies, coupling points và vi phạm layering.  
> Non-goal: Chưa refactor/đổi code runtime ở ticket này.

## 1) Inventory module hiện tại

### 1.1 Entry + composition
- `src/index.ts`
  - Vai trò: composition root/plugin bootstrap.
  - Trách nhiệm:
    - Resolve config/runtime paths.
    - Khởi tạo `SlotDB`, `QdrantClient`, `EmbeddingClient`, `DeduplicationService`.
    - Register tools (`slot`, `graph`, `memory_search`, `memory_store`).
    - Register hooks (`auto-recall`, `auto-capture`, `tool-context-injector`).

### 1.2 Data/infra layer
- `src/db/slot-db.ts`, `src/db/graph-db.ts`
  - Persistence local (SQLite) cho slots + graph.
- `src/services/qdrant.ts`
  - Vector DB adapter (Qdrant HTTP).
- `src/services/embedding.ts`, `src/services/embedding-capability-registry.ts`
  - Embedding provider adapter + capability/routing.

### 1.3 Domain/service logic
- `src/services/dedupe.ts`
  - Dedup heuristic cho semantic memory.
- `src/services/llm-extractor.ts`
  - Distillation/extraction orchestration (LLM + fallback).

### 1.4 Application-facing adapters
- `src/tools/*.ts`
  - MCP-style tools exposed to OpenClaw runtime.
- `src/hooks/*.ts`
  - Lifecycle integration points (`agent_end`, pre-response injection).

### 1.5 Shared cross-cutting
- `src/shared/memory-config.ts`, `src/shared/slotdb-path.ts`
  - Namespace/scope policy + path resolution.
- `src/types.ts`, `src/types/essence-distiller.ts`
  - Shared types/contracts.

---

## 2) Current boundary map (as-is)

## Đề xuất phân lớp logic từ hiện trạng
- **Core (nên là nơi chứa rules + contracts thuần):**
  - Hiện phân tán trong `shared/*`, `types/*`, một phần trong `services/*`.
- **Services (orchestration/use-case):**
  - `auto-capture`, `auto-recall`, `llm-extractor`, `dedupe`.
- **Adapters (IO/runtime boundary):**
  - `tools/*`, `hooks/*`, `db/*`, `qdrant`, `embedding`, OpenClaw plugin API.

## Luồng phụ thuộc chính (hiện tại)
- `index.ts` -> `db/services/tools/hooks/shared`
- `hooks/auto-capture.ts` -> `db + qdrant + embedding + dedupe + llm-extractor + shared`
- `tools/slot-tools.ts`, `tools/graph-tools.ts` -> `db + shared`
- `services/llm-extractor.ts` -> `db/shared`

=> Composition đang tập trung tốt tại `index.ts`, nhưng **domain policy chưa được tách rõ thành core layer độc lập**.

---

## 3) Coupling points và vi phạm layering

## 3.1 Coupling cao
1. **`auto-capture` coupling đa hướng**
   - Vừa làm orchestration business, vừa thao tác persistence (SlotDB), vector storage (Qdrant), embedding, dedupe, namespace routing, TTL logic.
   - Hệ quả: khó unit-test cô lập; thay đổi policy ảnh hưởng rộng.

2. **Tool adapters giữ state singleton runtime**
   - `slot-tools.ts` và `graph-tools.ts` duy trì `dbInstances` + `runtimeConfig` static trong module.
   - Hệ quả: stateful adapter khó kiểm soát lifecycle, khó test song song, khó tái sử dụng ngoài OpenClaw.

3. **Namespace/policy logic rải rác**
   - `shared/memory-config.ts` + logic rẽ nhánh trong hook/tool.
   - Hệ quả: policy drift khi mở rộng scope/namespace.

## 3.2 Vi phạm layering (as-is)
1. **Adapter biết quá nhiều policy domain**
   - Hook/tool không chỉ map I/O mà còn chứa quyết định nghiệp vụ (noise quarantine, distill mode, transition logic).

2. **Service phụ thuộc trực tiếp hạ tầng cụ thể**
   - Nhiều nơi gọi trực tiếp `SlotDB/QdrantClient` thay vì qua port/interface use-case.

3. **Thiếu explicit contract giữa core <-> adapters**
   - Chưa có bộ interface/port chuẩn cho MemoryStore, GraphStore, VectorStore, EventSink.

---

## 4) Quyết định kỹ thuật & trade-off (audit outcome)

1. **Giữ composition root tại `index.ts`**
   - Ưu điểm: điểm vào rõ ràng, backward compatible.
   - Trade-off: cần tăng DI discipline để tránh truyền concrete class xuyên suốt.

2. **Đề xuất tách “policy + use-case” ra core/services thuần**
   - Ưu điểm: testability cao hơn, giảm blast radius.
   - Trade-off: cần migration theo phase để tránh breaking API plugin.

3. **Giữ adapters hiện hữu cho tương thích runtime**
   - Ưu điểm: không phá contract tool/hook hiện tại.
   - Trade-off: tạm chấp nhận lớp adapter còn dày trước khi tách dần.

---

## 5) Checklist câu hỏi mở cho bước tiếp theo (ASM-54+)

- [ ] Bộ **ports/interfaces** tối thiểu cho core gồm những gì? (SlotRepo, VectorRepo, GraphRepo, PolicyEngine, Clock, IdGen)
- [ ] Namespace contract chuẩn hóa theo enum/type-safe hay giữ string linh hoạt?
- [ ] Runtime singleton trong tools có thay bằng scoped factory/registry theo context không?
- [ ] Ranh giới giữa `services` và `hooks/tools` cần chuẩn hóa theo pattern nào (application service + thin adapter)?
- [ ] Chiến lược migration không downtime cho plugin API hiện hữu (compat layer, deprecation window)?

---

## 6) Kết luận audit ASM-53

- Đã xác định rõ inventory module và dependency edges chính.
- Đã chỉ ra các điểm coupling/vi phạm layering quan trọng nhất (đặc biệt ở auto-capture và adapter statefulness).
- Đã chốt baseline để triển khai phase thiết kế abstraction/contract tiếp theo (ASM-54..ASM-57).

**Trạng thái đề xuất:** ASM-53 có thể chuyển **Done** sau khi ghi evidence lên Jira (commit + comment + transition).