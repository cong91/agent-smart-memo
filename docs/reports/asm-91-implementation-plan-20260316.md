# ASM-91 Implementation Plan

> For agentic workers: use subagent-driven-development if subagents are available; otherwise use executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real code-aware indexing baseline in Agent Smart Memo so project retrieval can return file path + symbol + relevant snippet for developer-grade navigation queries.

**Architecture:** Extend the existing project-aware ingest pipeline to emit stable code-aware metadata (file, symbol, span, route/job/entity hints), persist it into the existing registries (`file_index_state`, `chunk_registry`, `symbol_registry`), and expose it through the current project retrieval path without breaking existing project tool contracts.

**Tech Stack:** TypeScript, existing ASM ingest pipeline, SQLite registries, Qdrant payloads, OpenClaw project tools, `npx tsx` test runner.

---

## Context from real repo

Implementation target repo has been verified as:
- `/Users/mrcagents/Work/projects/agent-smart-memo`

Relevant existing modules confirmed in repo:
- `src/core/ingest/contracts.ts`
- `src/core/ingest/ids.ts`
- `src/core/ingest/ingest-pipeline.ts`
- `src/core/ingest/semantic-block-extractor.ts`
- `src/core/usecases/semantic-memory-usecase.ts`
- `src/core/usecases/default-memory-usecase-port.ts`
- `src/db/slot-db.ts`
- `src/services/qdrant.ts`
- `src/tools/project-tools.ts`
- existing tests:
  - `tests/test-project-registry.ts`
  - `tests/test-project-hybrid-lineage.ts`
  - `tests/test-project-reindex-diff.ts`

## Scope for ASM-91

### In scope
- Define the minimum code-aware metadata shape needed for indexing and retrieval.
- Upgrade ingest/extraction to emit structured symbol-level metadata.
- Persist code-aware metadata into existing registries and retrieval path.
- Preserve existing tool contract compatibility.
- Add representative tests and developer query probes.

### Out of scope
- Full universal relation graph model (`ASM-92`)
- Feature packs (`ASM-93`)
- Change-aware overlay (`ASM-94`)
- Query UX redesign (`ASM-95`)
- Multi-language perfection in first slice

## Acceptance probes for this plan

The implementation should be able to support queries like:
- where is `project_hybrid_search` defined?
- where does `/project` command enter the system?
- what file contains the semantic block extraction logic?
- where is the file/symbol touched for project registry registration?

## Evidence from live project-aware retrieval on alias `asm`

Project verified in registry:
- `project_alias = asm`
- `project_id = 4206a374-5070-470e-8f83-4d96a906acc8`
- bootstrap index state = `indexed`
- current materialized counts:
  - `file_index_state = 136`
  - `symbol_registry = 417`
  - `chunk_registry = 1311`

Observed retrieval behavior on the real index:
- Query `/project command onboarding telegram` returns `src/commands/telegram-addproject-command.ts` from `chunk_registry` successfully.
- Query `semantic block extractor symbol extraction` returns architecture docs (`docs/architecture/ASM-77-...`) rather than code-first results.
- Query exact symbol `project_hybrid_search` currently returns **0 results** despite known symbol presence in repo/tests/docs.

Implication for ASM-91:
- indexing baseline exists, but code-aware retrieval is still not strong enough on exact symbol lookup and code-first ranking.
- the implementation plan should explicitly improve:
  - exact symbol retrievability
  - code-over-doc ranking for developer queries
  - symbol/chunk metadata quality for project tool retrieval.

## File responsibility map

### Core ingest / extraction
- `src/core/ingest/contracts.ts`
  - extend chunk/symbol metadata contracts for code-aware indexing
- `src/core/ingest/ids.ts`
  - ensure stable IDs for symbol/chunk persistence
- `src/core/ingest/semantic-block-extractor.ts`
  - produce better symbol-level extraction metadata from source files
- `src/core/ingest/ingest-pipeline.ts`
  - pass extracted metadata into persistence and indexing flow

### Persistence / retrieval
- `src/db/slot-db.ts`
  - persist/read code-aware registry metadata cleanly
- `src/services/qdrant.ts`
  - ensure payload shape/filter fields support code-aware retrieval
- `src/core/usecases/semantic-memory-usecase.ts`
  - use symbol-aware metadata in retrieval/ranking path if needed
- `src/core/usecases/default-memory-usecase-port.ts`
  - keep tool/usecase contract compatibility as registry/query path evolves
- `src/tools/project-tools.ts`
  - expose improved retrieval behavior while preserving external tool names/shapes

