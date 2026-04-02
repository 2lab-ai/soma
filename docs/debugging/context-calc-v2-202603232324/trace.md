# Bug Trace: soma-nok6 / soma-u63c — Context Window % 계산 (v2)

## AS-IS: context window %가 부정확 (2826%, 516%, 0.0% 등)
## TO-BE: context window %가 실제 SDK의 context 점유율과 일치해야 함

## Phase 1: 근본 원인

### 원인 1: modelUsage는 CUMULATIVE (confirmed)
- `claude-adapter.ts:225-231` — modelUsage는 query() 내 모든 API call의 합산
- 14턴 query → 14번의 API call → cumulative ≈ 14 × actual_context
- 이전 코드: `usedTokens = input + cacheRead + cacheCreate` → 14× 뻥튀기

### 원인 2: stream_event (message_start) 가 안 나옴
- SDK 타입상 `SDKPartialAssistantMessage` (type: 'stream_event') 존재
- 실제 runtime에서 `message_start` 이벤트 yield 안됨 → per-call usage 캡처 불가

### 원인 3: contextWindow=200000 (SDK default, 1M 아님)
- `ModelUsage.contextWindow` = 200K (model spec fallback 적용 안 됨)
- session.ts:816-823에서 model-spec (1M) 으로 교정 → 이건 정상 작동 확인

## Fix: cumulative / num_turns

- SDK result event에 `num_turns` 필드 존재 (API 호출 횟수)
- `estimatedContextUsed = Math.round(cumulativeContext / numTurns)`
- 1턴: 정확한 값
- N턴: 평균값 (current ≈ average for slowly growing context)

## Phase 2: Red-Green 검증

### 테스트 추가 (claude-adapter.test.ts)

| 테스트 | numTurns | cumulative | estimated | %(1M) | 결과 |
|---|---|---|---|---|---|
| 1턴 단순 | 1 | 900,500 | 900,500 | 90.1% | ✅ PASS |
| 5턴 tool use | 5 | 502,500 | 100,500 | 10.1% | ✅ PASS |
| 14턴 (이전 2826%) | 14 | 5,652,204 | 403,729 | 40.4% | ✅ PASS |
| num_turns 없음 | 1(default) | 60,100 | 60,100 | 6.0% | ✅ PASS |

### 회귀 테스트
- `bun test src/providers/` — 17 pass, 0 fail ✅

## 한계점 (Known Limitations)

1. **평균 vs 현재**: num_turns 나눗셈은 평균값. context가 급격히 성장하면 과소추정 가능.
   - 예: 턴 1 = 40K, 턴 14 = 60K → 평균 50K, 실제 현재 60K → 16% 과소추정
2. **maxTokens 200K 문제**: adapter에서 200K 보내지만 session에서 1M 교정. 일시적 잘못된 값.
3. **stream_event 미지원**: SDK에서 message_start 안 나와서 per-call 정확한 값 불가.

## 결론
- 2826% → 40.4% 수준으로 정상화
- 기존 24개 커밋의 실패: 테스트 없이 "됐다"고 넘어감
- 이번: Red-Green 검증 완료, 회귀 테스트 통과
