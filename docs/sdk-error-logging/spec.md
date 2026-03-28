# SDK Error Full Logging

## Problem

SDK 에러 발생 시 에러 정보가 절단(100~800자)되거나 silent catch로 삼켜져서 원인 파악이 불가능.

## Goal

`@anthropic-ai/claude-agent-sdk`에서 발생하는 모든 에러의 전체 속성을 로그와 유저 메시지에 출력.

## Scope

| Category | Description |
|----------|-------------|
| In scope | extractErrorDetails 확장, result event error variant 처리, silent catch 제거, truncation 완화 |
| Out of scope | 에러 복구 로직 변경, rate limit 정책 변경, 새 retry 전략 |

## Architecture Decisions

### AD-1: extractErrorDetails()에 SDK 에러 속성 추가
- `statusCode`, `code`, `providerId`, `retryable`, `boundary` 필드 추출
- NormalizedProviderError 타입 가드 추가

### AD-2: SDK result event error variant 처리
- `event.subtype` 체크 → `error_during_execution`, `error_max_turns` 등
- `event.errors[]` 배열 로깅
- `event.is_error` 플래그 반영

### AD-3: claude-adapter에서 error result를 done:failed로 전달
- `event.subtype !== 'success'` → `reason: "failed"` + `errorMessage` 포함

### AD-4: 절단 완화
- `lastError`: 100 → 500자
- `formatErrorForUser`: message 800 → 2000자, SDK diagnostic 정보 추가
- `formatErrorForLog`: 절단 없이 전체 출력

### AD-5: Silent catch → console.warn
- 모든 빈 catch 블록에 최소 console.warn 추가

## Files to Modify

1. `src/utils/error-classification.ts` — extractErrorDetails, formatErrorForLog, formatErrorForUser
2. `src/core/session/query-runtime.ts` — result event handler
3. `src/providers/claude-adapter.ts` — result event handler
4. `src/core/session/session.ts` — lastError truncation
5. `src/handlers/text/query-flow.ts` — silent catches
6. `src/handlers/callback.ts` — silent catches
7. `src/providers/error-normalizer.ts` — 원본 에러 cause 체인 보존

## Size: medium (~50 lines net change across 7 files)