### Tests / docs
- Modify: `tests/test-project-registry.ts`
- Modify: `tests/test-project-hybrid-lineage.ts`
- Modify: `tests/test-project-reindex-diff.ts`
- Create: `tests/test-project-code-aware-indexing.ts`
- Create: `docs/architecture/ASM-91-code-aware-indexing-v1.md`

---

## Task 1: Freeze minimal indexing contract

**Files:**
- Modify: `src/core/ingest/contracts.ts`
- Modify: `src/core/ingest/ids.ts`
- Create: `docs/architecture/ASM-91-code-aware-indexing-v1.md`

- [ ] **Step 1: Define the minimal metadata fields for ASM-91**

Fields to support at minimum:
- `relative_path`
- `language`
- `module`
- `symbol_name`
- `symbol_kind`
- `symbol_fqn`
- `line_start`
- `line_end`
- `route_marker`
- `job_marker`
- `entity_refs`
- `snippet`
- stable IDs for chunk/symbol persistence

- [ ] **Step 2: Update ingest contracts to express these fields clearly**

Goal: make extraction output and persistence input type-safe.

- [ ] **Step 3: Verify ID strategy still supports stable reindex behavior**

Focus on:
- same symbol in same file remains stable across reindex when source is unchanged
- changed content can invalidate/update correctly

- [ ] **Step 4: Document the indexing shape**

Write architecture note in:
- `docs/architecture/ASM-91-code-aware-indexing-v1.md`

Document:
- metadata fields
- intended meaning
- known limits of first slice

- [ ] **Step 5: Commit contract/doc slice**

Suggested commit:
```bash
git add src/core/ingest/contracts.ts src/core/ingest/ids.ts docs/architecture/ASM-91-code-aware-indexing-v1.md
git commit -m "feat: define ASM-91 code-aware indexing contract"
```

---

## Task 2: Upgrade semantic extraction output

**Files:**
- Modify: `src/core/ingest/semantic-block-extractor.ts`
- Modify: `src/core/ingest/ingest-pipeline.ts`
- Test: `tests/test-project-code-aware-indexing.ts`

- [ ] **Step 1: Add tests for symbol-aware extraction first**

Test cases should cover at minimum:
- exported function
- class + method
- route handler or command entrypoint marker when recognizable
- file with no recognizable symbols still produces file-level chunk safely

- [ ] **Step 2: Run tests to verify red state**

Suggested command:
```bash
npx tsx tests/test-project-code-aware-indexing.ts
```

Expected: failing or incomplete symbol metadata before implementation.

- [ ] **Step 3: Implement extraction metadata in `semantic-block-extractor.ts`**

Goal:
- emit symbol name/kind/span when possible
- preserve safe fallback when extraction is uncertain
- do not overfit to one framework as the scope of ASM-91 is still indexing baseline

- [ ] **Step 4: Thread extracted metadata through `ingest-pipeline.ts`**

Goal:
- pipeline passes code-aware metadata into registry/payload persistence

- [ ] **Step 5: Re-run focused extraction test**

Suggested command:
```bash
npx tsx tests/test-project-code-aware-indexing.ts
```

Expected: PASS for the targeted extraction cases.

- [ ] **Step 6: Commit extraction slice**

Suggested commit:
```bash
git add src/core/ingest/semantic-block-extractor.ts src/core/ingest/ingest-pipeline.ts tests/test-project-code-aware-indexing.ts
git commit -m "feat: add code-aware extraction metadata for ASM-91"
```

---

## Task 3: Persist code-aware metadata into registries

**Files:**
- Modify: `src/db/slot-db.ts`
- Modify: `src/core/ingest/ingest-pipeline.ts`
- Test: `tests/test-project-reindex-diff.ts`
- Test: `tests/test-project-registry.ts`

- [ ] **Step 1: Add tests that prove symbol/chunk metadata persists into registry records**

Need assertions for:
- `chunk_registry`
- `symbol_registry`
- compatibility with existing `file_index_state`

- [ ] **Step 2: Run registry-focused tests to verify red state**

Suggested commands:
```bash
npx tsx tests/test-project-registry.ts
npx tsx tests/test-project-reindex-diff.ts
```

- [ ] **Step 3: Update `slot-db.ts` persistence path**

Goal:
- persist code-aware metadata cleanly without breaking current schemas/contracts
- preserve compatibility for already indexed projects where possible

- [ ] **Step 4: Verify reindex/update behavior still works**

Focus on:
- symbol/chunk updates after file changes
- no broken stale-state transitions

- [ ] **Step 5: Re-run registry/reindex tests**

