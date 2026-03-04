# Fix Stuck Re-entrancy Guard — Spec

> STV Spec | Created: 2026-03-04

## 1. Overview

`sendMessageStreaming()`의 re-entrancy guard가 영구적으로 stuck되어 모든 후속 메시지를 차단하는 버그.
`completeQueryTransition()` (finally block, line 802)이 queryState를 "completing"으로 전환한 후,
`finalizeQueryTransition()` (line 895)이 "idle"로 복원해야 하는데, 그 사이 unprotected async code가
throw하면 line 895에 도달하지 못해 queryState가 "completing"에 영구 stuck.

## 2. User Stories

- As a bot user, I want my messages to always be processed, so that the bot never gets permanently stuck
- As a bot admin, I want the bot to recover from transient errors, so that I don't need to manually restart

## 3. Acceptance Criteria

- [ ] `finalizeQueryTransition()`이 어떤 상황에서도 반드시 실행됨
- [ ] post-query processing (statusCallback, captureUsageSnapshot) 실패 시에도 queryState → "idle" 복원
- [ ] 기존 정상 flow (성공, abort, stop) 동작 변경 없음
- [ ] RED test: stuck guard 재현 → FAIL 확인
- [ ] GREEN test: 수정 후 → PASS 확인

## 4. Scope

### In-Scope
- `session.ts` sendMessageStreaming() post-finally 코드를 try-finally로 보호
- 불필요한 two-phase completion 제거 (completing → idle을 단일 finally로)
- Unit test로 stuck guard 재현 및 수정 증명

### Out-of-Scope
- State machine 자체 redesign
- statusCallback error handling 개선
- Bootstrap proactive boot 리팩터링

## 5. Architecture

### 5.1 Root Cause

```
sendMessageStreaming() {
  // line 694: queryState = "running"
  try {
    await executeQueryRuntime(...)
  } catch { ... throw; }
  finally {
    // line 802: queryState = "completing"  ← ALWAYS runs
  }

  // lines 811-894: UNPROTECTED async code
  await captureUsageSnapshot()           // CAN THROW
  await statusCallback("segment_end")    // CAN THROW
  await statusCallback("done")           // CAN THROW
  await statusCallback("steering_pending") // CAN THROW

  // line 895: queryState = "idle"  ← MAY NEVER RUN
}
```

### 5.2 Fix Strategy

Two-phase completion (completing → idle) 제거. `finalizeQueryTransition()`을 finally block 안으로 이동하여 단일 transition으로 즉시 idle 복원. Post-query processing은 별도 try-catch로 감싸서 실패해도 state에 영향 없도록.

```
sendMessageStreaming() {
  try {
    await executeQueryRuntime(...)
  } catch { ... throw; }
  finally {
    // queryState → "idle" (단일 transition, 항상 실행)
    this.applyRuntimeState(finalizeQueryTransition(this.getRuntimeState()));
    this.abortController = null;
    ...
  }

  // post-query processing (이제 queryState는 이미 "idle")
  try {
    await statusCallback(...)
    await captureUsageSnapshot()
  } catch (e) {
    console.error("[POST-QUERY] Error in post-query processing:", e);
  }
}
```

### 5.3 Integration Points

- `state-machine.ts`: `completeQueryTransition` 호출 제거, `finalizeQueryTransition`만 사용
- `session.ts` line 801-809: finally block 수정
- `session.ts` line 811-896: post-query code를 try-catch로 감싸기

## 6. Non-Functional Requirements

- Performance: 변경 없음 (동일 코드, 순서만 변경)
- Security: 변경 없음
- Reliability: 개선 — transient error에 대한 resilience 확보

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Two-phase → single-phase completion | small ~15줄 | "completing" 중간 상태 불필요, finally에서 직접 idle로 |
| Post-query code를 try-catch로 감싸기 | tiny ~5줄 | 기존 동작 보존하면서 resilience 추가 |
| completeQueryTransition 호출 제거 | tiny ~1줄 | finalizeQueryTransition이 any→idle이면 불필요 |

## 8. Open Questions

None — root cause와 fix strategy 모두 명확.

## 9. Next Step

→ `stv:trace` 로 시나리오별 Vertical Trace 진행
