# soma-qivc: 사진/문서 핸들러 동시성 충돌 분석

**Date:** 2026-03-24
**Severity:** P0
**Status:** 분석 완료, 수정 대기

---

## 1. 재현 시나리오 (스크린샷 기반)

```
사용자 → 사진 7장 (media group) + 텍스트 "이미지 총 7장 책 14권" 동시 전송

타임라인:
15:33:00.000  사진 1~7장 도착 (media_group_id 존재)
15:33:00.100  텍스트 "이미지 총 7장 책 14권" 도착 (별도 메시지)
15:33:00.200  "📷 Processing 1 photos..." (media group 타임아웃 발동)
15:33:00.300  텍스트 → handleText() → 500ms debounce 큐에 들어감
15:33:00.800  debounce 만료 → flushBatch() → runQueryFlow() → sendMessageStreaming()
              → 💥 isRunning=true → "already running. Concurrent calls are not supported."
15:33:00.900  "❌ Error: sendMessageStreaming is already running..."
15:33:01.000  "👀 Viewing" (에러 후 리액션)
```

---

## 2. 코드 흐름 분석

### 2.1 Photo Handler (src/handlers/photo.ts)

```
handlePhoto()
  ├── mediaGroupId 있으면 → photoBuffer.addToGroup() → 1초 타임아웃 후 processGroup()
  └── mediaGroupId 없으면 → processPhotos() 직접 호출

processPhotos()
  ├── session.startProcessing()   ← queryState: idle → "preparing"
  ├── ctx.react(Reactions.PROCESSING)
  └── session.sendMessageStreaming()  ← 여기서 API 호출 (queryState → "running")
```

### 2.2 Text Handler (src/handlers/text.ts)

```
handleText()
  ├── runInboundGuard()
  ├── runInterruptRoute()
  ├── handleSteeringGate()  ← isProcessing 체크 (preparing/running 이면 steering 버퍼에 추가)
  │   └── session.isProcessing? → steering 버퍼에 추가하고 return true
  └── (idle 일 때만) → MessageQueue에 enqueue (500ms debounce)
      └── flushBatch() → runQueryFlow() → sendMessageStreaming()
```

### 2.3 State Machine (src/core/session/state-machine.ts)

```typescript
QueryState = "idle" | "preparing" | "running" | "aborting" | "completing"

isQueryRunning(state):    running || aborting || completing     (preparing 제외!)
isQueryProcessing(state): queryState !== "idle"                 (preparing 포함!)
```

### 2.4 Re-entrancy Guard (src/core/session/session.ts:589)

```typescript
if (this.isRunning) {  // ← isQueryRunning() 사용
  throw new Error("sendMessageStreaming is already running...");
}
```

---

## 3. 핵심 레이스 컨디션

### Race #1: Media Group 타임아웃 + 텍스트 동시 도착

```
T+0ms    사진 도착 → photoBuffer.addToGroup() (아직 processGroup 안 됨)
T+100ms  텍스트 도착 → handleText() → session.isProcessing? → FALSE (아직 idle!)
T+100ms  텍스트 → 500ms debounce 큐에 추가
T+600ms  텍스트 debounce 만료 → flushBatch() → sendMessageStreaming() 호출
T+1000ms 사진 media group 타임아웃 (1초) → processGroup() → processPhotos()
         → startProcessing() → sendMessageStreaming()
         → 💥 isRunning=true (텍스트가 이미 실행 중)
```

**결과:** 텍스트가 먼저 시작하면 → 사진 처리에서 에러
**또는:** 사진이 먼저 시작하면 → 텍스트에서 에러 (스크린샷의 경우)

### Race #2: 사진 처리 중에 텍스트 도착 (타이밍 엣지)

```
T+0ms    사진 processPhotos() → startProcessing() → queryState = "preparing"
T+50ms   텍스트 도착 → handleSteeringGate() → session.isProcessing? → TRUE
         → steering 버퍼에 추가됨 ✅ (정상 동작)
```

이 경우는 handleSteeringGate()가 잡아준다. **하지만:**

```
T+0ms    텍스트 도착 → handleText() → session.isProcessing? → FALSE (idle)
T+0ms    텍스트 → debounce 큐에 추가
T+100ms  사진 processPhotos() → startProcessing() → queryState = "preparing"
T+500ms  텍스트 debounce 만료 → flushBatch()
         → resolvePendingRecoveryContext() → runQueryFlow()
         → sendMessageStreaming()
         → 💥 isRunning=true (사진이 이미 running)
```

