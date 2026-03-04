# Fix Re-entrancy Guard v2 — Vertical Trace

> STV Trace | Created: 2026-03-04
> Spec: docs/fix-reentry-guard-v2/spec.md

## Scenario 1 — PID lock prevents duplicate instances

### 1. Entry Point
- Function: `acquirePidLock()` called from bootstrap
- File: `src/app/bootstrap.ts`

### 2. Flow
1. Read `/tmp/soma.pid`
2. If exists → parse PID → check alive via `process.kill(pid, 0)`
3. If alive → SIGTERM → wait 2s → verify dead → SIGKILL if needed
4. Write `process.pid` to `/tmp/soma.pid`
5. Register cleanup on SIGTERM/SIGINT

### 3. Side Effects
- Kill stale process
- Write PID file
- Clean up PID file on exit

### 4. Error Paths
| Condition | Action |
|-----------|--------|
| PID file exists, process dead | Overwrite PID file |
| PID file exists, process alive | Kill it, then overwrite |
| PID file doesn't exist | Write new PID file |
| Kill fails (permission) | Log error, continue anyway |

---

## Scenario 2 — Re-entrancy guard error handled gracefully in handler

### 1. Entry Point
- Function: `runQueryFlow()` catch block
- File: `src/handlers/text/query-flow.ts`

### 2. Flow
1. `sendMessageStreaming()` throws "already running"
2. Catch block detects re-entrancy error
3. Buffer message as steering via `session.addSteeringMessage()`
4. Show user-friendly message: "⏳ Processing previous request..."

### 3. Error Paths
| Condition | Action |
|-----------|--------|
| Guard throws "already running" | Buffer as steering, notify user |
| Other error | Existing error handling |

---

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. PID lock | done | RED | Ready |
| 2. Graceful guard | done | RED | Ready |

## Next Step
→ `stv:work` 로 구현