Suggested commands:
```bash
npx tsx tests/test-project-registry.ts
npx tsx tests/test-project-reindex-diff.ts
```

Expected: PASS

- [ ] **Step 6: Commit persistence slice**

Suggested commit:
```bash
git add src/db/slot-db.ts src/core/ingest/ingest-pipeline.ts tests/test-project-registry.ts tests/test-project-reindex-diff.ts
git commit -m "feat: persist code-aware registry metadata for ASM-91"
```

---

## Task 4: Expose code-aware retrieval through existing project tools

**Files:**
- Modify: `src/services/qdrant.ts`
- Modify: `src/core/usecases/semantic-memory-usecase.ts`
- Modify: `src/core/usecases/default-memory-usecase-port.ts`
- Modify: `src/tools/project-tools.ts`
- Test: `tests/test-project-hybrid-lineage.ts`
- Test: `tests/test-project-code-aware-indexing.ts`

- [ ] **Step 1: Add retrieval tests for developer-grade lookup behavior**

At minimum prove:
- query can return file path + symbol + snippet
- exact symbol query beats vague semantic-only match when symbol is known
- existing tool shape remains compatible

- [ ] **Step 2: Run retrieval tests to verify red state**

Suggested command:
```bash
npx tsx tests/test-project-hybrid-lineage.ts
npx tsx tests/test-project-code-aware-indexing.ts
```

- [ ] **Step 3: Update retrieval/ranking path**

Targets:
- `semantic-memory-usecase.ts`
- `qdrant.ts`
- `project-tools.ts`

Goal:
- preserve current tool contracts
- improve returned evidence for code-aware queries

- [ ] **Step 4: Ensure default usecase port still matches existing contracts**

Goal:
- avoid breaking `project_hybrid_search`, `project_task_lineage_context`, `project_reindex_diff`

- [ ] **Step 5: Re-run retrieval/compatibility tests**

Suggested command:
```bash
npx tsx tests/test-project-hybrid-lineage.ts
npx tsx tests/test-project-code-aware-indexing.ts
```

Expected: PASS

- [ ] **Step 6: Commit retrieval slice**

Suggested commit:
```bash
git add src/services/qdrant.ts src/core/usecases/semantic-memory-usecase.ts src/core/usecases/default-memory-usecase-port.ts src/tools/project-tools.ts tests/test-project-hybrid-lineage.ts tests/test-project-code-aware-indexing.ts
git commit -m "feat: expose code-aware retrieval through project tools"
```

---

## Task 5: Final validation and evidence pack

**Files:**
- Modify: `README.md` (if needed)
- Modify: `docs/architecture/ASM-91-code-aware-indexing-v1.md`
- Create: `docs/reports/asm-91-validation-20260316.md`

- [ ] **Step 1: Run full relevant test set**

Suggested commands:
```bash
npx tsx tests/test-project-registry.ts
npx tsx tests/test-project-reindex-diff.ts
npx tsx tests/test-project-hybrid-lineage.ts
npx tsx tests/test-project-code-aware-indexing.ts
```

- [ ] **Step 2: Run 3 representative developer query probes**

Probe examples:
- find `project_hybrid_search`
- locate `/project` onboarding entrypoint
- locate semantic block extractor logic

- [ ] **Step 3: Record evidence in validation report**

Create:
- `docs/reports/asm-91-validation-20260316.md`

Include:
- commands run
- pass/fail status
- representative query outputs
- limitations of first slice

- [ ] **Step 4: Update docs if output contract changed materially**

Potential targets:
- `README.md`
- architecture doc

- [ ] **Step 5: Commit validation/doc slice**

Suggested commit:
```bash
git add docs/reports/asm-91-validation-20260316.md docs/architecture/ASM-91-code-aware-indexing-v1.md README.md
git commit -m "docs: add ASM-91 validation evidence"
```

---

## Verification gate before claiming ASM-91 complete

Must have fresh evidence for all of the following:
- [ ] extraction tests pass
- [ ] registry/reindex tests pass
- [ ] retrieval tests pass
- [ ] 3 representative developer queries return file + symbol + relevant snippet
- [ ] no project tool contract breakage observed in impacted tests

## Key risks to watch during execution
- extractor false positives/negatives
- unstable symbol IDs causing noisy reindex behavior
- retrieval ranking over-boosting semantic similarity while ignoring exact symbol hits
- accidental breaking changes in existing project tool output

## Recommended next step after plan approval

Execute this plan on the verified repo:
- `/Users/mrcagents/Work/projects/agent-smart-memo`

Prefer isolated branch/lane work before implementation starts.
