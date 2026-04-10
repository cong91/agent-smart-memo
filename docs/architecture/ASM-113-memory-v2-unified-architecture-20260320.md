# ASM-113 — ASM Memory v2 Unified Architecture (2026-03-20)

> **Historical note (2026-04-09, bead agent-smart-memo-r4t.26):** Paperclip support was removed from active ASM runtime/package/test surfaces. Any Paperclip references below are archived design history, not current supported runtime behavior.

## 1. Mục tiêu

Thiết kế lại kiến trúc bộ nhớ của Agent Smart Memo theo hướng:

- scope rõ ràng
- retrieval/ranking thông minh
- promotion pipeline thống nhất
- nhất quán đường đi giữa SlotDB, Semantic Memory, Qdrant/Vector DB và Graph DB
- migration-first, không làm mất dữ liệu hay tri thức hiện tại

Thiết kế này nhằm sửa các bất cập hiện tại:

- `memory_store` và `memory_search` chưa round-trip ổn định trong runtime thực tế
- `sessionId` đang ảnh hưởng quá mạnh, làm agent memory bị biến thành session memory trá hình
- `auto-recall`, tool search và semantic usecase chưa dùng chung một contract truy hồi
- SlotDB và Semantic memory chưa có quy ước current truth vs supporting evidence
- thiếu promotion pipeline nên hệ chỉ tích luỹ vector, chưa chuyển thành tri thức bền vững

---

## 2. Nguyên tắc thiết kế

1. **SlotDB là current truth**
   - dùng cho facts/state hiện hành, đã được chuẩn hoá và có tính quyết định
   - khi SlotDB và semantic memory mâu thuẫn, SlotDB thắng

2. **Semantic memory là supporting evidence**
   - dùng cho episodic trace, lessons, decisions, runbooks, context lịch sử
   - semantic không tự động override SlotDB

3. **Session scope không được lấn át agent/project scope**
   - `session_id` mặc định là tín hiệu boost/ranking
   - chỉ thành filter cứng khi caller yêu cầu explicit strict session mode

4. **Một contract cho nhiều đường đi**
   - `memory_store`, `memory_search`, `auto-recall`, `auto-capture`, adapters phải dùng cùng contract

5. **Promotion mới là chìa khoá làm agent khôn hơn**
   - raw memory -> distilled memory -> promoted durable memory
   - nếu chỉ ghi raw vector thì hệ sẽ nhớ nhiều hơn, không khôn hơn

6. **Migration-first**
   - mọi thay đổi schema/namespace/filter phải có kế hoạch migrate/backfill/verify/rollback

---

## 3. Kiến trúc logic v2

```text
User / Agent Interaction
        |
        v
+---------------------------+
| Tool / Hook Ingress Layer |
| memory_store/search       |
| auto-capture / recall     |
+---------------------------+
        |
        v
+-----------------------------------+
| Unified Memory Policy Layer (v2)  |
| - scope resolution                |
| - namespace normalization         |
| - memory_type classification      |
| - precedence policy               |
| - promotion eligibility           |
+-----------------------------------+
        |
        +-------------------------+
        |                         |
        v                         v
+-------------------+      +----------------------+
| SlotDB            |      | Semantic Memory      |
| current truth     |      | Qdrant + payload     |
| structured facts  |      | episodic/evidence    |
+-------------------+      +----------------------+
        |                         |
        +------------+------------+
                     |
                     v
              +-------------+
              | Graph DB    |
              | lineage/rel |
              +-------------+
                     |
                     v
        +--------------------------------+
        | Retrieval / Ranking / Recall   |
        | current truth + evidence merge |
        +--------------------------------+
                     |
                     v
              System Prompt Context
```

---

## 4. Memory layers / scope model

### 4.1 Scope chính

Memory v2 dùng 4 tầng logic:

1. **session**
   - nhớ ngắn hạn trong một phiên làm việc
   - phù hợp cho temporary trace, transient planning, pending follow-up
   - không được dùng làm default filter cho mọi search

