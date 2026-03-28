# Bug Trace: SDK Error Information Loss

## AS-IS: SDK 에러 발생 시 에러 정보가 잘리거나 삼켜져서 원인 파악 불가
## TO-BE: SDK에서 받는 에러의 모든 속성이 빠짐없이 로깅 및 유저에게 전달

## Phase 1: Heuristic Top-5

### Hypothesis 1: extractErrorDetails()가 SDK 에러의 추가 속성을 추출하지 않음 ✅ CONFIRMED
- `src/utils/error-classification.ts:186-228` — `extractErrorDetails()` 함수
- 추출하는 필드: `message`, `name`, `stack`, `cause`, `exitCode` (regex), `stderr` (regex)
- **누락된 SDK 필드들:**
  - `status` / `statusCode` (HTTP status code)
  - `code` — NormalizedProviderError.code (RATE_LIMIT, AUTH, NETWORK 등)
  - `providerId`
  - `retryable`
  - SDK `result` 이벤트의 `errors: string[]` 배열
  - SDK `assistant` 이벤트의 `error: SDKAssistantMessageError`

### Hypothesis 2: SDK result 이벤트의 error variant 무시 ✅ CONFIRMED
- `query-runtime.ts:700` — event.subtype 체크 없음, event.errors 무시, event.is_error 무시
- `claude-adapter.ts:244-308` — 항상 reason: "completed" 반환

### Hypothesis 3: 에러 정보 절단 (Truncation) ✅ CONFIRMED
- session.ts:869 → 100자, error-classification.ts:257 → 800자
- query-flow.ts:307 → 800자, callback.ts:117 → 200자

### Hypothesis 4: Silent catch blocks ✅ CONFIRMED — 10+ 건

### Hypothesis 5: String(error)로 구조화 정보 유실 ✅ CONFIRMED

## Fix Plan
1. extractErrorDetails() — SDK 에러 속성 추출 추가
2. query-runtime.ts — result 이벤트 error variant 처리
3. claude-adapter.ts — error result 감지 및 전달
4. session.ts:869 — lastError 절단 완화
5. formatErrorForLog() — 전체 출력
6. formatErrorForUser() — diagnostic 정보 포함
7. Silent catch blocks — console.warn 추가
