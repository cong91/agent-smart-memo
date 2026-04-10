# ASM-130 — Qdrant Export + Wiki Mapping Spec

## 1) Mục tiêu

Chuẩn bị nền deterministic để migrate semantic memory từ Qdrant sang LLM Wiki.

Deliverables phase 1 của lane này:

- export script draft để dump records từ Qdrant
- mapping spec từ Qdrant record -> canonical wiki pages

## 2) Scope

### In scope

- semantic memory records hiện được lưu trong Qdrant
- field export cần thiết cho batch grouping và later ingest
- canonical grouping rules để tránh file explosion

### Out of scope

- canonical project index artifacts
- project registry / source_rev / related_files / subsystem truth
- full migration executor/cutover automation

## 3) Export target

Script phase-1 hiện xuất ra JSON envelope (inspectable + deterministic), đủ để dùng cho batch ingest:

```json
{
  "collection": "...",
  "count": 123,
  "deterministicOrder": ["timestamp", "updatedAt", "id"],
  "options": {
    "batchSize": 256,
    "maxPoints": null,
    "withVector": false
  },
  "records": [ ... ]
}
```

JSONL vẫn là lựa chọn phase sau nếu cần stream pipeline, nhưng chưa bắt buộc cho lane này.

## 4) Minimum exported fields

Mỗi record xuất ra nên cố gắng giữ các field sau nếu có:

- `id`
- `text`
- `namespace`
- `timestamp`
- `updatedAt`
- `source_agent`
- `agent`
- `sessionId`
- `userId`
- `memory_scope`
- `memory_type`
- `promotion_state`
- `confidence`
- `metadata`

## 5) Export output shape (suggested)

```json
{
  "id": "...",
  "text": "...",
  "namespace": "agent.assistant.working_memory",
  "timestamp": 1712345678901,
  "updatedAt": 1712345679901,
  "source_agent": "assistant",
  "agent": "assistant",
  "sessionId": "agent:assistant:telegram:direct:5165741309",
  "userId": "5165741309",
  "memory_scope": "private",
  "memory_type": "working_memory",
  "promotion_state": "raw",
  "confidence": 0.82,
  "metadata": {}
}
```

## 6) Hard migration rule

**Never map 1 Qdrant point = 1 markdown file.**

Lý do:

- dễ tạo hàng trăm file rác
- mất canonical memory pages
- recall bằng wiki sẽ kém hơn thay vì tốt hơn

Migration phải group theo topic/page canonical.

## 7) Grouping strategy

### 7.1 Session-summary style records

Các record thuộc nhóm session/day summary nên group vào page theo ngày hoặc phiên:

```text
live/projects/<project>.md
or
live/concepts/session-<date>.md
or
live/sessions/YYYY-MM-DD.md   (nếu phase sau thêm thư mục sessions)
```

Phase 1 tối giản hiện ưu tiên `projects/` và `concepts/`; chưa bắt buộc mở rộng taxonomy nếu chưa cần.

### 7.2 Lessons / runbooks / decisions

Các record có tính reusable nên group vào:

```text
live/concepts/<topic>.md
```

Ví dụ:

- contamination lessons
- recall guardrails
- migration decisions
- troubleshooting/runbook topics

### 7.3 Working memory / preferences / stable context

Các record stable, lặp lại nhiều lần nên group vào:

```text
live/entities/<entity>.md
or
live/projects/<project>.md
```

Rule-of-thumb:

- nếu là user/team preference -> `entities/`
- nếu là project understanding -> `projects/`

### 7.4 Project-related semantic memory

Nếu semantic record nói về project understanding, known pitfalls, onboarding context, architectural notes:

```text
live/projects/<project>.md
```

Nhắc lại: đây chỉ là **project understanding wiki**, không thay canonical project index facts.

## 8) Suggested namespace -> destination mapping

| Namespace / type signal                      | Destination                                             |
| -------------------------------------------- | ------------------------------------------------------- |
| `session_summaries` / day-summary-like       | `live/concepts/session-<date>.md` hoặc grouped day page |
| `agent.*.lessons`                            | `live/concepts/<topic>.md`                              |
| `shared.runbooks`                            | `live/concepts/<topic>.md`                              |
| `agent.*.working_memory` stable/project-like | `live/projects/<project>.md`                            |
| `agent.*.working_memory` stable/entity-like  | `live/entities/<entity>.md`                             |
| preferences / durable user context           | `live/entities/user-preferences.md`                     |

## 9) Mapping examples

### Example A — lesson

Input:

- namespace: `agent.assistant.lessons`
- text: contamination issue root cause in project overlay enrichment

