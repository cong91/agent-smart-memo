# ASM-77 — [ASM v5.1][Implementation] Ingest pipeline & semantic block extraction

> Issue: ASM-77  
> Strategy: `code_light`  
> Scope: Implement lightweight primitives for ingest planning and semantic block extraction, aligned with ASM-72/ASM-71 contracts.

## 1) What was implemented

### 1.1 Ingest planning primitives
- Added `src/core/ingest/ingest-pipeline.ts`:
  - `planIngestFiles(input, files)`
  - Filtering policy:
    - ignored dirs (`node_modules`, `.venv`, `vendor`, `dist`, `build`, `coverage`, `.next`, `.git`)
    - binary extension exclusion
    - max file size cap (`max_file_bytes`)
    - include override precedence (`include_overrides[]`)
  - Deterministic `file_id` + file `checksum` computed for each candidate.

### 1.2 Semantic block extraction primitives
- Added `src/core/ingest/semantic-block-extractor.ts`:
  - `extractSemanticBlocks({ relativePath, content, maxDocChunkChars })`
  - Code-like files:
    - regex-based extraction for `class`, `function`, `method`
    - bounded block capture + line metadata (`start_line`, `end_line`)
  - Document fallback:
    - section/paragraph split with chunking guard (`maxDocChunkChars`)

### 1.3 Deterministic ID contracts
- Added `src/core/ingest/ids.ts`:
  - `buildFileId(projectId, relativePath)`
  - `buildChunkId(fileId, chunkKind, semanticPath, ordinal)`
  - `buildSymbolId(projectId, relativePath, symbolFqn)`
  - `checksumOf(raw)`

### 1.4 Contract types
- Added `src/core/ingest/contracts.ts` with typed contracts for:
  - trigger/input models
  - file plan entries
  - semantic blocks
  - chunk artifacts

## 2) Validation evidence

### 2.1 Build
- `npm run build:openclaw` ✅ PASS

### 2.2 Targeted test
- Added `tests/test-ingest-pipeline-semantic.ts`
- Executed: `npx tsx tests/test-ingest-pipeline-semantic.ts` ✅ PASS
- Coverage validated:
  - ingest filtering policy behavior
  - include override precedence
  - semantic extraction for class/function
  - deterministic `chunk_id` stability
  - markdown/doc fallback chunk splitting

## 3) Scope guard (what is intentionally NOT included)
- No queue worker/orchestrator wiring.
- No runtime scheduler/cron integration.
- No production rollout/deploy change.
- No ASM-78 incremental reindex execution flow wiring in this commit.

## 4) Acceptance alignment (ASM-77 intent)
- Ingest candidate planning scaffold: ✅
- Semantic block extraction baseline (code + docs fallback): ✅
- Deterministic IDs for file/chunk/symbol artifacts: ✅
- Code-light, non-breaking implementation style: ✅
