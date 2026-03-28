# Comprehensive Tool Input Validation Hardening

Updated: 2026-03-28
Size: medium (~50 lines changed)
Related: Issue #5, PR #6, Issue #9, PR #10

## 1. Problem

`checkToolInputSafety()` in `query-runtime.ts` validates only Read/Write/Edit file paths and Bash blocked patterns. Four security gaps remain:

1. **Bash file access bypass**: `cat /etc/passwd` bypasses path validation (only `rm` is path-checked)
2. **Grep/Glob path unvalidated**: Both accept `path` parameter, never checked against `isPathAllowed()`
3. **HTML injection in block reasons**: Raw file paths rendered via `parse_mode: "HTML"` without escaping
4. **isAbortError mismatch**: `"Abort requested by user"` not recognized by `isAbortError()`

## 2. Solution

### 2a. Grep/Glob path validation
Add `Grep` and `Glob` to `checkToolInputSafety()`. Validate `path` parameter via `isPathAllowed()`.

### 2b. Bash file-read command detection
In `checkToolInputSafety()`, for Bash commands, extract target paths from common file-reading commands (`cat`, `head`, `tail`, `less`, `more`, `cp`, `mv`, `tee`) and validate via `isPathAllowed()`.

### 2c. HTML-escape block reasons
In `validateToolInput()` (defense-in-depth path), HTML-escape the `result.reason` before passing to `statusCallback`. Import and use existing `escapeHtml()` from `formatting.ts`.

### 2d. Align abort error handling
Change `preToolUseHook` abort throw to use `name: "AbortError"` so `isAbortError()` recognizes it. Or add `"abort requested"` to `isAbortError()` patterns.

## 3. Files Affected

| File | Change |
|------|--------|
| `src/core/session/query-runtime.ts` | Extend `checkToolInputSafety` for Grep/Glob/Bash; HTML-escape in `validateToolInput`; fix abort error |
| `src/core/session/query-runtime.test.ts` | Tests for all new validation paths |
| `src/utils/error-classification.ts` | Add abort pattern (if approach 2d-alt chosen) |

## 4. Non-Goals

- Full Bash command parsing (too complex, diminishing returns)
- Validating MCP tool inputs
- WebFetch/WebSearch URL validation
