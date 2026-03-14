# ASM-74 — [ASM v5.1] Project registration UX, command contract & Jira mapping

> Issue: ASM-74 (child of ASM-69)  
> Strategy: `code_light`  
> Scope: Define the registration UX/command contract for project-aware memory onboarding, Jira mapping, and optional initial index trigger.

## 1) Purpose

This document defines how agents/operators register a project into ASM v5.1 with minimal input while preserving a `project_id`-centric contract.

It covers command surface, request/response schema, validation, Jira mapping attachment, and initial indexing trigger policy.

This is an architecture/spec contract (`code_light`), not full runtime UI wiring.

---

## 2) Design goals

1. Fast registration with minimal mandatory fields.
2. Deterministic resolution to canonical `project_id`.
3. Strong alias + repository uniqueness policy.
4. First-class external tracker mapping (Jira-first in this phase).
5. Optional “Index now” trigger directly after successful registration.
6. Backward compatibility for projects already indexed but never formally registered.

---

## 3) Command surface (agent/chat/operator)

## 3.1 Primary commands

- `add project`
- `register project`
- `link jira`
- `index project`

Synonyms map to canonical actions:

- `add project` / `register project` -> `project.register`
- `link jira` -> `project.link_tracker`
- `index project` / `index now` -> `project.trigger_index`

## 3.2 Minimal input policy

Registration should support the minimum practical input set:

- `project_alias` (required)
- `repo_root` (optional if auto-resolvable)
- `tracker_type` (`jira` when linking tracker)
- `tracker_space_key` (required when `tracker_type=jira`)
- `active_version` (optional)
- `default_epic_key` (optional)

If `repo_root` is omitted, resolver follows deterministic repository resolution: current working repository root, existing registered project with matching remote, local-path import from `repo_url`, then clone/import into configured workspace root.

---

## 4) Canonical contract: register project

## 4.1 Request schema (`project.register.request.v1`)

```json
{
  "project_alias": "agent-smart-memo",
  "repo_root": "/abs/path/or/omitted",
  "repo_remote": "git@github.com:org/repo.git",
  "repo_url": "git@github.com:org/repo.git",
  "active_version": "5.1",
  "tracker": {
    "tracker_type": "jira",
    "tracker_space_key": "ASM",
    "default_epic_key": "ASM-69"
  },
  "options": {
    "trigger_index": true,
    "allow_alias_update": false
  }
}
```

## 4.2 Response schema (`project.register.response.v1`)

```json
{
  "project_id": "proj_01J...",
  "project_alias": "agent-smart-memo",
  "registration_status": "registered",
  "validation_status": "ok",
  "completeness_score": 0.96,
  "warnings": [],
  "repo_resolution": {
    "resolution": "registered_remote_match",
    "clone_policy": "reuse_existing_clone",
    "workspace_root": "/workspace/projects",
    "clone_target": "/workspace/projects/agent-smart-memo",
    "notes": [
      "matched existing registered project by repo remote; reusing repo_root"
    ]
  },
  "tracker_mapping": {
    "tracker_type": "jira",
    "tracker_space_key": "ASM",
    "default_epic_key": "ASM-69",
    "mapping_status": "linked"
  },
  "index_trigger": {
    "requested": true,
    "accepted": true,
    "enqueued": true,
    "detached": true,
    "job_id": "idxjob_01J...",
    "run_id": null
  }
}
```

---

## 5) Canonical contract: link Jira

## 5.1 Request schema (`project.link_tracker.request.v1`)

```json
{
  "project_ref": {
    "project_id": "proj_01J...",
    "project_alias": "agent-smart-memo"
  },
  "tracker": {
    "tracker_type": "jira",
    "tracker_space_key": "ASM",
    "default_epic_key": "ASM-69"
  },
  "mode": "attach_or_update"
}
```

## 5.2 Response schema (`project.link_tracker.response.v1`)

```json
{
  "project_id": "proj_01J...",
  "tracker_mapping": {
    "tracker_type": "jira",
    "tracker_space_key": "ASM",
    "default_epic_key": "ASM-69",
    "mapping_status": "linked",
    "updated": true
  },
  "validation_status": "ok",
  "warnings": []
}
```

---

## 6) Canonical contract: index trigger

## 6.1 Request schema (`project.trigger_index.request.v1`)

