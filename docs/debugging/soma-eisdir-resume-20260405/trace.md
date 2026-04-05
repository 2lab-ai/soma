# Bug Trace: soma-eisdir-resume — EISDIR during SDK session resume stops execution

## AS-IS: When Claude Code SDK encounters EISDIR during session resume (readFileSync on a directory), the error bypasses all recovery logic and is shown raw to the user. User must manually retry.
## TO-BE: EISDIR/streaming mode errors during resume are detected, session is auto-reset, and query retries as new session — transparent to user.

## Phase 1: Heuristic Top-3

### Hypothesis 1: Error pattern not matched by any recovery handler → falls through to raw display
- `query-flow.ts:358` → catch block
- Checks: `isReentrancyError` → false, `SESSION_EXPIRED` → false, `exited with code` → false, `isRateLimitError` → false, `isAbortError` → false
- Falls through to `formatErrorForUser(error)` at line 588 → user sees raw error
- ✅ **ROOT CAUSE CONFIRMED**

### Hypothesis 2: SDK resume creates corrupted session state
- `session.ts:777` → `realpathSync(this.workingDir)` + `readFileSync(claudeMdPath)` — these have proper guards
- `query-runtime.ts:135` → `resume: input.resumeSessionId || undefined` — passes sessionId to SDK
- SDK internally tries to read session state files, encounters directory instead of file → EISDIR
- Not fixable from soma side (SDK internal). ✅ Confirms resume is the trigger.

### Hypothesis 3: workingDir or additionalDirectories contain invalid paths
- `session.ts:818` → `cwd: this.workingDir` — validated by `resolveWorkingDir()` with `existsSync`
- `config/index.ts:62` → `ALLOWED_PATHS` from env — not validated for type (file vs dir)
- But these are directories by design. ❌ Not the issue.

## Conclusion

**Hypothesis 1 confirmed.** The error IS caught but no recovery handler matches EISDIR/streaming mode pattern. Fix: add `isSdkResumeError()` detection and auto-retry with `session.sessionId = null`.

## Fix Applied

1. `error-classification.ts` — added `isSdkResumeError()` function detecting EISDIR and "only prompt commands are supported in streaming mode"
2. `query-flow.ts` — added auto-retry block after SESSION_EXPIRED handler: clears `session.sessionId`, creates new StreamingState, continues retry loop
3. `error-classification.test.ts` — 6 tests for `isSdkResumeError`: EISDIR, streaming mode, combined, negatives, non-Error values
