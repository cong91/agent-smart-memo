# ASM-91 Heuristic Design Note

## Problem
- `project_hybrid_search` và `project_task_lineage_context` fail không phải vì thiếu config/path nữa.
- Bệnh hiện tại không còn là ranking đơn thuần; nó nằm ở code-aware symbol coverage và đường reingest đang được dùng trong các trigger manual/repair.

## Objective
- exact symbol/tool query phải tìm được đúng symbol trước
- code query phải ưu tiên code hơn doc
- chunk chỉ là evidence phụ, không được tranh top với symbol ở identifier intent

## Minimal retrieval order
### Identifier intent
- symbol > chunk(symbol-anchored) > file > doc

### Concept / flow intent
- symbol/chunk > file > doc

## Current implementation order
1. fix extraction coverage
2. fix trigger path để bảo đảm reingest dùng content thật khi cần
3. fix candidate generation
4. rồi mới tuning ranking
5. debug/explain output chỉ đủ dùng để benchmark các probe thật

## Probe set
- `project_hybrid_search`
- `project_task_lineage_context`
- `/project command onboarding telegram`
- `semantic block extractor symbol extraction`
- `symbol_registry chunk_registry file_index_state`

## Rule
Không biến heuristic thành framework tổng quát quá sớm. Chỉ sửa đúng đường retrieval hiện đang fail trong ASM-91.


## Current nuance (2026-03-16)
- Extractor hiện đã bắt được tool-surface symbols trên file thật `src/tools/project-tools.ts`.
- `collectGitTrackedPaths()` hiện đã đọc file content, nên không được kết luận mù rằng toàn bộ reindex path thiếu content.
- Nhưng các trigger manual/repair vẫn có thể đi theo `paths` chỉ có metadata/checksum mà không mang `content`, dẫn tới file bị update state nhưng không reingest sâu theo extractor mới.
- Vì vậy slice hiện tại phải ưu tiên: extraction coverage + content-aware reingest path + sau đó mới candidate generation/ranking.


## Current fix slice
- manual/repair trigger path phải hydrate `content` từ repo_root khi caller chỉ truyền relative_path/module/language.
- checksum cho reindex phải ưu tiên content-hash thật thay vì placeholder kiểu `git:<path>` / `fs:<path>` / `event:<path>:...` khi content đã đọc được.
- mục tiêu là mọi reindex đúng nghĩa phải có khả năng re-run extraction/persistence cho file changed, không chỉ update watch/file state.
