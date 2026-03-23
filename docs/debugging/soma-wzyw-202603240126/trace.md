# Bug Trace: soma-wzyw — align soma context window calculation with per-turn usage semantics

## AS-IS

- `/context` and shutdown context summaries in `soma` are derived from `session.currentContextTokens`.
- `session.currentContextTokens` currently excludes `output_tokens` when it falls back to `contextWindowUsage` or `lastUsage`.
- `query-runtime` currently treats aggregate `result.modelUsage` / `result.usage` as a valid context snapshot and does not preserve assistant turn usage as a separate source of truth.
- `contextWindowSize` currently trusts SDK / `modelUsage.contextWindow` only and does not apply the `max(sdkWindow, lookupWindow)` rule.

## TO-BE

- Current context occupancy should use the latest assistant-turn usage when available, otherwise fall back to aggregate result usage.
- Occupancy formula must be:
  - `usedTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`
- Dynamic max window must be:
  - `maxWindow = max(sdkWindow, lookupWindow)`
- `/context` and restart/shutdown summaries should read the same corrected context numbers.

## Phase 1: Heuristic Top-3

### Hypothesis 1: `session.currentContextTokens` undercounts because output tokens are dropped

- `src/core/session/session.ts:259-268` returns `actualContextUsed`, else snapshot total, else last usage total.
- `src/core/session/session.ts:271-281` sums only `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
- `src/core/session/session.ts:291-300` fallback from `lastUsage` also sums only input + cache fields.
- `src/core/session/session-helpers.ts:131-175` transcript refresh path also extracts only input + cache fields from assistant `message.usage`.
- Conclusion: confirmed. Any path that falls back to snapshot / transcript / last usage undercounts current context by excluding `output_tokens`.

### Hypothesis 2: runtime mixes "current turn context" with "billing aggregate"

- Provider runtime:
  - `src/providers/claude-adapter.ts:131-158` emits `usage` from raw stream usage.
  - `src/providers/claude-adapter.ts:189-220` emits another `usage` event from aggregate `result.modelUsage`.
  - `src/providers/claude-adapter.ts:222-230` emits a `context` event whose `usedTokens` omits `totalOutput`.
- Provider consumer:
  - `src/core/session/query-runtime.ts:366-386` stores the latest provider `usage` into `lastUsage`, and seeds `contextWindowUsage` only once from that same structure.
  - Because provider `usage` does not distinguish assistant-turn vs aggregate, current context state can silently come from billing aggregate data.
- Direct SDK runtime:
  - `src/core/session/query-runtime.ts:506-517` tracks stream usage in `lastCallUsage`.
  - `src/core/session/query-runtime.ts:552-598` ignores `assistant.message.usage`.
  - `src/core/session/query-runtime.ts:606-720` builds `contextWindowUsage` from ClaudeCode `context_window.current_usage`, then `lastCallUsage`, then aggregate `event.usage` / `event.modelUsage`.
- Conclusion: confirmed. `soma` does not preserve assistant-turn usage as a separate field, so current context and billing aggregate can drift apart.

### Hypothesis 3: dynamic max window is missing the lookup-based override

- `src/core/session/query-runtime.ts:699-704` copies `modelUsage.contextWindow` directly into `contextWindowSize` / `actualContextMax`.
- `src/providers/claude-adapter.ts:222-230` emits `context.maxTokens = contextWindow` directly from SDK aggregate data.
- `src/handlers/commands/usage-commands.ts:153-178` and `src/app/bootstrap.ts:405-412`, `src/app/bootstrap.ts:500-510` compute percentages from `actualContextMax ?? contextWindowSize`.
- No model lookup table or beta-aware override exists in `soma`.
- Conclusion: confirmed. If SDK reports base `200000` while the session actually has 1M beta enabled, the displayed percentage is too high.

## Callstack Summary

1. Entry points
   - `/context`: `src/handlers/commands/usage-commands.ts:137-180`
   - restart/shutdown summaries: `src/app/bootstrap.ts:405-412`, `src/app/bootstrap.ts:500-510`
2. Shared session read
   - `session.currentContextTokens`: `src/core/session/session.ts:259-300`
3. Session state population
   - runtime result assignment: `src/core/session/session.ts:823-844`
4. Runtime sources
   - provider mode: `src/providers/claude-adapter.ts:131-230` -> `src/core/session/query-runtime.ts:366-400`
   - direct SDK mode: `src/core/session/query-runtime.ts:506-720`
5. Transcript fallback
   - `src/core/session/session.ts:227-245`
   - `src/core/session/session-helpers.ts:131-205`

## Fix Spec Derived From Trace

1. Extend current-context snapshot to include `output_tokens`.
2. Preserve assistant-turn usage separately from aggregate usage.
3. Compute current context tokens from assistant-turn usage first, aggregate usage second.
4. Include `output_tokens` in every occupancy calculation, including transcript refresh and provider `context.usedTokens`.
5. Apply a lookup-aware window max rule so displayed max is `max(sdkWindow, lookupWindow)`.