```json
{
  "project_ref": {
    "project_id": "proj_01J...",
    "project_alias": "agent-smart-memo"
  },
  "mode": "bootstrap",
  "scope": {
    "path_prefix": [],
    "module": [],
    "task_id": []
  },
  "reason": "post_registration"
}
```

## 6.2 Response schema (`project.trigger_index.response.v1`)

```json
{
  "project_id": "proj_01J...",
  "accepted": true,
  "enqueued": true,
  "detached": true,
  "job_id": "idxjob_01J...",
  "run_id": null,
  "queued_at": "2026-03-13T08:00:00Z"
}
```

---

## 7) Repo root resolution flow (when path omitted)

Resolution order:

1. Explicit `repo_root` in request.
2. Runtime working directory git root (`git rev-parse --show-toplevel`).
3. Existing registered project with matching normalized remote (`registered_remote_match`) and reuse existing `repo_root` / project identity.
4. Treat local-path `repo_url` as import (`imported_local_path`) without `git clone`.
5. Clone/import from `repo_url` into configured workspace root when no reusable registration/local path exists.
6. Fail with actionable validation error only when no repo root can be resolved and no import/clone path is available.

Rules:

- No fixed base path assumptions.
- Normalize path + remote before uniqueness checks.
- Persist normalized root for future deterministic reuse.
- When remote matches an already-registered project, registration should reuse the existing project record and only add/update alias metadata instead of inserting a duplicate `repo_root` row.

---

## 8) Validation contract

## 8.1 Required validations

1. Alias uniqueness (collision policy explicit).
2. Repo mapping uniqueness (same repo cannot ambiguously map to multiple active project identities unless override policy says otherwise).
3. Jira `tracker_space_key` format validity.
4. `default_epic_key` shape consistency with space key when provided.

## 8.2 Validation output

Persist and return:

- `registration_status`
- `validation_status` (`ok|warn|blocked`)
- `completeness_score`
- `missing_required_fields[]`
- `validation_notes[]`

Blocked validation prevents automatic index trigger unless operator override flag is provided.

---

## 9) Alias + tracker mapping attach/update semantics

- `attach_or_update` mode must be idempotent.
- Alias update requires explicit intent when conflicting with existing alias owner.
- Tracker mapping history should preserve previous mapping metadata for auditability.
- Mapping updates must not mutate canonical `project_id` identity.

---

## 10) Registration UX guideline (chat/Telegram inline form)

Recommended short actions:

- `Add Project`
- `Link Jira`
- `Index Now`
- `Edit Mapping`

Guidelines:

1. Keep first-step form short (alias + optional root + Jira space key).
2. Hide advanced fields behind “More options”.
3. Show immediate validation errors inline (alias duplicate, invalid space key, unresolved repo root).
4. Show post-success cards with `project_id`, mapping state, and `Index now` CTA.

This is operator UX guidance for agent-facing flows, not end-user product UX.

---

## 11) Compatibility plan for legacy projects (already indexed, not registered)

For old projects without explicit registration:

1. Build provisional mapping from existing index metadata.
2. Allow `project.register` in upgrade mode to attach alias/tracker without re-identity churn.
3. Mark registration as `draft|warn` when inferred fields are incomplete.
4. Allow manual finalize + optional bootstrap/repair index trigger.

This keeps retrieval usable while progressively normalizing to v5.1 registration contract.

---

## 12) Acceptance criteria coverage (ASM-74)

- Command contract for add/register project: **Sections 3, 4** ✅
- Input/output schema for link Jira + index trigger: **Sections 5, 6** ✅
- Resolve current repo root when path omitted: **Section 7** ✅
- Validate alias/repo mapping/Jira space key: **Section 8** ✅
- Attach/update alias + external tracker mapping: **Section 9** ✅
- Option trigger initial index after add project: **Sections 4.2, 6, 10** ✅
- UX guideline for Telegram/chat inline buttons/forms: **Section 10** ✅
- Compatibility plan for old projects without alias/tracker mapping: **Section 11** ✅

---

## 13) Implementation boundary note

This story delivers registration UX + command contract architecture (`code_light`) for ASM-74.

Runtime command handlers, chat UI rendering, and production rollout integration are implemented in follow-up execution tasks under ASM-69 lane.
