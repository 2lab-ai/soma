# Emoji State Machine + Interrupt Message Loss — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/emoji-queue-bugfix/spec.md

## Table of Contents
1. [Scenario 1 — Emoji State Machine Unification](#scenario-1)
2. [Scenario 2 — Streaming Emoji Removal](#scenario-2)
3. [Scenario 3 — STEERING_DELIVERED Reaction on Consume](#scenario-3)
4. [Scenario 4 — Interrupt Auto-Requeue](#scenario-4)
5. [Scenario 5 — Error Path Steering Preservation](#scenario-5)
6. [Scenario 6 — PendingRecovery Timeout Extension](#scenario-6)

---

## Scenario 1 — Emoji State Machine Unification

### 1. Entry Point
- Event: Telegram text message received
- File: `src/constants/reactions.ts`

### 2. Input
- Current constants: READ(👀), PROCESSING(🤔), COMPLETE(👍), STEERING_BUFFERED(👌), STEERING_DELIVERED(🙏), INTERRUPTED(👎), ERROR_SOMA(😱), ERROR_MODEL(💩), CANCELLED(😢), EVICTED(🤔), FAIL(👎)

### 3. Layer Flow

#### 3a. Constants Change
- `reactions.ts:15` — PROCESSING: "🤔" → PROCESSING: "🔥"
- `reactions.ts:28-30` — Remove EVICTED and FAIL (legacy)
- Transformation: The PROCESSING emoji changes from thinking-face to fire, matching what users actually see

#### 3b. Impact
- `query-flow.ts:45` — `deliverInboundReaction(Reactions.PROCESSING)` → now sends 🔥 instead of 🤔
- No other code references EVICTED or FAIL directly (confirmed via grep)

### 4. Side Effects
- None (constant change only)

### 5. Error Paths
- None

### 6. Output
- PROCESSING emoji visible to user: 🔥 (was 🤔, immediately overwritten by streaming.ts)
- EVICTED/FAIL removed from codebase

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `emoji_constants_processing_is_fire` | Contract | Scenario 1, reactions.ts:15 |
| `emoji_constants_no_legacy_evicted` | Contract | Scenario 1, reactions.ts:28-30 |

---

## Scenario 2 — Streaming Emoji Removal

### 1. Entry Point
- Event: StatusCallback created for streaming response
- File: `src/handlers/streaming.ts:297-302, 595-597`

### 2. Input
- `PROGRESS_REACTION_ENABLED` env var (currently controls 🔥/🎉)
- `createStatusCallback()` function

### 3. Layer Flow

#### 3a. streaming.ts Changes
- `streaming.ts:300-302` — Remove `if (PROGRESS_REACTION_ENABLED) { await setReaction(ctx, "🔥"); }`
  - 🔥 now comes from `query-flow.ts:45` via `Reactions.PROCESSING` (after Scenario 1 change)
- `streaming.ts:595-597` — Remove `if (PROGRESS_REACTION_ENABLED) { await setReaction(ctx, "🎉"); }`
  - 👍 COMPLETE already set by `query-flow.ts:65`
- Remove `PROGRESS_REACTION_ENABLED` import and env var usage

#### 3b. Config Change
- `src/config/index.ts:226-227` — Remove `PROGRESS_REACTION_ENABLED` export (no longer needed)

#### 3c. Impact
- `createStatusCallback` no longer sets any reactions directly
- All reactions flow through `deliverInboundReaction()` in query-flow.ts
- Eliminates race condition between streaming.ts and query-flow.ts emoji setting

### 4. Side Effects
- `PROGRESS_REACTION_ENABLED` env var becomes unused (can be removed from .env.example)

### 5. Error Paths
- None

### 6. Output
- Single emoji path: query-flow.ts controls all transitions
- No more race between 🎉 and 👍

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `streaming_callback_no_direct_reactions` | Contract | Scenario 2, streaming.ts:300-302 |
| `query_flow_sets_processing_and_complete` | Happy Path | Scenario 2, query-flow.ts:45,65 |

---

## Scenario 3 — STEERING_DELIVERED Reaction on Consume

### 1. Entry Point
- Event: Auto-continue loop consumes steering buffer
- File: `src/handlers/text/query-flow.ts:82-183`

### 2. Input
- Steering buffer with N messages, each having a `messageId`
- `session.consumeSteering()` returns formatted text

### 3. Layer Flow

#### 3a. SteeringManager Change
- `steering-manager.ts` — New method `consumeSteeringWithIds()` returns both formatted text AND original messageIds
- Transformation: steeringBuffer[].messageId → messageId[] for reaction updates

#### 3b. query-flow.ts Change
- `query-flow.ts:121` — After `consumeSteering()`, iterate over messageIds and set 🙏 STEERING_DELIVERED
- Before sending follow-up: `for (const msgId of steeringMsgIds) { await ctx.api.setMessageReaction(chatId, msgId, [{type: "emoji", emoji: Reactions.STEERING_DELIVERED}]) }`
- After follow-up succeeds: set 👍 COMPLETE on those same messageIds

#### 3c. Reaction Sequence for Steering Messages
```
User sends msg (id=100) during processing:
  → 👀 READ (text.ts:147 on msg 100)
  → 👌 STEERING_BUFFERED (interrupt-flow.ts:179 on msg 100)
  → 🙏 STEERING_DELIVERED (query-flow.ts auto-continue on msg 100)  ← NEW
  → 👍 COMPLETE (query-flow.ts after follow-up on msg 100)          ← NEW
```

### 4. Side Effects
- Telegram API calls: setMessageReaction() for each consumed steering message (2x per message: DELIVERED then COMPLETE)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| setMessageReaction fails (rate limit) | GrammyError 429 | Silently skip (non-critical, existing pattern) |
| Follow-up query fails | Error | Mark as 💩 ERROR_MODEL on steering messageIds |

### 6. Output
- Steering messages show: 👌 → 🙏 → 👍 (clear state progression visible to user)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `steering_consumed_sets_delivered_reaction` | Happy Path | Scenario 3, query-flow.ts auto-continue |
| `steering_followup_complete_sets_complete_reaction` | Happy Path | Scenario 3, after follow-up |
| `steering_followup_error_sets_error_reaction` | Sad Path | Scenario 3, Section 5 |

---

## Scenario 4 — Interrupt Auto-Requeue

### 1. Entry Point
- Event: User sends "!" while session is processing with messages in steering buffer
- File: `src/handlers/text/interrupt-flow.ts:24-70`

### 2. Input
- `message = "!"` (bare interrupt, no follow-up text)
- `session.isProcessing = true`
- `steeringBuffer.length > 0`

### 3. Layer Flow

#### 3a. interrupt-flow.ts Change (runInterruptRoute)
- `interrupt-flow.ts:39` — **REMOVE** `extractSteeringMessages()` (destructive extraction)
- **ADD**: After `checkInterrupt()` → `session.stop()` completes:
  1. Wait for `isProcessing` to become false (already done by checkInterrupt)
  2. Check `session.hasSteeringMessages()`
  3. If yes: Send system message "🛑 중단됨. 대기 메시지 N개 자동 처리 중..."
  4. Do NOT extract — let messages stay in steering buffer
  5. Return `{ handled: false, message: "", wasInterrupt: true }`
  6. Back in `text.ts`, the flow continues to `handleSteeringGate()` → `session.isProcessing` is now false → falls through to `flushBatch()` or `runQueryFlow()`
  7. `runQueryFlow()` starts → auto-continue loop picks up steering messages naturally

#### 3b. text.ts Flow After Interrupt
```
handleText()
  → runInterruptRoute() → stops processing, returns {handled: false}
  → handleSteeringGate() → isProcessing=false → returns false
  → runQueryFlow() starts with empty message or steering content
  → auto-continue loop drains steering buffer
```

#### 3c. Fallback (if steering buffer is empty after interrupt)
- Same as current behavior: send "🛑 Stopped" system message

### 4. Side Effects
- Telegram: system message "🛑 중단됨. 대기 메시지 N개 자동 처리 중..."
- Steering messages remain in buffer → consumed by auto-continue loop

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| session.stop() hangs > 6s | Timeout | interrupt.ts:45 already handles with 6s timeout |
| Auto-continue fails on steering | Error | Existing error handling in query-flow.ts applies |
| Steering buffer empty | N/A | Fall through to "🛑 Stopped" |

### 6. Output
- User sees: "🛑 중단됨. 대기 메시지 2개 자동 처리 중..." → then normal response to queued messages
- No messages lost
- No recovery UI needed

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `interrupt_with_steering_auto_requeues` | Happy Path | Scenario 4, Section 3a |
| `interrupt_no_steering_sends_stopped` | Happy Path | Scenario 4, Section 3c |
| `interrupt_does_not_extract_steering` | Contract | Scenario 4, no extractSteeringMessages |
| `interrupt_steering_messages_survive` | Side-Effect | Scenario 4, buffer not cleared |

---

## Scenario 5 — Error Path Steering Preservation

### 1. Entry Point
- Event: Query flow encounters error while steering messages are buffered
- File: `src/handlers/text/query-flow.ts:414-421`

### 2. Input
- Error thrown during `session.sendMessageStreaming()`
- `session.hasSteeringMessages() === true`
- Steering buffer contains N messages

### 3. Layer Flow

#### 3a. query-flow.ts Change
- `query-flow.ts:414-421` — **REPLACE**:
  ```typescript
  // BEFORE (destructive):
  const lostCount = session.getSteeringCount();
  session.consumeSteering();
  await ctx.reply(`⚠️ 에러로 인해 대기 중이던 ${lostCount}개 메시지가 처리되지 않았습니다.`);

  // AFTER (preserving):
  const lostCount = session.getSteeringCount();
  const preserved = session.consumeSteering();
  if (preserved) {
    session.nextQueryContext = `[ERROR RECOVERY - ${lostCount} message(s) preserved]\n${preserved}\n[END RECOVERY]`;
  }
  await ctx.reply(`⚠️ 에러 발생. 대기 중이던 ${lostCount}개 메시지가 다음 요청에 자동 포함됩니다.`);
  ```

#### 3b. Session Property
- `session.nextQueryContext` — already exists (used by `resolvePendingRecoveryContext()` in interrupt-flow.ts:220)
- Transformation: steeringBuffer content → nextQueryContext string → prepended to next query

### 4. Side Effects
- `session.nextQueryContext` set with preserved messages
- Next `runQueryFlow()` call will include these messages as context

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| nextQueryContext already set | Overwrite | Append to existing context |

### 6. Output
- User sees: "⚠️ 에러 발생. 대기 중이던 2개 메시지가 다음 요청에 자동 포함됩니다."
- Messages preserved in nextQueryContext
- Next query includes preserved context

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `error_path_preserves_steering_as_context` | Happy Path | Scenario 5, Section 3a |
| `error_path_does_not_clear_steering_silently` | Contract | Scenario 5, no data loss |
| `preserved_steering_included_in_next_query` | Side-Effect | Scenario 5, Section 3b |

---

## Scenario 6 — PendingRecovery Timeout Extension

### 1. Entry Point
- Event: PendingRecovery timeout check
- File: `src/core/session/steering-manager.ts:119-129`

### 2. Input
- `pendingRecoveryTimeoutMs` constructor parameter
- `pendingRecovery.promptedAt` timestamp

### 3. Layer Flow

#### 3a. SteeringManager Constructor
- Find where `pendingRecoveryTimeoutMs` is passed and change default to 600000 (10 minutes)
- If hardcoded: change constant directly

#### 3b. Timeout Logic
- `steering-manager.ts:122-124` — Logic stays same, just timeout value increases
- Existing: `if (elapsed > this.pendingRecoveryTimeoutMs)` → null
- After: same check, but timeout = 600000ms (10 min) instead of current value

### 4. Side Effects
- PendingRecovery lives longer in memory (acceptable — one per session)

### 5. Error Paths
- None

### 6. Output
- Recovery UI buttons remain active for 10 minutes instead of current timeout

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `pending_recovery_survives_within_10_minutes` | Happy Path | Scenario 6, Section 3b |
| `pending_recovery_expires_after_10_minutes` | Sad Path | Scenario 6, timeout boundary |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| consumeSteeringWithIds() 신규 메서드 추가 | small (~15 lines) | 기존 consumeSteering()을 깨지 않고 messageId 반환용 변형 추가 |
| interrupt 후 빈 메시지로 runQueryFlow 진입 방식 | small (~10 lines) | 기존 auto-continue 루프가 steering을 자연스럽게 소비하므로 추가 로직 최소화 |
| PROGRESS_REACTION_ENABLED 환경변수 제거 | tiny (~3 lines) | 이중 경로 자체를 제거하므로 설정 불필요 |
| 에러 시 nextQueryContext 덮어쓰기 vs 붙이기 | tiny (~2 lines) | 붙이기(append)가 안전 — 기존 컨텍스트 보존 |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Emoji Constants Unification | done | RED | Ready |
| 2. Streaming Emoji Removal | done | RED | Ready |
| 3. STEERING_DELIVERED on Consume | done | RED | Ready |
| 4. Interrupt Auto-Requeue | done | RED | Ready |
| 5. Error Path Preservation | done | RED | Ready |
| 6. PendingRecovery Timeout | done | RED | Ready |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