**핵심:** debounce 큐에 들어간 시점에는 idle이었지만, flush 시점에는 running

### Race #3: 사진 핸들러 자체의 startProcessing vs sendMessageStreaming

```
processPhotos()
  ├── startProcessing()           ← queryState = "preparing"
  └── sendMessageStreaming()      ← if(isRunning) 체크
      └── isRunning = isQueryRunning() = (preparing은 포함 안 됨) → FALSE ✅
```

이건 현재 정상 동작 — preparing은 isRunning에서 제외됨.
**하지만 두 핸들러가 동시에 startProcessing() 호출하면 둘 다 preparing → 둘 다 sendMessageStreaming() 진입 시도 → 하나만 running으로 전환, 나머지 에러.**

---

## 4. 보호 메커니즘 현황

| 메커니즘 | 보호 대상 | 커버리지 |
|---------|----------|---------|
| `handleSteeringGate()` | 텍스트 → 실행 중 세션 | ✅ 텍스트만 |
| `MessageQueue` (500ms debounce) | 연속 텍스트 배칭 | ✅ 텍스트만 |
| `mediaGroupBuffer` (1s 타임아웃) | 같은 앨범 내 사진 합치기 | ✅ 같은 media group만 |
| `isRunning` guard (session.ts:589) | sendMessageStreaming 재진입 방지 | ✅ 에러로 차단 (큐잉 아님) |
| `startProcessing` 60s timeout | stuck 상태 자동 해제 | ✅ 안전밸브 |

**빈 구멍:**
1. ❌ 사진/문서 핸들러에는 steering gate 없음
2. ❌ 텍스트 debounce flush 시점에 isProcessing 재확인 안 함
3. ❌ 핸들러 간 (text↔photo↔document) 공유 큐/뮤텍스 없음

---

## 5. 수정 방안 (3가지 옵션)

### Option A: Session-Level Execution Queue (권장)

세션에 실행 큐를 추가해서 **모든** sendMessageStreaming 호출을 직렬화.

```typescript
// session.ts에 추가
private executionQueue: Promise<void> = Promise.resolve();

async sendMessageStreamingQueued(
  message: string,
  statusCallback: StatusCallback,
  chatId?: number,
  modelContext: ConfigContext = "general"
): Promise<string> {
  return new Promise((resolve, reject) => {
    this.executionQueue = this.executionQueue.then(async () => {
      try {
        const result = await this.sendMessageStreaming(message, statusCallback, chatId, modelContext);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}
```

**장점:** 모든 핸들러 수정 불필요, 세션 레벨에서 직렬화
**단점:** 큐에 쌓인 사진/텍스트가 순차 실행 → 응답 느려짐

### Option B: isProcessing Guard를 photo/document에도 적용

photo/document 핸들러에서도 `session.isProcessing` 체크 후, 처리 중이면 steering 버퍼에 추가.

```typescript
// photo.ts processPhotos() 시작 부분에
const session = sessionManager.getSession(chatId, threadId);
if (session.isProcessing) {
  session.addSteering(prompt, ctx.message?.message_id, "photo_handler");
  return;
}
```

**장점:** 기존 steering 인프라 활용
**단점:** 사진은 steering 버퍼와 다른 성격 (파일 경로 필요), 재설계 필요

### Option C: flushBatch에서 isProcessing 재확인

```typescript
async function flushBatch(key: string): Promise<void> {
  const batch = pendingBatches.get(key);
  if (!batch) return;

  const session = batch.latestParams.session;
  if (session.isProcessing) {
    // 세션 바쁨 → steering으로 전환
    const combined = batch.messages.join("\n");
    session.addSteering(combined, /* messageId */);
    pendingBatches.delete(key);
    return;
  }

  // ... 기존 flush 로직
}
```

**장점:** 최소 변경, 텍스트→사진 충돌만 해결
**단점:** 사진→텍스트 충돌은 미해결, 부분 수정

### 권장: Option A + C 조합

1. **A (세션 실행 큐)**: 근본적 직렬화 → 어떤 조합이든 충돌 불가
2. **C (flush 재확인)**: 이중 안전장치 → 불필요한 에러 메시지 방지

---

## 6. 관련 파일 목록

