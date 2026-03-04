# Fix Re-entrancy Guard v2 — Spec

> STV Spec | Created: 2026-03-04

## 1. Overview

Previous fix (soma-jz5z) addressed post-query finalizeQueryTransition gap but didn't solve the real issue.
Actual root cause: **duplicate bot processes** polling Telegram simultaneously — PID 445 (Feb 25) + PID 1552734 (today).
Both receive the same update, one processes it while the other hits the re-entrancy guard.

The fix must be two-fold:
1. **Prevent duplicate processes** — startup PID lock to ensure single instance
2. **Make the guard resilient** — even if guard fires, don't show cryptic error; handle gracefully

## 2. User Stories

- As a bot user, I want the bot to work after every restart without "already running" errors
- As a bot admin, I want the bot to refuse to start if another instance is running

## 3. Acceptance Criteria

- [ ] Bot startup acquires PID lock; refuses to start if another instance is running
- [ ] Old zombie process is killed on startup if PID lock is stale
- [ ] Re-entrancy guard in handlers shows user-friendly message (not raw error)
- [ ] All existing tests still pass

## 4. Scope

### In-Scope
- PID lock file on startup (`/tmp/soma.pid`) with stale detection
- Graceful re-entrancy error handling in text handler (don't throw to user)
- Bootstrap cleanup: kill stale processes

### Out-of-Scope
- Proactive boot redesign (separate issue)
- grammY sequentialization rework
- State machine redesign

## 5. Architecture

### 5.1 PID Lock (bootstrap.ts)

On startup:
1. Check if `/tmp/soma.pid` exists
2. If exists, read PID and check if process is alive (`kill -0 pid`)
3. If alive → kill it (SIGTERM, wait 2s, SIGKILL if needed)
4. Write current PID to `/tmp/soma.pid`
5. On process exit (SIGTERM/SIGINT), clean up PID file

### 5.2 Handler Guard (text handler)

When `sendMessageStreaming` throws "already running":
- Don't show raw error to user
- Buffer message as steering (same as isProcessing path)
- Log warning

### 5.3 Integration Points

- `src/app/bootstrap.ts` — PID lock on startup
- `src/handlers/text/query-flow.ts` — graceful guard error handling
- `src/index.ts` — process exit cleanup

## 6. Non-Functional Requirements

- Reliability: Single instance guaranteed
- UX: No cryptic error messages to user

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| PID file at /tmp/soma.pid | tiny | Standard Unix pattern, /tmp is always writable |
| Kill stale process on startup | small | Better than refusing to start; user expects deploy to work |
| Buffer as steering on guard hit | tiny | Reuse existing steering mechanism |

## 8. Open Questions
None.

## 9. Next Step
→ `stv:trace` 로 Vertical Trace 진행
