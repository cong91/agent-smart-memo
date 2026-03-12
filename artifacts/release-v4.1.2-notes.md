# agent-smart-memo v4.1.2

## Highlights
This release fixes a cluster of memory reliability and namespace-routing issues that could cause missing results, wrong namespace resolution, and silent context drift across agents.

## Fixed

### 1) Embedding client startup deadlock
- Removed `EmbeddingClient.ready` self-deadlock during capability calibration.
- Moved heavy calibration work off the critical startup path.
- Result: memory tools no longer hang at startup on this failure mode.

### 2) `memory_search` namespace normalization mismatch
- Aligned `memory_search` namespace normalization with `memory_store`.
- User-facing aliases now resolve consistently before search.
- Result: store/search roundtrip no longer breaks due to namespace contract drift.

### 3) Runtime context verification for tool calls
- Added probe coverage to verify runtime `before_tool_call` context carries `agentId` and `sessionKey`.
- Result: current-agent routing assumptions are now testable and repeatable.

### 4) Explicit agent alias resolution before fallback
- Fixed namespace normalization so explicit aliases like an agent id are resolved first, instead of being silently swallowed by the current fallback agent.
- Resolution is dynamic against the runtime agent registry, not hardcoded to a single team.
- Result: `namespace="assistant"` in a scrum session resolves to `agent.assistant.working_memory`, not `agent.scrum.working_memory`.

### 5) Clear validation for unknown explicit namespaces
- Explicit invalid namespaces now return a clear error instead of silently falling back to the current agent.
- Backward compatibility is preserved for calls that do not pass an explicit namespace.
- Result: safer multi-team behavior and fewer hidden context leaks.

## Docs / Guidance aligned
- Added namespace policy contract to `agent-smart-memo` skill docs.
- Updated main agent guidance to remove outdated `team` / `trading_signals` examples and align with:
  - dynamic agent aliases from runtime registry
  - `shared.project_context`
  - `shared.rules_slotdb`
  - `shared.runbooks`

## Validation
- Namespace roundtrip tests passed.
- Runtime-context tests passed for assistant / scrum / fullstack.
- Build passed.

## Commits included
- `7f87069` fix(embedding): remove ready deadlock and move calibration off startup path
- `309beac` fix(memory): normalize memory_search namespace aliases + align toolResult details contract
- `6046ae2` test(memory): probe runtime before_tool_call context injects agentId/sessionKey
- `254bc74` fix(memory): map explicit agent aliases before fallback namespace
- `71ca0a7` fix(memory): reject unknown explicit namespaces clearly

## Upgrade note
If users pass an explicit invalid namespace, the tool now fails clearly instead of silently falling back. This is intentional and improves correctness for multi-team / multi-agent deployments.