2. **agent**
   - working memory, lessons, decisions của từng agent
   - đây là tầng chính để agent “học qua nhiều phiên”

3. **project**
   - tri thức đặc thù của một project/repo/workspace
   - dùng cho conventions, architecture facts, migration notes, task lineage, indexed retrieval metadata

4. **shared**
   - rule/runbook/chính sách/tri thức dùng chung nhiều agent hoặc nhiều project

### 4.2 Scope metadata chuẩn

Mọi semantic payload v2 phải có metadata chuẩn tối thiểu:

- `memory_scope`: `session | agent | project | shared`
- `memory_type`: `fact | lesson | decision | runbook | episodic_trace | task_context | rule | noise`
- `agent_id`
- `session_id` (nullable)
- `project_id` (nullable)
- `task_id` (nullable)
- `user_id`
- `timestamp`
- `confidence`
- `promotion_state`: `raw | distilled | promoted | deprecated`
- `source_type`: `tool_call | auto_capture | migration | manual | promotion`

---

## 5. Namespace model v2

### 5.1 Namespace canonical

Giữ compatibility với namespace hiện tại nhưng dùng metadata để làm rõ scope:

#### Agent namespaces

- `agent.<agent>.working_memory`
- `agent.<agent>.lessons`
- `agent.<agent>.decisions`

#### Shared namespaces

- `shared.project_context`
- `shared.rules_slotdb`
- `shared.runbooks`

#### Quarantine

- `noise.filtered`

### 5.2 Lưu ý quan trọng

Namespace chỉ còn là **một chiều routing coarse-grained**, không phải source of truth duy nhất cho scope.

Source of truth thật sự trong v2 là tổ hợp:

- `namespace`
- `memory_scope`
- `memory_type`
- `agent_id`
- `project_id`
- `session_id`

Điều này giúp tránh tình trạng namespace phẳng nhưng semantics không rõ.

---

## 6. SlotDB vs Semantic Memory vs Graph DB

### 6.1 SlotDB

Dùng cho current truth:

- profile/preferences/environment/project current state
- state đang active
- facts đã được promote hoặc đã được xác nhận
- values cần deterministic injection vào current-state

### 6.2 Semantic memory (Qdrant)

Dùng cho:

- episodic traces
- lessons
- decisions
- runbooks
- task context
- project evidence
- historical observations

### 6.3 Graph DB

Dùng cho:

- task lineage
- file/symbol relations
- project relationships
- explicit dependency links

### 6.4 Quy tắc precedence

1. SlotDB `current-state` luôn được inject trước
2. Semantic memories chỉ đóng vai trò bổ sung/evidence
3. Nếu semantic memory mâu thuẫn với SlotDB, retrieval layer phải annotate mâu thuẫn chứ không được override slot hiện hành
4. Graph DB dùng để tăng cường routing/ranking, không phải source fact chính

---

## 7. Retrieval / Ranking v2

### 7.1 Vấn đề hiện tại

Hiện hệ đang thiên về:

- namespace filter
- similarity thô
- thêm một số weight đơn lẻ
- đôi khi filter cứng theo `sessionId`

Cách này gây:

- round-trip store/search không ổn định
- cross-session learning yếu
- cross-agent recall không rõ chính sách
- dễ bỏ sót memory đúng nhưng khác scope

### 7.2 Scoring v2 đề xuất

```text
final_score =
  semantic_similarity
  * namespace_weight
  * scope_match_weight
  * project_match_weight
  * recency_weight
  * confidence_weight
  * promotion_weight
  * graph_link_weight
```

### 7.3 Nguyên tắc ranking

- `session_id` mặc định chỉ tạo **boost**, không phải hard filter
- `project_id` match tạo boost mạnh
- `memory_scope=agent` và cùng agent tạo boost vừa
- `memory_scope=shared` luôn eligible cho mọi agent nhưng weight vừa phải
- `promotion_state=promoted` được ưu tiên hơn raw
- `memory_type=rule/runbook/decision/lesson` có weight riêng theo intent
- `noise.filtered` bị loại khỏi recall mặc định

