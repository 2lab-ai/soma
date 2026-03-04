# Fix Stuck Re-entrancy Guard — Vertical Trace

> STV Trace | Created: 2026-03-04
> Spec: docs/fix-stuck-reentry-guard/spec.md

## 목차
1. [Scenario 1 — Post-query throw leaves guard stuck](#scenario-1)
2. [Scenario 2 — Normal completion resets to idle](#scenario-2)
3. [Scenario 3 — Error in executeQueryRuntime resets to idle](#scenario-3)

---

## Scenario 1 — Post-query throw leaves guard stuck (THE BUG)

### 1. Entry Point
- Method: `ClaudeSession.sendMessageStreaming()`
- File: `src/core/session/session.ts:560`
- Trigger: statusCallback throws during post-query processing

### 2. Input
- message: any string
- statusCallback: throws Error on "done" event
- chatId: number
- modelContext: "general"

### 3. Layer Flow

#### 3a. Guard Check (line 567)
- `this.isRunning` → `isQueryRunning(state)` → `state.queryState !== "idle"`
- queryState = "idle" → guard passes

#### 3b. Query Execution (lines 694-809)
- `startQueryTransition()`: queryState "idle" → "running"
- `executeQueryRuntime()`: succeeds normally
- finally block (line 801): `completeQueryTransition()`: queryState "running" → "completing"
- State after finally: queryState = **"completing"**

#### 3c. Post-query Processing (lines 811-894) ★BUG ZONE★
- `captureUsageSnapshot()` (line 815) — can throw
- `statusCallback("segment_end")` (line 845) — can throw
- `statusCallback("done")` (line 852) — **THROWS HERE**
- Exception propagates up, skipping line 895

#### 3d. Finalization (line 895) — NEVER REACHED
- `finalizeQueryTransition()`: queryState "completing" → "idle" — **SKIPPED**
- queryState stays **"completing"** forever

#### 3e. Next Call (line 567)
- `this.isRunning` → `queryState !== "idle"` → `"completing" !== "idle"` → **true**
- Guard throws: "sendMessageStreaming is already running"
- **ALL future calls permanently blocked**

### 4. Side Effects
- State mutation: `_queryState` stuck at "completing"
- `isRunning` permanently returns true
- Session becomes unusable for all subsequent messages

### 5. Error Paths

| Condition | Effect | Recovery |
|-----------|--------|----------|
| statusCallback("done") throws | queryState stuck "completing" | None (permanent) |
| captureUsageSnapshot() throws | queryState stuck "completing" | None (permanent) |
| statusCallback("steering_pending") throws | queryState stuck "completing" | None (permanent) |

### 6. Expected Output (after fix)
- queryState returns to "idle" regardless of post-query errors
- Next `sendMessageStreaming()` call succeeds normally
- Post-query errors logged but not fatal

### 7. Observability
- Log: `[POST-QUERY] Error in post-query processing: {error}`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `guard resets to idle after statusCallback throws in post-query` | Happy Path (post-fix) | Scenario 1, Section 3c-3d |
| `guard permanently stuck when statusCallback throws (pre-fix)` | Sad Path (current bug) | Scenario 1, Section 3c-3e |

---

## Scenario 2 — Normal completion resets to idle

### 1. Entry Point
- Method: `ClaudeSession.sendMessageStreaming()`
- Trigger: normal successful query completion

### 2. Input
- message: any string
- statusCallback: succeeds for all events
- chatId: number

### 3. Layer Flow

#### 3a. Guard Check
- queryState = "idle" → passes

#### 3b. Query Execution
- `startQueryTransition()`: "idle" → "running"
- `executeQueryRuntime()`: succeeds
- finally: `completeQueryTransition()`: "running" → "completing"

#### 3c. Post-query Processing
- All statusCallback calls succeed
- `finalizeQueryTransition()`: "completing" → "idle"

#### 3d. Return
- queryState = "idle", `isRunning` = false
- Next call will succeed

### 4. Side Effects
- queryState correctly returns to "idle"

### 5. Error Paths
None — happy path

### 6. Expected Output
- Returns response string
- queryState = "idle"

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `queryState is idle after successful completion` | Happy Path | Scenario 2, Section 3c-3d |

---

## Scenario 3 — Error in executeQueryRuntime resets to idle

### 1. Entry Point
- Method: `ClaudeSession.sendMessageStreaming()`
- Trigger: executeQueryRuntime throws unexpected error

### 2. Input
- message: any string
- statusCallback: any
- Condition: executeQueryRuntime throws non-abort error

### 3. Layer Flow

#### 3a. Guard Check
- queryState = "idle" → passes

#### 3b. Query Execution
- `startQueryTransition()`: "idle" → "running"
- `executeQueryRuntime()`: **THROWS**
- catch block (line 789): re-throws error
- finally: `completeQueryTransition()`: "running" → "completing"

#### 3c. After finally
- Error propagates up from catch re-throw
- `finalizeQueryTransition()` (line 895) — **SKIPPED** (same bug pattern)
- queryState stuck at "completing"

### 4. Expected Output (after fix)
- Error propagates to caller
- queryState returns to "idle" (finalized in finally block)
- Next call succeeds

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `guard resets to idle after executeQueryRuntime throws` | Sad Path | Scenario 3, Section 3b-3c |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Test via `_queryState` direct access | tiny | Existing test pattern (session.test.ts:15) |
| Mock executeQueryRuntime by overriding internal state | tiny | Can't easily mock SDK; test state transitions directly |
| Test file location: same as existing test | tiny | Follow project convention |

## Implementation Status

| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Post-query throw stuck | done | GREEN | Verified | Complete |
| 2. Normal completion | done | GREEN | Verified | Complete |
| 3. executeQueryRuntime throw | done | GREEN | Verified | Complete |

## Trace Deviations

Tests updated from using `completeQueryTransition` to `finalizeQueryTransition` in simulation,
matching the actual fix (finally block now calls `finalizeQueryTransition` directly).
No assertions weakened — test expectations unchanged.

## Verified At
2026-03-04 — All 3 scenarios GREEN + Verified. 586/586 tests passing.