| 파일 | 역할 | 수정 필요 |
|-----|------|----------|
| `src/core/session/session.ts` | sendMessageStreaming, isRunning guard | ✅ 실행 큐 추가 |
| `src/core/session/state-machine.ts` | QueryState 정의 | ❌ 변경 없음 |
| `src/handlers/photo.ts` | 사진 처리 | ⚠️ queued 호출로 변경 |
| `src/handlers/document.ts` | 문서 처리 | ⚠️ queued 호출로 변경 |
| `src/handlers/media-group.ts` | 미디어 그룹 버퍼링 | ❌ 변경 없음 |
| `src/handlers/text.ts` | 텍스트 배칭 | ⚠️ flush 시 재확인 |
| `src/handlers/text/interrupt-flow.ts` | steering gate | ❌ 변경 없음 |
| `src/message-queue.ts` | 디바운스 큐 유틸 | ❌ 변경 없음 |

---

## 7. 테스트 시나리오

1. **사진 7장 + 텍스트 동시 전송** → 에러 없이 순차 처리
2. **텍스트 → 즉시 사진** → 텍스트 처리 후 사진 처리
3. **사진 → 즉시 텍스트** → 사진 처리 중 텍스트는 steering 또는 큐
4. **문서 + 텍스트 동시** → 위와 동일 패턴
5. **사진 앨범 + 별도 사진** → 앨범은 1초 버퍼링, 별도 사진은 큐


---

## 6. 2026-03-24 Fix Verification Update

### AS-IS / TO-BE 재확인
- AS-IS: 사진/문서 처리와 텍스트 debounce flush가 겹치면 `sendMessageStreaming is already running` 경로까지 진입한다.
- TO-BE: 사진/문서는 세션 단위로 직렬화되고, 텍스트 flush는 flush 시점에 바쁜 세션이면 query flow에 들어가지 않고 steering으로 전환된다.

### 최종 적용 경로
- `src/handlers/text.ts:49-95`
  - `flushBatch()`가 `handleSteeringGate()`를 다시 호출한다.
  - 분기: `session.isProcessing === true` 이면 `runQueryFlow()`로 가지 않고 즉시 steering으로 전환한다.
- `src/core/session/session.ts:177,541-547`
  - 세션에 `serializedQueryQueue`와 `runSerializedQuery()`를 추가했다.
  - 분기: 앞선 작업 성공/실패와 무관하게 다음 작업이 이어지도록 queue tail을 항상 정리한다.
- `src/handlers/photo.ts:60-127`
  - `processPhotos()` 전체를 `session.runSerializedQuery()` 안으로 이동했다.
  - 결과: `startProcessing()` 자체가 직렬화되어 photo/photo, text/photo 경합에서 상태를 덮어쓰지 않는다.
- `src/handlers/document.ts:211-335,341-420`
  - `processArchive()` / `processDocuments()`도 같은 방식으로 직렬화했다.

### RED
실패를 먼저 확인했다.
- `bun test src/core/session/session.test.ts src/handlers/text.refactor-regression.test.ts --test-name-pattern 'soma-qivc'`
- 실패 1: `src/core/session/session.test.ts:52-90`
  - `runSerializedQuery`가 `undefined`라서 직렬화 API가 없음을 확인.
- 실패 2: `src/handlers/text.refactor-regression.test.ts:203-258`
  - flush 이후 `startProcessing()`가 호출되어, busy session에서도 query flow에 진입함을 확인.

### GREEN
수정 후 같은 테스트를 다시 실행했다.
- `bun test src/core/session/session.test.ts src/handlers/text.refactor-regression.test.ts src/handlers/photo.test.ts --test-name-pattern 'soma-qivc'`
- 통과 1: `src/core/session/session.test.ts:52-90`
  - 동시 task 3개가 `first -> second -> third` 순서로 직렬 실행됨.
- 통과 2: `src/handlers/text.refactor-regression.test.ts:203-258`
  - `addSteering()`는 호출되고 `startProcessing()` / `sendMessageStreaming()`는 호출되지 않음.
- 통과 3: `src/handlers/photo.test.ts:84-138`
  - 단일 사진 2건 동시 호출에서도 `already running` 에러 reply 없이 두 요청이 모두 처리됨.

### 회귀 확인
- `bun run typecheck` ✅
- `bun test` ✅ (606 pass)
- `make lint` ✅ (기존 warning만 존재, 신규 error 없음)
