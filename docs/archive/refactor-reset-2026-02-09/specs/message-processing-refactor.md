# PRD: Message Processing Architecture Refactor

> Epic: `soma-msg-refactor` | Priority: P0 | Prerequisite for: Multi-Session (soma-el6g)

## Legend
| Symbol | Meaning |
|--------|---------|
| → | leads to / transforms to |
| ← | receives from |
| ↔ | bidirectional |
| ⊗ | currently broken |
| ✓ | works correctly |

---

## 1. Problem Statement

soma의 메시지 처리 아키텍처가 단일 모델(Claude) + 단일 세션 가정으로 설계됨.
멀티세션/멀티모델 확장 전에 근본 리팩토링 필요.

### 핵심 증상 (2026-02-07 테스트)
1. ⊗ **큐잉**: 유저가 "스티어링 1,2,3" 연속 전송 → 전부 큐에 쌓여서 하나씩 순차 처리
2. ⊗ **순서 불일치**: 보낸 순서 1→2→3인데 처리 순서가 달라짐
3. ⊗ **Text-only 블라인드**: Claude가 tool 없이 응답하면 steering 소비 불가
4. ⊗ **출력 커플링**: StatusCallback이 Telegram API + 비즈니스 로직 혼재
5. ⊗ **세션-모델 결합**: ClaudeSession이 AI 쿼리 + 메시지 버퍼링 + 상태관리 동시 담당

---

## 2. Architecture: AS-IS

```
┌─────────────────────────────────────────────────────────┐
│                    Telegram (Grammy)                     │
│  sequentialize(chatId) → bypass if isProcessing         │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│              text handler (handlers/text.ts)             │
│  isProcessing? ──YES→ addSteering(buffer) → return      │
│       │                                                  │
│      NO                                                  │
│       │                                                  │
│       ▼                                                  │
│  sendMessageStreaming(msg) ──→ auto-continue loop        │
│       │                          (max 5, 500ms settle)   │
└───────┼──────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│           ClaudeSession (session.ts)                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ queryState   │  │ steeringBuf  │  │ Claude SDK   │   │
│  │ idle→prep→   │  │ max 20 msgs  │  │ query()      │   │
│  │ run→comp→idle│  │ FIFO no sort │  │ hooks        │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│          StatusCallback (streaming.ts)                    │
│  thinking → ctx.reply()                                  │
│  tool     → ctx.reply() + MCP progress timer             │
│  text     → ctx.reply() / ctx.api.editMessageText()      │
│  done     → footer, choices, cleanup                     │
│  steering_pending → flag only                            │
└─────────────────────────────────────────────────────────┘
```

### 데이터 흐름 문제점

```
IN:  User Message
       │
       ├─[normal]──→ sequentialize 큐 ──→ text handler ──→ query
       │              ⊗ FIFO but blocks    ✓ works
       │
       ├─[steering]→ bypass sequentialize ──→ addSteering(buffer)
       │              ⊗ race condition        ⊗ no sort by msgId
       │                                      │
       │                              ┌───────┴───────┐
       │                              │               │
       │                    postToolUseHook    auto-continue
       │                    ✓ tool 실행 중      ⊗ text-only시
       │                                        ⊗ 500ms delay
       │
       └─[interrupt]→ bypass ──→ session.stop() / kill()
                       ✓ works

OUT: Model Response
       │
       ├─[stream text]──→ StatusCallback("text") ──→ ctx.reply/edit
       │                   ⊗ Telegram API 직접 호출
       │                   ⊗ throttle 로직 혼재
       │
       ├─[tool status]──→ StatusCallback("tool") ──→ ctx.reply
       │
       └─[system msg]──→ sendSystemMessage() ──→ ctx.reply
                          (reactions, notifications)
```

---

## 3. Architecture: TO-BE

### 레이어 구조

```
Session
  └── QueryCoordinator
       ├── MessageChannel (Input/Output 추상화)
       │    ├── InputChannel
       │    │    ├── PrimaryQueue (일반 메시지)
       │    │    ├── SteeringBuffer (실시간 주입)
       │    │    └── InterruptSignal (즉시 중단)
       │    └── OutputChannel
       │         ├── SystemOutput (soma 자체 메시지)
       │         └── ModelOutput (AI 응답)
       │
       └── ModelProvider (추상 인터페이스)
            ├── ClaudeProvider (현재)
            └── CodexProvider (향후)
```