### 7.4 Search modes

Cần chuẩn hoá 3 mode:

1. **strict mode**
   - dùng explicit filter cứng theo `session_id` / `project_id` / namespace khi caller yêu cầu

2. **scoped mode** (default)
   - current agent + current project + shared
   - session là tín hiệu recency boost

3. **exploratory mode**
   - cho diagnosis/research/debug
   - cho phép mở rộng cross-agent/cross-project có kiểm soát

---

## 8. Auto-recall policy v2

### 8.1 Default recall set

Mặc định auto-recall của agent A nên lấy:

- SlotDB current-state của agent/user/project
- semantic from:
  - `agent.A.*`
  - project-scoped memories thuộc `project_id` hiện tại
  - `shared.*`

### 8.2 Cross-agent recall

Không tự động mở rộng toàn bộ.
Chỉ bật khi có ít nhất một điều kiện:

- query explicit agent target (`assistant`, `scrum`, `trader`...)
- task type là handoff/planning/review
- workflow policy explicit cho phép
- graph/task lineage chỉ ra dependency sang agent khác

### 8.3 Recall output

Recall output nên phân loại thành:

- `current_truth`
- `project_context`
- `lessons_decisions`
- `evidence/history`

không nên dồn chung một khối memory text.

---

## 9. Auto-capture policy v2

### 9.1 Mục tiêu

Auto-capture không phải chỉ ghi nhiều memory, mà phải ghi đúng loại memory.

### 9.2 Phân loại memory type trước khi ghi

Mỗi memory capture cần được classify thành một trong các loại:

- `fact`
- `lesson`
- `decision`
- `runbook`
- `episodic_trace`
- `task_context`
- `rule`
- `noise`

### 9.3 Nguyên tắc lưu

- `fact` xác nhận cao -> candidate promote vào SlotDB
- `lesson/decision/runbook` -> semantic durable + promotion queue
- `episodic_trace` -> semantic với TTL ngắn hơn
- `noise` -> quarantine

### 9.4 Dedupe v2

Dedupe không chỉ theo namespace mà nên xét thêm:

- `memory_type`
- `project_id`
- `task_id`
- normalized text hash
- semantic near-duplicate score

---

## 10. Promotion pipeline v2

Đây là trọng tâm giúp hệ “khôn hơn”.

### 10.1 Các pha

1. **Capture**
   - raw episodic semantic memory

2. **Distill**
   - nhóm các memory lặp lại / cùng pattern
   - tạo distilled candidates

3. **Promote**
   - sang SlotDB (facts hiện hành)
   - hoặc shared rule slot
   - hoặc shared runbook
   - hoặc durable lesson namespace

4. **Recall with preference**
   - promoted > distilled > raw

### 10.2 Điều kiện promote

Ví dụ:

- xuất hiện >= 3 lần trong 30 ngày
- từ >= 2 task/session khác nhau
- confidence trung bình vượt ngưỡng
- không mâu thuẫn current truth

### 10.3 Promotion state

- `raw`
- `distilled`
- `promoted`
- `deprecated`

---

## 11. Aging / TTL policy v2

Không phải memory nào cũng sống mãi.

### Đề xuất TTL

- `session / episodic_trace`: ngắn
- `agent working_memory`: trung bình
- `lesson / decision`: dài
- `runbook / rule / promoted fact`: rất dài hoặc không TTL mặc định
- `noise.filtered`: cleanup mạnh

TTL phải đi cùng `memory_type` và `memory_scope`, không chỉ namespace.

---

## 12. Unified contract cho các đường ghi/đọc

### 12.1 Viết

Tất cả đường write phải đi qua cùng policy layer:

- `memory_store`
- `auto-capture`
- promotion pipeline
- migration/backfill jobs

