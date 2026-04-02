# Bug Trace: soma-nok6 / soma-u63c — Context Window 103.2% 잘못 계산

## AS-IS: Context Window Usage가 1,032,405 / 1,000,000 (103.2%)로 표시됨
## TO-BE: 실제 context window 점유율만 표시되어야 함 (cache_read는 실제 window 점유가 아님)

## Phase 1: 휴리스틱 Top-3

### 가설 1: ClaudeCode context_window에서 cache_read + cache_create를 합산 ✅ 확정
- `usage-commands.ts:156` → `session.currentContextTokens` 호출
- `session.ts:254` → `actualContextUsed`가 1,032,405 → 그대로 반환
- `query-runtime.ts:631-633` → **버그 위치**:
  ```
  const usedTokens = contextWindowFromClaudeCode.usage.input_tokens +
      contextWindowFromClaudeCode.usage.cache_creation_input_tokens +
      contextWindowFromClaudeCode.usage.cache_read_input_tokens;
  ```
- ClaudeCode result event의 `context_window.current_usage`에서 input + cache_create + cache_read를 다 합산
- 스크린샷 Last query: Input=505, Cache read=949,302, Cache created=82,598
- 합계: 505 + 949,302 + 82,598 = 1,032,405 ← 딱 맞음!
- cache_read는 billing token이지 context window 점유가 아님

### 가설 2: context event (SDK 직접)에서 잘못 세팅
- `query-runtime.ts:390-398` → `actualContextUsed = event.usedTokens` → SDK가 직접 준 값 사용, 문제 없음 ❌ 배제

### 가설 3: restoreFromData에서 stale 값 복원
- `session.ts:1052-1055` → 복원 시 ALL context 값 clear → 문제 없음 ❌ 배제

## 결론

**가설 1 확정**: `query-runtime.ts:631-633`에서 ClaudeCode의 `current_usage`를 파싱할 때 `cache_read_input_tokens`를 합산하면 안 됨.

### 수정 방향
SDK 직접 context event (line 390-398)와 동일하게, ClaudeCode 경로에서도 `input_tokens`만 사용하거나, `context_window_size`와 매칭되는 실제 점유율만 사용해야 함.

단, `current_usage`의 `input_tokens`가 실제 context window 점유를 나타내는지 확인 필요.
실제 SDK context event에서는 `usedTokens` 하나만 주는데, ClaudeCode는 billing breakdown으로 줌.
→ `input_tokens`만이 실제 window 점유 (cache_read는 캐시 히트, cache_create는 이번 턴 캐시 생성).

**Fix: `usedTokens = input_tokens` only (drop cache_read and cache_create)**

## Applied Fix

### Root Cause
`query-runtime.ts:631-633` — ClaudeCode result event의 `context_window.current_usage`에서 billing tokens (input + cache_read + cache_create)를 합산하여 context window occupancy로 사용. 합계가 window max를 초과할 수 있음.

### Discovery
SDK CLI source 분석 결과, `context_window` 객체에 `used_percentage`와 `remaining_percentage` 필드가 존재하지만 우리가 파싱하지 않고 있었음.

### Fix Applied
1. `ClaudeCodeContextWindow` interface에 `used_percentage`, `remaining_percentage`, `total_input_tokens`, `total_output_tokens` 추가
2. `query-runtime.ts` — result handler에서:
   - Priority 1: `used_percentage` → SDK가 계산한 authoritative 퍼센티지에서 used tokens 역산
   - Priority 2: `total_input_tokens` → fallback, min(value, size) 적용
   - Priority 3: size만 설정, used는 "?" 표시

### Files Changed
- `src/core/session/session-helpers.ts` — ClaudeCodeContextWindow interface 확장
- `src/core/session/query-runtime.ts` — context_window 파싱 로직 수정
- `src/providers/claude-adapter.ts` — context event 생성 로직 근본 수정

## Phase 2: 배포 후 검증 (2026-03-23 22:41)

### 첫 번째 배포 결과
```
[ADAPTER] modelUsage fallback: contextWindow=200000 input=9
[CTX-EVENT] type=context maxTokens=200000 usedTokens=9 pct=0.0%
Usage: context_window=9/1000000 (0.0%)
```

### 발견된 추가 문제
1. `modelUsage`는 쿼리 내 모든 API 호출의 **누적값** — tool 5번 쓰면 5× inflate
2. `input_tokens=9`는 이번 턴의 새 입력만, 전체 context 아님
3. `context_window` 필드는 SDK direct path에서 사용 불가 (CLI만 추가)

### 진짜 Root Cause (심화)
`claude-adapter.ts`가 `modelUsage` (누적 billing)로 context event를 만듦:
- tool 10번 쓰는 쿼리 → 10번의 API call → 각각 full context 포함
- `modelUsage.inputTokens` = 10 × ~100K = 1M+ (누적)
- 하지만 실제 context window는 ~100K

### 최종 수정
`message_start` usage 추적 — 각 API call의 첫 usage event가 해당 call의 context snapshot.
마지막 `message_start`의 `input + cache_read + cache_create`가 현재 context window 상태.

Priority:
1. `result.context_window.used_percentage` (SDK CLI에서만 제공)
2. `latestMessageStartUsage` (마지막 API call의 context snapshot)
3. `modelUsage.input` only (fallback, 부정확)
