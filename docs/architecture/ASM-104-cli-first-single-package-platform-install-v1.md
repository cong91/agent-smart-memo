# ASM-104 — CLI-first Single-Package Platform Install Strategy (v1)

Date: 2026-03-17
Task: `ASM-104`
Epic: `ASM-105` — ASM SDK / CLI-first shared memory platform
Repo: `/Users/mrcagents/Work/projects/agent-smart-memo`

## 1. Goal

Chốt chiến lược packaging/install cho ASM theo hướng:

- **một package canonical duy nhất**: `@mrc2204/agent-smart-memo`
- **một CLI canonical duy nhất**: `asm`
- các runtime/platform như `openclaw`, `paperclip`, `opencode` là **installation targets** do CLI điều phối
- shared config chung tiếp tục dùng `~/.config/asm/config.json` theo `ASM-103`

## 2. Decision summary

### 2.1 Canonical public package
Canonical public package là:

- `@mrc2204/agent-smart-memo`

Không dùng public-facing package mapping kiểu:

- OpenClaw = `@mrc2204/agent-smart-memo`
- Paperclip = `@mrc2204/agent-smart-memo-paperclip`
- OpenCode = `@mrc2204/agent-smart-memo-core`

Lý do:
- tạo cảm giác ASM là nhiều sản phẩm rời nhau thay vì một platform thống nhất
- làm narrative lệch về runtime/package thay vì CLI/platform
- khiến onboarding/install story phân mảnh và khó mở rộng khi thêm target mới

### 2.2 Canonical install surface
Canonical install surface là CLI:

- `asm init-setup`
- `asm install openclaw`
- `asm install paperclip`
- `asm install opencode`
- tương lai: `asm install <platform>`

CLI là lớp orchestration chuẩn; package artifacts phía dưới chỉ là implementation detail.

### 2.3 Shared config ownership
Shared config chung cho ASM:

- path: `~/.config/asm/config.json`

Lệnh chuẩn:

- `asm init-setup`

Responsibility:
- bootstrap file/config global cho toàn platform
- không thuộc riêng runtime nào
- runtime adapter chỉ đọc phần config liên quan của mình từ shared config + local adapter config khi cần

### 2.4 Platform targets
#### OpenClaw
`asm install openclaw` phải:
- ensure plugin/runtime artifact sẵn sàng
- install/inject ASM vào OpenClaw
- setup/cập nhật `openclaw.json`
- wire các field/config cần thiết để OpenClaw dùng shared ASM config đúng cách

#### Paperclip
`asm install paperclip` phải:
- chuẩn bị đúng artifact cho Paperclip host/plugin loader
- cài plugin/runtime vào Paperclip theo host contract
- setup adapter-local config phía Paperclip nếu cần
- giữ shared ASM config là source-of-truth cho phần core/global

#### OpenCode
`asm install opencode` phải:
- bootstrap read-only/MCP integration
- setup config phía OpenCode
- map OpenCode vào read-only retrieval contract đã chốt ở `ASM-106`
- không biến OpenCode thành package public riêng ở phase này

## 3. Package boundary model

### 3.1 Public-facing boundary
Public-facing chỉ có:
- npm package: `@mrc2204/agent-smart-memo`
- CLI: `asm`

Người dùng không cần biết chi tiết dist target nội bộ để bắt đầu cài đặt.

### 3.2 Internal build/package targets
Các target sau vẫn có thể tồn tại để build/package nội bộ:
- `openclaw`
- `paperclip`
- `core`

Nhưng đây là **build/package targets**, không phải public product story chính.

Nghĩa là:
- được phép tồn tại trong scripts/artifacts để phục vụ CI/publish/install internals
- không được quảng bá như model sản phẩm chính cho user cuối

### 3.3 Local/plugin-only artifacts
Các artifact kiểu local/plugin-only như:
- `paperclip-plugin-local`
- host-install bundle cho debug/smoke

phải được xem là:
- host-install/debug artifact
- non-canonical
- không dùng làm package story public-facing

## 4. Install command contract

### 4.1 `asm init-setup`
Purpose:
- tạo/merge config chung tại `~/.config/asm/config.json`
- chốt các field global như workspace root, storage, embedding, retrieval defaults, project defaults

Rules:
- không phụ thuộc runtime cụ thể
- là entrypoint config chung trước hoặc sau install target đều được
- backward-compatible với config/shared bootstrap hiện có

### 4.2 `asm install <platform>`
Contract chung:
1. validate shared config/home
2. load platform installer spec
3. prepare required artifact/runtime bits
4. write/update platform-local config/integration points
5. print verify steps + next actions

Abstract contract cho từng target:
- `id`
- `displayName`
- `install()`
- `doctor()` / `verify()`
- `requiredSharedConfigKeys`
- `platformLocalConfigPaths`
- `notes/nextSteps`

### 4.3 `asm install openclaw`
Maps to:
- existing `setup-openclaw`/bootstrap line, nhưng reframed dưới `install openclaw`

### 4.4 `asm install paperclip`
Maps to:
- artifact prep + host/plugin install path + adapter-local setup
- phải phân biệt rõ npm package/runtime package với host local install artifact

### 4.5 `asm install opencode`
Maps to:
- read-only OpenCode integration bootstrap
- MCP/config setup path
- reuse `ASM-106` contract as runtime behavior layer

## 5. Non-goals of this slice

Slice này chưa làm:
- đổi toàn bộ publish topology
- tạo package public mới cho OpenCode/Paperclip
- viết installer implementation hoàn chỉnh cho mọi platform
- refactor lớn folder structure nếu chưa cần

## 6. Implementation guidance for next slice

Slice tiếp theo nên làm code tối thiểu để hiện thực direction này:
1. normalize CLI command story quanh `asm install <platform>`
2. giữ backward compatibility cho `setup-openclaw` hiện có
3. thêm installer abstraction mỏng, không over-engineering
4. chỉ expose public story qua package canonical `@mrc2204/agent-smart-memo`
5. update package narrative/README/CLI help cho khớp platform-first framing

## 7. Final decisions locked by this note

1. Canonical public package:
   - `@mrc2204/agent-smart-memo`
2. Canonical public install surface:
   - `asm`
3. Shared config bootstrap command:
   - `asm init-setup`
4. Platform install surface:
   - `asm install <platform>`
5. Public story is **single-package CLI-first platform**, not package-per-platform
6. Internal build targets may remain, but are not the public-facing product model
7. Local/plugin-only host artifacts must not be advertised as canonical packages

## 8. Bottom line

`ASM-104` không nên đẩy ASM thành một bó package public tách theo platform. Hướng đúng là:

- **one canonical package**
- **one canonical CLI**
- **platform installers behind `asm install <platform>`**
- **shared config in `~/.config/asm/config.json`**

Từ đây, implementation slices tiếp theo chỉ nên hiện thực hóa install abstraction và CLI story theo đúng model này, không mở thêm distribution complexity không cần thiết.