### 12.2 Đọc

Tất cả đường read phải dùng cùng retrieval contract:

- `memory_search`
- `auto-recall`
- semantic usecase
- adapters (paperclip/openclaw/etc.)

### 12.3 Lợi ích

- tránh drift giữa tool/hook/usecase
- sửa một lần, đúng toàn hệ
- test contract dễ hơn

---

## 13. Migration-first plan

### 13.1 Dữ liệu cần migrate/backfill

1. **SlotDB**

- giữ nguyên current truth
- backfill thêm metadata nếu cần cho promotion provenance

2. **Qdrant semantic/vector payload**

- chuẩn hoá payload hiện tại sang schema v2:
  - `memory_scope`
  - `memory_type`
  - `promotion_state`
  - `project_id/task_id/session_id` khi suy ra được

3. **Graph DB**

- giữ nguyên quan hệ hiện tại
- thêm mapping nếu retrieval/ranking v2 cần graph weight

4. **Index/registry plane**

- đảm bảo index state tương thích với project-aware retrieval mới

### 13.2 Migration steps

1. Snapshot + backup toàn bộ
   - SlotDB
   - Qdrant collections
   - Graph DB/index DB

2. Introduce v2 schema in backward-compatible mode
3. Dual-read / dual-write nếu cần
4. Backfill metadata cho existing Qdrant points
5. Chạy verification suite
6. Gradual switch retrieval policy
7. Rollback switch nếu mismatch vượt ngưỡng

### 13.3 Migration requirements

- không đổi namespace hiện tại theo kiểu phá compatibility ngay lập tức
- dùng metadata enrich thay vì rename wholesale trong đợt đầu
- rollout theo phase
- có script verify counts / payload completeness / retrieval parity

---

## 14. Rollout phases

### Phase 0 — Contract & observability

- thống nhất policy layer
- thêm logs/metrics cho search filters và recall source mix

### Phase 1 — Session filter fix + retrieval unification

- bỏ session hard filter mặc định
- unify search paths

### Phase 2 — Scope/type schema enrich

- thêm `memory_scope`, `memory_type`, `promotion_state`
- backfill Qdrant payload

### Phase 3 — Promotion pipeline

- raw -> distilled -> promoted
- SlotDB/semantic precedence rules

### Phase 4 — Cross-agent/project-aware recall

- workflow policy + graph-aware boost

### Phase 5 — Cleanup/aging

- TTL policy + retention policy + archive/deprecate

---

## 15. Rủi ro chính

1. **Recall drift khi đổi scoring**
   - cần A/B verification

2. **Migration làm sai payload cũ**
   - cần backup + idempotent migration

3. **SlotDB và semantic conflict**
   - cần precedence rule rõ và conflict audit

4. **Cross-agent recall làm lộ context không cần thiết**
   - cần policy explicit, không implicit toàn cục

5. **Performance regression**
   - retrieval logic phức tạp hơn -> cần metrics + sampling strategy

---

## 16. Tiêu chí thành công

Kiến trúc Memory v2 được coi là thành công khi:

- `memory_store` -> `memory_search` round-trip ổn định theo contract mới
- session memory không lấn át agent/project memory
- auto-recall và tool search cho kết quả nhất quán theo policy
- promoted knowledge được ưu tiên hơn raw episodic memory
- SlotDB và semantic memory không còn mâu thuẫn vai trò
- migration/backfill giữ nguyên tri thức hiện có và có rollback an toàn

---

## 17. Khuyến nghị implementation ngay sau design

Ưu tiên P0 sau tài liệu này:

1. bỏ hard-filter `sessionId` mặc định trong search/recall
2. gom `memory_store` / `memory_search` / `auto-recall` qua unified retrieval/capture contract
3. thêm `memory_scope`, `memory_type`, `promotion_state`
4. sửa docs/tool schema cho đúng behavior runtime
5. thêm test contract/migration verification
