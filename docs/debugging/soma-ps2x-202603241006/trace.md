# Bug Trace: soma-ps2x — restart 이후 첫 메시지가 "이전 요청 처리 중"으로 오인됨

## AS-IS
- 재시작 직후 새 메시지를 보내도 `sendMessageStreaming is already running. Concurrent calls are not supported.` 경로로 빠지며, 사용자에게 `⏳ 이전 요청 처리 중입니다. 메시지가 대기열에 추가되었습니다.`가 표시된다.

## TO-BE
- 재시작 후 첫 메시지는 정상적으로 새 쿼리를 시작해야 한다.
- 최소한 현재 요청이 스스로 올린 `preparing` 상태는 동시 실행으로 오인하면 안 된다.

## Phase 1: Heuristic Top-3

### Hypothesis 1: `startProcessing()`가 올린 `preparing` 상태를 re-entrancy guard가 동시 실행으로 오인한다
- [`src/handlers/text/query-flow.ts:42`](/home/zhugehyuk/2lab.ai/soma/src/handlers/text/query-flow.ts#L42) → `runQueryFlow()`가 쿼리 시작 전에 `session.startProcessing()` 호출
- [`src/handlers/text/query-flow.ts:56`](/home/zhugehyuk/2lab.ai/soma/src/handlers/text/query-flow.ts#L56) → 같은 실행 흐름에서 즉시 `session.sendMessageStreaming(...)` 호출
- [`src/core/session/session.ts:512`](/home/zhugehyuk/2lab.ai/soma/src/core/session/session.ts#L512) → `startProcessing()`는 `startProcessingTransition()`으로 `queryState = "preparing"` 설정
- [`src/core/session/state-machine.ts:165`](/home/zhugehyuk/2lab.ai/soma/src/core/session/state-machine.ts#L165) → `isQueryRunning()`은 현재 `queryState !== "idle"` 이면 모두 `true`
- [`src/core/session/session.ts:589`](/home/zhugehyuk/2lab.ai/soma/src/core/session/session.ts#L589) → `sendMessageStreaming()` 진입 즉시 `if (this.isRunning)`으로 차단
- 확인 결과: `preparing`도 `isRunning=true`가 되어, 현재 요청 자신이 올린 준비 상태를 동시 실행으로 오인함 ✅ Confirmed

### Hypothesis 2: 재시작 부트스트랩이 백그라운드에서 자동으로 `sendMessageStreaming()`을 점유한다
- [`src/app/bootstrap.ts:286`](/home/zhugehyuk/2lab.ai/soma/src/app/bootstrap.ts#L286) → restart marker 처리 시 verification task가 있는 경우에만 proactive boot 실행
- [`src/app/bootstrap.ts:342`](/home/zhugehyuk/2lab.ai/soma/src/app/bootstrap.ts#L342) → 그 경우에만 `session.sendMessageStreaming(...)` 자동 호출
- [`src/app/bootstrap.ts:351`](/home/zhugehyuk/2lab.ai/soma/src/app/bootstrap.ts#L351) → verification task가 없으면 restart context만 `nextQueryContext`에 저장
- [`src/app/bootstrap.ts:397`](/home/zhugehyuk/2lab.ai/soma/src/app/bootstrap.ts#L397) → 일반 재시작은 `nextQueryContext` 설정만 하고 쿼리를 시작하지 않음
- 확인 결과: 사용자가 보여준 일반 SIGTERM 재시작 로그만으로는 부트스트랩 자동 쿼리가 시작되지 않음 ❌ Ruled out for this symptom

### Hypothesis 3: 세션 파일 복원 시 stale runtime state가 복원된다
- [`src/core/session/session-manager.ts:115`](/home/zhugehyuk/2lab.ai/soma/src/core/session/session-manager.ts#L115) → 부팅 시 저장된 세션을 `restoreFromData()`로 복원
- [`src/core/session/session.ts:1029`](/home/zhugehyuk/2lab.ai/soma/src/core/session/session.ts#L1029) → `restoreFromData()`는 `sessionId`, token 집계, context 메타데이터만 복원
- [`src/core/session/session.ts:1029`](/home/zhugehyuk/2lab.ai/soma/src/core/session/session.ts#L1029) 부근에서 `_queryState`, `stopRequested`, `abortController` 복원 없음
- 확인 결과: 재시작 뒤 stale `queryState=running`이 디스크에서 복원되는 경로는 보이지 않음 ❌ Ruled out

## Conclusion
- 원인은 restart 자체보다 더 앞단의 상태 머신 정의다.
- 현재 설계에서 `preparing`은 "새 요청을 시작하기 위해 잠깐 점유한 상태"인데, `isRunning()`이 여기를 포함해서 자기 자신을 재진입으로 막는다.
- 따라서 재시작 직후가 아니더라도, `runQueryFlow()`가 `startProcessing()` 후 `sendMessageStreaming()`을 부르는 모든 경로에서 동일 증상이 날 수 있다.
