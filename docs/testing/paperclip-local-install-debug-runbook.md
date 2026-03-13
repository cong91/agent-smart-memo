# Paperclip local install + debug runbook (ASM plugin)

> Scope: chuẩn bị artifact local từ repo ASM để cài vào Paperclip host bằng local path, rồi smoke/debug practical.
> Không overclaim deploy production. Không merge default branch.

## 1) Prerequisites

- Repo: `agent-smart-memo`
- Node/NPM sẵn sàng
- Có Paperclip host shell để chạy `paperclipai plugin install <local-path>`
- (Optional) có quyền restart runtime/plugin process trên host

---

## 2) Build + package artifacts (trong ASM repo)

### 2.1 Build + verify Paperclip runtime path

```bash
npm run build:paperclip
npm run test:paperclip
```

Expected: pass contract + runtime e2e.

### 2.2 Package target paperclip (runtime package)

```bash
npm run package:paperclip
npm run pack:paperclip
```

Output local path:
- folder: `artifacts/npm/paperclip`
- tgz: `artifacts/npm/paperclip/mrc2204-agent-smart-memo-paperclip-<version>.tgz`

### 2.3 Package local plugin bundle (for Paperclip plugin install path)

```bash
npm run package:paperclip:plugin-local
npm run pack:paperclip:plugin-local
```

Output local path:
- folder: `artifacts/paperclip-plugin-local`
- tgz: `artifacts/paperclip-plugin-local/paperclip-plugin-asm-memory-local-<version>.tgz`

---

## 3) Install into Paperclip host (local path)

> Có thể dùng folder hoặc tgz.

### Option A — install from folder path

```bash
paperclipai plugin install /absolute/path/to/agent-smart-memo/artifacts/paperclip-plugin-local
```

### Option B — install from tgz

```bash
paperclipai plugin install /absolute/path/to/agent-smart-memo/artifacts/paperclip-plugin-local/paperclip-plugin-asm-memory-local-<version>.tgz
```

> Nếu host Paperclip nằm máy khác: scp/copy artifact qua host trước rồi install bằng local absolute path trên host đó.

---

## 4) Minimal config baseline

Config gợi ý (instance config):

```json
{
  "enabled": true,
  "capture": {
    "mode": "event+batch",
    "minConfidence": 0.62,
    "maxItemsPerRun": 12,
    "dedupWindowHours": 72
  },
  "recall": {
    "topK": 8,
    "minScore": 0.45
  },
  "markdownFallback": {
    "enabled": true,
    "rootDir": "skills/para-memory-files"
  }
}
```

Lưu ý practical:
- `recall.minScore` cao quá sẽ dễ "không có kết quả" ở smoke input ngắn.
- Nếu debug smoke nội bộ, có thể tạm hạ `minScore` xuống ~`0.30` để xác nhận pipeline chạy.

---

## 5) Health check sau install

Checklist nhanh:

1. Plugin load được (không crash lúc bootstrap).
2. Worker initialize thành công (`initialized=true`).
3. Không có lỗi schema config.
4. Tool surfaces có mặt:
   - `memory_recall`
   - `memory_capture`
   - `memory_feedback`
5. Event subscriptions nhận được:
   - `agent.run.started`
   - `agent.run.finished`
   - `agent.run.failed`
   - `activity.logged`
6. Jobs có thể trigger:
   - `asm_capture_compact`
   - `asm_recall_quality_check`
   - `asm_fallback_sync`

---

## 6) Smoke/debug script (local, practical)

Script đã chuẩn bị trong repo ASM:

```bash
node scripts/paperclip-local-smoke-debug.mjs
```

Script verify tuần tự:
- plugin load (`manifest` + `worker` exports)
- worker initialize + health
- `memory_capture` chạy được
- `memory_recall` chạy được
- event hook phản hồi (`activity.logged`)
- job hook phản hồi (`asm_capture_compact`)
- markdown fallback tạo queue file
- guard: fallback `.md` **không lấn source-of-truth** (recall không trả item chỉ tồn tại ở fallback queue)

---

## 7) Troubleshooting (thực dụng)

### A. `plugin install` fail vì path
- Dùng **absolute path**
- Verify artifact tồn tại:

```bash
ls -la artifacts/paperclip-plugin-local
```

### B. Worker init fail do config
- Kiểm tra field/kiểu theo schema (`capture.mode`, range min/max, ...)
- Reset về baseline config ở mục 4

### C. `memory_recall` không ra item
- Tăng chất lượng query gần với text đã capture
- Tạm giảm `recall.minScore` (vd 0.30) khi smoke

### D. Event/job không có phản hồi
- Verify runtime có emit đúng event names
- Trigger manual 1 event `activity.logged` trước để test đường ngắn
- Trigger manual job `asm_capture_compact` để xác nhận handler wiring

### E. Lo ngại fallback `.md` lấn SoT
- Fallback chỉ là queue/audit channel
- Source-of-truth vẫn là in-memory/primary pipeline
- Verify bằng smoke script: item forced fallback không được recall như item captured chính thức

---

## 8) Quick command set

```bash
# from agent-smart-memo repo
npm run build:paperclip
npm run test:paperclip
npm run package:paperclip
npm run pack:paperclip
npm run package:paperclip:plugin-local
npm run pack:paperclip:plugin-local
node scripts/paperclip-local-smoke-debug.mjs
```

---

## 9) What this runbook does / does not claim

- ✅ Chuẩn bị artifact local sẵn sàng để cài vào Paperclip host.
- ✅ Có smoke/debug assets để verify nhanh sau cài.
- ❌ Không tự claim đã cài thành công trên host Paperclip thật nếu chưa chạy bước install/runtime check trên host đó.