Output destination:

```text
live/concepts/project-index-contamination.md
```

### Example B — user preference

Input:

- namespace: `agent.assistant.working_memory`
- text: user prefers phase 1 minimalism and dislikes over-engineering

Output destination:

```text
live/entities/user-preferences.md
```

### Example C — project understanding

Input:

- namespace: `agent.assistant.working_memory`
- text: ASM should keep SlotDB and canonical project index unchanged while replacing Qdrant semantic memory

Output destination:

```text
live/projects/agent-smart-memo.md
```

## 10) Proposed export script location

Implemented file:

```text
src/scripts/export-qdrant-to-json.ts
```

## 11) Script requirements

- read configured Qdrant collection from ASM config/runtime config
- connect without changing data
- dump records in deterministic order where practical
- dry-run friendly
- produce inspectable JSON/JSONL artifact

### 11.1 Runtime config constraints (actual)

Script dùng `resolveAsmRuntimeConfig(...)` và sẽ fail fast nếu thiếu các field bắt buộc trong ASM shared config:

- `core.qdrantHost`
- `core.qdrantPort`
- `core.qdrantCollection`
- `core.qdrantVectorSize`

Config path resolution theo thứ tự:

1. explicit `configPath` input (nếu caller truyền)
2. `ASM_CONFIG` env var
3. default: `$HOME/.config/asm/config.json`

Do đó chạy script cần đảm bảo ASM config tồn tại ở 1 trong các path trên.

### 11.2 Implemented export behavior

`src/scripts/export-qdrant-to-json.ts` hiện đã có executable path thực tế:

- dùng `QdrantClient.scrollAll(...)` để paginate toàn bộ collection (read-only)
- normalize `id` về string ổn định (hỗ trợ id primitive hoặc object)
- normalize metadata thành object (fallback `{}`)
- sort deterministic ở cuối theo: `timestamp ASC` -> `updatedAt ASC` -> `id ASC`

Supported flags:

- `--out <path>` (default `artifacts/qdrant-export.json`)
- `--collection <name>` (default từ runtime config)
- `--batch-size <positive-int>` (default `256`)
- `--max-points <positive-int>` (optional cap để dry-run/sample)
- `--with-vector` (optional; include vectors khi scroll)

### 11.3 Known runtime limits (phase-1 acceptable)

- Export dùng paged scroll và post-sort deterministic trong script; thứ tự raw page từ Qdrant không được assume là canonical.
- Nếu collection có concurrent writes trong lúc export, snapshot không guaranteed tuyệt đối. Lane này chấp nhận vì mục tiêu là migration-prep deterministic artifact, chưa phải cutover-grade snapshot transaction.

## 12) Tightened rollout plan (memory layer only)

Scope lock cho rollout này:

- chỉ migration semantic memory Qdrant -> Wiki
- không migrate/chạm canonical project index artifacts
- không thay retrieval truth order đã chốt ở ASM-123 (`SlotDB -> project index -> wiki`)

### Phase 0 — Preflight + mapping freeze

Mục tiêu: chuẩn bị artifact và mapping đủ chắc trước khi chạy rollout.

Actions:

1. chạy export dry-run/sample từ collection thực bằng `--max-points`
2. inspect sample để xác nhận field coverage thực tế (`text/namespace/timestamp/...`)
3. chốt namespace -> destination mapping v1 cho migration batch
4. chốt danh sách recall cases dùng làm baseline validation

Exit gate (G0):

- sample records đã inspect và đủ để map vào `projects|concepts|entities`
- không có rule nào vi phạm hard rule `1 point != 1 file`
- có baseline recall checklist cho phase sau

### Phase 1 — Parallel write (safe shadow)

Mục tiêu: viết song song để đo coverage wiki mà chưa đổi read path chính.

Actions:

1. giữ Qdrant write path hiện tại
2. ghi song song vào wiki (raw/live) theo grouping rules
3. theo dõi mismatch class (record nào chưa map được canonical page)
4. fix mapping rules trước khi move sang wiki-first read

Exit gate (G1):

- không phát sinh pattern page explosion
- unmapped/misgrouped records đã được phân loại và có rule xử lý
- canonical project index behavior không thay đổi

### Phase 2 — Wiki-first read (Qdrant fallback)

Mục tiêu: chuyển read ưu tiên wiki nhưng giữ fallback để giảm rủi ro.

Actions:

1. route read semantic memory theo wiki-first
2. giữ Qdrant fallback cho missing classes
3. chạy bộ recall checks trước/sau với cùng tập case
4. log rõ các ca fallback để tinh chỉnh wiki pages/mapping