### 상세 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│                         Session                              │
│  - sessionKey, activityState                                │
│  - user state (choices, recovery)                           │
│  - metadata (tokens, timing, warnings)                      │
│  - owns QueryCoordinator                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    QueryCoordinator                          │
│  - queryState: idle|preparing|running|aborting|completing    │
│  - generation tracking (invalidation)                       │
│  - steering strategy selection                              │
│  - auto-continue orchestration                              │
│                                                              │
│  Input:   MessageChannel.InputChannel ─→ processNext()      │
│  Output:  MessageChannel.OutputChannel ←─ provider events    │
│  Model:   ModelProvider.query() ─→ event stream              │
└─────┬──────────────────┬────────────────────┬───────────────┘
      │                  │                    │
      ▼                  ▼                    ▼
┌───────────┐  ┌─────────────────┐  ┌─────────────────────┐
│  Message   │  │  MessageChannel  │  │   ModelProvider      │
│  Channel   │  │  OutputChannel   │  │   (interface)        │
│  Input     │  │                  │  │                      │
│  Channel   │  │ ┌─────────────┐ │  │  query(): Stream     │
│            │  │ │SystemOutput │ │  │  abort(): void       │
│ ┌────────┐ │  │ │ - reactions │ │  │  capabilities:       │
│ │Primary │ │  │ │ - progress  │ │  │   supportsHooks      │
│ │Queue   │ │  │ │ - notifs    │ │  │   supportsMidInject  │
│ │(mutex) │ │  │ └─────────────┘ │  │                      │
│ └────────┘ │  │ ┌─────────────┐ │  │ ┌──────────────────┐ │
│ ┌────────┐ │  │ │ModelOutput  │ │  │ │ ClaudeProvider   │ │
│ │Steering│ │  │ │ - text      │ │  │ │ (hooks, SDK)     │ │
│ │Buffer  │ │  │ │ - thinking  │ │  │ └──────────────────┘ │
│ │(sorted)│ │  │ │ - tools     │ │  │ ┌──────────────────┐ │
│ └────────┘ │  │ │ - done      │ │  │ │ CodexProvider    │ │
│ ┌────────┐ │  │ └─────────────┘ │  │ │ (future)         │ │
│ │Interr- │ │  │                  │  │ └──────────────────┘ │
│ │upt     │ │  │ Transport:       │  │                      │
│ │Signal  │ │  │  TelegramAdapter │  │                      │
│ └────────┘ │  │  (future: Slack) │  │                      │
└───────────┘  └─────────────────┘  └─────────────────────┘
```

---

## 4. Input Channel 상세

### 4.1 PrimaryQueue

```
User sends normal message
  → Grammy middleware (NO sequentialize)
  → ChatMessageQueue.enqueue(msg)
  → sort by message_id (Telegram 서버 보장 순서)
  → mutex.runExclusive(processNext)
  → QueryCoordinator.handlePrimary(msg)
```

**변경사항:**
- Grammy `sequentialize()` 제거
- 자체 `ChatMessageQueue` + `async-mutex` 도입
- `message_id` 기반 정렬 (timestamp 대신)

### 4.2 SteeringBuffer

```
User sends message during processing
  → ChatMessageQueue.enqueue(msg)
  → mutex locked (processing중) → enqueueSteering(msg)
  → buffer.push(msg) → sort by message_id
  → SteeringStrategy 선택:
     ├── HookInjection (tool 실행 중 + provider supports hooks)
     ├── AutoContinue (text streaming 중 또는 hooks 미지원)
     └── AbortResubmit (critical priority 또는 명시적 interrupt)
```

**변경사항:**
- `addSteering()` 후 `messageId` 기반 정렬 추가
- 전략 패턴으로 injection 방식 선택
- `injectedSteeringDuringQuery` 추적 유지 (복원용)

### 4.3 InterruptSignal

```
User sends "!" prefix
  → bypass all queues
  → AbortController.abort()
  → session.stop() or session.kill()
  → lost messages → recovery UI
