# Emoji State Machine + Interrupt Message Loss — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

soma Telegram bot의 이모지 리액션 시스템과 인터럽트("!") 처리에 2건의 버그가 존재한다.

1. **이모지 이중 시스템 충돌**: `reactions.ts`와 `streaming.ts` 두 곳에서 독립적으로 Telegram 리액션을 설정하여 서로 덮어쓴다. 스티어링 메시지의 처리 완료 이모지(`STEERING_DELIVERED`)는 정의만 있고 실제 적용되지 않아, 유저는 메시지가 "씹혔다"고 인식한다.

2. **인터럽트 메시지 소실**: `!` 취소 시 `extractSteeringMessages()`가 버퍼에서 메시지를 파괴적으로 제거한다. 복구 UI를 보여주지만 타임아웃 시 메시지가 영구 소실된다. 에러 경로에서도 `consumeSteering()`이 메시지를 무조건 삭제한다.

## 2. User Stories

- As a user, I want each emoji on my message to clearly indicate its current state, so that I know whether my message is being processed, queued, or completed.
- As a user, I want my queued messages to be automatically processed after I cancel the current task with "!", so that I don't have to resend them.
- As a user, I want queued messages to survive error conditions, so that my input is never silently lost.

## 3. Acceptance Criteria

- [ ] 이모지 상태 전이가 단일 경로를 따름: 👀→🔥→👍(정상), 👀→👌→🙏→👍(스티어링)
- [ ] streaming.ts의 독립 이모지(🔥, 🎉)가 reactions.ts 시스템으로 통합됨
- [ ] 스티어링 메시지 소비 시 해당 메시지에 🙏(STEERING_DELIVERED) 리액션 적용됨
- [ ] "!" 취소 후 대기 메시지가 자동으로 새 쿼리로 실행됨
- [ ] 에러 발생 시 스티어링 메시지가 nextQueryContext로 보존됨 (삭제되지 않음)
- [ ] pendingRecovery 타임아웃이 제거되거나 충분히 길어짐 (최소 10분)
- [ ] 기존 테스트 전부 통과 (regression 없음)

## 4. Scope

### In-Scope
- reactions.ts 이모지 상수 정리 (EVICTED 제거)
- streaming.ts 이모지 제거 → reactions.ts 통합
- query-flow.ts auto-continue 루프에서 STEERING_DELIVERED 리액션 적용
- interrupt-flow.ts "!" 후 자동 re-queue 로직
- query-flow.ts 에러 경로에서 steering → nextQueryContext 보존
- steering-manager.ts pendingRecovery 타임아웃 조정

### Out-of-Scope
- 새로운 이모지 추가 (기존 Telegram 지원 이모지만 사용)
- sequentialize 미들웨어 재설계
- 메시지 큐(MessageQueue) debounce 로직 변경
- UI/UX 변경 (복구 UI 키보드 등)

## 5. Architecture

### 5.1 Layer Structure

변경 없음. 기존 아키텍처 유지:
```
telegram-bot.ts (middleware) → text.ts (handler) → interrupt-flow.ts / query-flow.ts → session/steering-manager.ts
```

### 5.2 Emoji State Machine (NEW — 통합)

```
┌──────────────────────────────────────────────────┐
│              Unified Emoji State Machine          │
├──────────────────────────────────────────────────┤
│                                                   │
│  Normal Query:                                    │
│  👀 READ → 🔥 PROCESSING → 👍 COMPLETE           │
│                            → 💩 ERROR_MODEL       │
│                            → 😱 ERROR_SOMA        │
│                                                   │
│  Steering (queued while busy):                    │
│  👀 READ → 👌 BUFFERED → 🙏 DELIVERED → 👍       │
│                          → 😢 CANCELLED (evict)   │
│                                                   │
│  Interrupt:                                       │
│  👀 READ → 👎 INTERRUPTED                         │
│                                                   │
└──────────────────────────────────────────────────┘
```

**변경 사항:**
- 🤔 PROCESSING → 🔥로 대체 (streaming.ts에서 이관)
- 🎉 completion → 👍 COMPLETE로 대체
- 🙏 STEERING_DELIVERED를 실제로 적용
- EVICTED(🤔) 레거시 제거

### 5.3 Interrupt Recovery Flow (CHANGED)

**Before:**
```
"!" → stop() → extractSteeringMessages() → show recovery UI → timeout → messages lost
```

**After:**
```
"!" → stop() → wait for isProcessing=false → auto-flush steering as new query
         ↓ (if steering buffer empty)
         → send "🛑 Stopped" only
```

### 5.4 Error Recovery Flow (CHANGED)

**Before:**
```
error → consumeSteering() → "다시 보내주세요" → messages lost
```

**After:**
```
error → save steering as nextQueryContext → "대기 메시지가 다음 요청에 포함됩니다"
```

### 5.5 Integration Points

| File | Change Type | Impact |
|------|-------------|--------|
| `src/constants/reactions.ts` | Modify | EVICTED 제거, PROCESSING→🔥 변경 |
| `src/handlers/streaming.ts` | Modify | setReaction 호출 제거, deliverInboundReaction 위임 |
| `src/handlers/text/query-flow.ts` | Modify | STEERING_DELIVERED 적용, 에러 경로 수정 |
| `src/handlers/text/interrupt-flow.ts` | Modify | auto-requeue 로직 추가 |
| `src/core/session/steering-manager.ts` | Modify | pendingRecovery 타임아웃 조정 |

## 6. Non-Functional Requirements

- **Performance**: 이모지 전환은 Telegram API rate limit 내에서 동작 (기존 throttler 유지)
- **Reliability**: 메시지 소실 경로 0건 (모든 경로에서 메시지 보존 보장)
- **Backward Compatibility**: PROGRESS_REACTION_ENABLED 환경변수 제거 (더 이상 이중 경로 불필요)

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 🤔→🔥로 PROCESSING 이모지 통합 | tiny (~3 lines) | 🔥가 이미 실제로 보이는 이모지, 🤔는 즉시 덮어써져 무의미 |
| 🎉 제거, 👍로 통합 | tiny (~3 lines) | 동일 의미 중복, race condition 제거 |
| EVICTED 레거시 제거 | tiny (~2 lines) | 이미 CANCELLED로 대체됨, 코드에서 사용 안 함 |
| auto-requeue vs 복구 UI 유지 | small (~20 lines) | auto-requeue가 UX 상 우월 — 유저가 버튼 클릭 기다릴 필요 없음 |
| pendingRecovery 타임아웃 10분 | tiny (~1 line) | 완전 제거보다 안전, 메모리 누수 방지 |
| 에러 시 nextQueryContext 저장 | small (~10 lines) | 기존 패턴(resolvePendingRecoveryContext)과 동일 방식 |

## 8. Open Questions

None — 분석 완료, 수정 방향 확정.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