Exit gate (G2):

- recall quality đạt mức chấp nhận cho bộ case baseline
- fallback rate giảm về mức thấp và có xu hướng ổn định
- không có regression về project-aware answer vì project index vẫn là canonical source

### Phase 3 — Cutover + backup retention

Mục tiêu: cắt Qdrant khỏi primary semantic path có kiểm soát.

Actions:

1. chạy final export artifact (deterministic)
2. ingest batch vào canonical wiki pages theo mapping đã chốt
3. freeze Qdrant writes khỏi primary path
4. giữ snapshot/backup Qdrant cho rollback window

Status note after bead `agent-smart-memo-r4t.9`:

- primary semantic runtime path (`memory_store`, `memory_search`, `SemanticMemoryUseCase.search`, `auto-recall`) is expected to be wiki-only
- Qdrant compatibility may remain only for export/backup/rollback support and broader non-primary migration compatibility
- cutover is not the same as deleting every historical Qdrant-related utility immediately

Status note after bead `agent-smart-memo-r4t.10` (legacy auto-capture fallback cleanup):

- legacy auto-capture context fallback in `injectMemoryContext` no longer performs `embed + qdrant search` when short/mid-term context is missing
- auto-capture context injection now remains SlotDB short/mid-term only; no Qdrant-backed long-term semantic fallback in that helper
- remaining Qdrant usage is outside this fallback lane (migration/export/backup compatibility and broader runtime wiring not yet fully removed)

Exit gate (G3):

- wiki coverage đạt mức chấp nhận trên recall checklist
- không còn dependency Qdrant ở primary semantic read/write path
- backup artifact có thể dùng để restore trong rollback window

## 13) Validation gates (go/no-go)

Mỗi phase chỉ được đi tiếp khi pass gate tương ứng:

| Gate            | Must pass                                                             | Evidence tối thiểu                                        |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| G0 (preflight)  | mapping đủ bao phủ sample namespace, không vi phạm grouping hard rule | sample export artifact + mapping review notes             |
| G1 (parallel)   | wiki shadow write ổn định, không page explosion                       | diff/inspection của pages đại diện + mismatch summary     |
| G2 (wiki-first) | recall parity acceptable, fallback có kiểm soát                       | before/after recall checklist + fallback logs             |
| G3 (cutover)    | primary path không còn phụ thuộc Qdrant, backup sẵn sàng              | cutover checklist + backup location + restore drill notes |

Validation constraints (non-negotiable):

1. Không dùng wiki để thay canonical project-index facts.
2. Không mở rộng scope sang project registry/source_rev/subsystem truth.
3. Không chấp nhận triển khai nếu chưa có rollback path rõ ràng.

## 14) Rollback notes (by phase)

Rollback luôn giới hạn trong **memory layer**, không ảnh hưởng SlotDB hoặc project index.

### Rollback from Phase 1 (parallel write)

- action: disable wiki shadow write, tiếp tục Qdrant-only write path
- dữ liệu wiki đã tạo có thể giữ lại để forensics; không dùng làm primary recall

### Rollback from Phase 2 (wiki-first)

- action: flip read route về Qdrant-first ngay lập tức
- giữ wiki data để postmortem và chỉnh mapping, không xóa bắt buộc

### Rollback from Phase 3 (post-cutover)

- action: restore read/write semantic path từ Qdrant backup snapshot
- requirement: backup artifact + restore procedure phải được kiểm tra trước cutover
- note: rollback không thay đổi canonical project index pipeline

Backup retention note:

- giữ Qdrant backup trong một rollback window hữu hạn sau cutover (đề xuất: tối thiểu 1-2 release cycles)
- chỉ xem xét cleanup backup sau khi gate vận hành ổn định được xác nhận

## 15) Acceptance for this lane

- rollout phases được chốt rõ: `preflight -> parallel -> wiki-first -> cutover`
- validation gates G0..G3 có điều kiện go/no-go cụ thể
- rollback notes rõ theo từng phase và giới hạn memory-layer-only
- scope boundary giữ nguyên: không đụng canonical project index
- hard rule “không 1 point = 1 file” vẫn là bắt buộc

## 16) Next step after this lane

Lane tiếp theo nên:

1. chạy preflight sample export trên collection thực
2. tạo recall baseline checklist (case-based) trước khi wiki-first
3. chạy parallel write quan sát mismatch/fallback patterns
4. chỉ chuyển phase khi gate tương ứng đã pass

---

This spec is intentionally phase-1 practical and should be used as the migration-preparation reference before full wiki ingest implementation.