```

**변경사항:** 없음 (현재 동작 유지)

---

## 5. Output Channel 상세

### 5.1 ModelOutput (AI 응답)

```typescript
// Transport-agnostic interface
interface ModelOutputHandler {
  onThinking(content: string): void;
  onToolStart(tool: string, input: unknown): void;
  onToolEnd(tool: string, durationMs: number): void;
  onText(content: string, segmentId: number, isFinal: boolean): void;
  onComplete(metadata: QueryMetadata): void;
  onError(error: Error): void;
}
```

**현재 StatusCallback → ModelOutputHandler + TelegramAdapter 분리:**

```
Provider event stream
  → QueryCoordinator
  → ModelOutputHandler (business logic only)
  → TelegramAdapter (UI concerns)
     ├── throttling (STREAMING_THROTTLE_MS)
     ├── message creation/editing
     ├── HTML conversion
     ├── chunking (TELEGRAM_SAFE_LIMIT)
     └── footer rendering
```

### 5.2 SystemOutput (soma 시스템 메시지)

```typescript
interface SystemOutputHandler {
  sendNotification(text: string, opts?: NotificationOpts): Promise<void>;
  setReaction(emoji: string): Promise<void>;
  showProgress(type: 'spinner' | 'bar', elapsed: number): Promise<void>;
  showChoices(keyboard: InlineKeyboard): Promise<void>;
}
```

**현재 `sendSystemMessage()` + `ctx.react()` → SystemOutputHandler 통합:**

```
Session/QueryCoordinator events
  → SystemOutputHandler (abstract)
  → TelegramSystemAdapter (Telegram-specific)
     ├── reactions (👌, 🔥, ⚡, etc.)
     ├── progress spinner
     ├── notification messages
     └── inline keyboards
```

---

## 6. Steering Strategy 상세

### 전략 선택 매트릭스

| 상황 | 전략 | 설명 |
|------|------|------|
| Tool 실행 중 + hooks 지원 | **HookInjection** | postToolUseHook으로 즉시 주입 |
| Text streaming 중 | **AutoContinue** | 응답 완료 후 follow-up query |
| Hooks 미지원 provider | **AutoContinue** | 범용 fallback |
| Critical/interrupt | **AbortResubmit** | 현재 쿼리 abort → 전체 컨텍스트로 재전송 |

### 현재 vs 신규

```
AS-IS:
  postToolUseHook (tool 중) → OK
  auto-continue (text-only) → 불안정
  (abort 없음)

TO-BE:
  HookInjection (tool 중) → 유지
  AutoContinue (text-only) → 개선 (settle delay adaptive)
  AbortResubmit (critical) → 신규 옵션
```

---

## 7. Key Interfaces

### Session (simplified)

```typescript
interface ISession {
  readonly sessionKey: string;
  readonly isActive: boolean;
  readonly isProcessing: boolean;
  readonly activityState: ActivityState;

  sendMessage(msg: string, ctx: QueryContext): Promise<string>;
  stop(): Promise<StopResult>;
  kill(): Promise<KillResult>;
}
```

### MessageChannel

```typescript
class MessageChannel {
  // Input
  enqueuePrimary(msg: Message): void;
  enqueueSteering(msg: SteeringMessage): boolean; // returns evicted
  interrupt(): void;

  // Buffer access
  hasPendingSteering(): boolean;
  consumeSteering(): string | null;
  peekSteering(): SteeringMessage[];
  getSteeringCount(): number;
  restoreInjectedSteering(): number;

  // Output (handler registration)
  onModelOutput(handler: ModelOutputHandler): void;
  onSystemOutput(handler: SystemOutputHandler): void;
}
```

### ModelProvider

```typescript
interface ModelProvider {
  query(request: QueryRequest): AsyncIterable<ProviderEvent>;
  abort(): Promise<void>;
  readonly capabilities: ProviderCapabilities;
  setPostToolHook?(hook: PostToolHook | null): void;
}

interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsToolUseHooks: boolean;
  supportsMidStreamInjection: boolean;
  maxContextTokens: number;
}
```

---

## 8. Migration Phases

### Phase 1: Extract MessageChannel (1-2 days)

```
ClaudeSession.steeringBuffer → MessageChannel.steeringBuffer
ClaudeSession.addSteering() → MessageChannel.enqueueSteering()
ClaudeSession.consumeSteering() → MessageChannel.consumeSteering()
text.ts steering gate → MessageChannel.enqueueSteering()
```

- MessageChannel 클래스 생성
- steering 관련 모든 메서드 이동
- ClaudeSession은 MessageChannel을 소유하고 delegate
- **기존 동작 100% 유지** (facade 패턴)
- `messageId` 기반 정렬 추가

### Phase 2: Replace Grammy sequentialize (1 day)

```
index.ts sequentialize() → ChatMessageQueue + Mutex
```

- Grammy sequentialize 제거
- ChatMessageQueue 도입 (async-mutex 사용)
- message_id 기반 정렬
- **고위험** — 충분한 테스트 필요

### Phase 3: Extract ModelProvider (2-3 days)

```
ClaudeSession.sendMessageStreaming() → QueryCoordinator + ClaudeProvider
```

- ProviderEvent 타입 정의
- ClaudeProvider 구현 (SDK 호출 + hooks 분리)
- QueryCoordinator가 provider + messageChannel 조율
- query() 루프를 provider로 이동

### Phase 4: Extract OutputAdapter (1-2 days)

```
StatusCallback → ModelOutputHandler + TelegramAdapter
```

- ModelOutputHandler 인터페이스 정의
- TelegramOutputAdapter 구현 (streaming.ts 리팩토링)
- TelegramSystemAdapter 구현
- StreamingState를 adapter 내부로 이동

### Phase 5: Steering Strategy Pattern (1 day)

```
hardcoded hook+autocontinue → SteeringStrategy interface
```

- HookInjection, AutoContinue, AbortResubmit 전략 구현
- QueryCoordinator가 전략 선택
- settle delay adaptive 변경 (500ms → context-aware)

---

## 9. Related Issues (연결 대상)

### 직접 관련 (이 에픽 하위로)
| ID | 제목 | 상태 |
|---|---|---|
| soma-7w50 | Epic: Steering & Message Queue 근본 개선 | open |
| soma-upak.1 | Grammy sequentialize 병렬 처리 | open |
| soma-upak.2 | 메시지 순서 보장 (message_id 정렬) | open |
| soma-upak.3 | Text-only 응답시 steering 소비 | open |
| soma-upak.4 | 큐잉 지연 최소화 (debounce) | open |
| soma-vsy | Text-only 응답시 steering 무시 | open |
| soma-t5d | messages lost without tools | open |
| soma-o59 | steering buffered but not processed | open |
| soma-vig7 | stuck isProcessing | open |
| soma-f4i | MessageQueue 텍스트 핸들러 통합 | open |
| soma-nnd | Message Queue Interrupt Recovery | open |

### 선행 조건 (이 에픽이 unblock)
| ID | 제목 |
|---|---|
| soma-el6g | Multi-Session & Telegram Group Support |
| soma-2iwq | Agent SDK 추상화: Claude + Codex 멀티모델 |
| soma-ec76 | Slack 채널 지원 추가 |

---

## 10. 총 작업량 추정

| Phase | 예상 시간 | 위험도 |
|-------|----------|--------|
| 1. MessageChannel 추출 | 8-12h | Low |
| 2. Grammy sequentialize 교체 | 4-6h | **High** |
| 3. ModelProvider 추출 | 12-16h | Medium |
| 4. OutputAdapter 추출 | 6-8h | Low |
| 5. Steering Strategy | 4-6h | Medium |
| **총계** | **34-48h** | |

### Critical Path
```
Phase 1 (MessageChannel) → Phase 2 (sequentialize) → Phase 5 (steering)
                         → Phase 3 (ModelProvider) → Phase 4 (OutputAdapter)
```

Phase 1은 모든 것의 기반. Phase 2+3은 병렬 가능하지만 Phase 2가 고위험.

---

## 11. Success Criteria

1. ✅ 연속 "스티어링 1,2,3" 전송 → 순서 보장 + 실시간 주입
2. ✅ Text-only 응답 중에도 steering 작동
3. ✅ Provider 교체 시 MessageChannel 코드 변경 없음
4. ✅ 출력 채널 교체 시 (Telegram→Slack) 비즈니스 로직 변경 없음
5. ✅ Multi-session 진입 시 Session/MessageChannel 인터페이스 안정
6. ✅ 기존 모든 기능 regression 없음
