# SOMA Architecture Refactor v3.0 — Decision-First Draft

## 0. Status
- 이 문서는 **아키텍처를 확정하지 않은 상태**에서 작성된 v3 초안이다.
- 사용자 요구에 따라, 불명확한 항목을 먼저 질문/결정한 뒤에만 최종 설계를 고정한다.
- 현재 문서의 목적은 다음 2가지다.
  - 사용자의 강제 조건을 명시하고 범위를 고정
  - 의문점을 전부 Decision Register로 노출

---

## 1. Non-Negotiables (사용자 지시 고정)
1. 기존 테스트는 전부 삭제 후 재작성한다.
2. 아키텍처 핵심은 다음 2단 abstraction이다.
   - User -> (Abstraction A) -> soma/soul
   - soma/soul -> (Abstraction B) -> Model Provider
3. 불명확한 설계 포인트는 사용자에게 먼저 질문하고, 답변 기반으로만 확정한다.
4. `../soma-work`와 **지금 당장 병합하지 않는다**. 다만 v3는 최소한의 Slack 채널 + 유저 멀티테넌트 지원을 고려한 형태로 설계한다.

---

## 2. Target Frame (Tentative, Not Final)

```mermaid
flowchart LR
  U[User(s)] --> CA[Channel Adapter Boundary]
  CA --> A[Abstraction A: Channel Boundary]
  A --> C[soma/soul Core]
  C --> B[Abstraction B: Model Provider Boundary]
  B --> P1[Claude Adapter]
  B --> P2[Codex Adapter]
  B --> P3[Gemini Adapter]
  CA --> TG[Telegram Adapter]
  CA --> SL[Slack Adapter (Min Support)]
```

### 2.1 Abstraction A (User <-> soma/soul)
- 목적: 채널 의존성(Telegram/Discord/Slack)을 도메인에서 제거
- 후보 책임:
  - 입력 정규화(텍스트, 콜백, 첨부, 인터럽트)
  - 출력 정규화(시스템 메시지, 모델 메시지, 리액션, 선택 UI, 스트리밍)
  - 순서/동시성 제어(메시지 ordering + per chat/thread serialization)

### 2.2 Abstraction B (soma/soul <-> Model Providers)
- 목적: Claude 전용 런타임 의존을 provider-agnostic으로 전환
- 후보 책임:
  - query/stream/abort 공통 계약
  - tool hook/usage/context/session 이벤트 표준화
  - rate-limit fallback 정책 포인트 제공

### 2.3 External Baseline: `../soma-work` (참고만, 비병합)
- 현재 `soma-work`는 Slack 중심이며, 세션 키가 기본적으로 `channel + thread` 축에 맞춰져 있다.
- `WorkingDirectoryManager`는 `BASE_DIRECTORY/{userId}` 고정 전략을 사용한다.
- v3에서 바로 코드 통합하지 않더라도, Abstraction A는 `tenant/channel/thread/user` 식별자를 수용할 수 있어야 한다.
- 목표는 “즉시 병합”이 아니라, 나중에 Slack 멀티테넌트 요구를 흡수할 수 있는 계약을 먼저 고정하는 것이다.

---

## 3. Decision Register (답변 전까지 확정 금지)

## 3.1 Test Rewrite (T-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| T-01 | 테스트 삭제 범위는 어디까지인가? | A) `src/**/*.test.ts`만, B) `src` + `mcp-servers/**/test.ts`, C) 레포 전체 테스트 파일 |
| T-02 | 삭제 시점은? | A) 한 번에 전부 삭제 후 재작성, B) 모듈별 교체(기존 삭제+신규 동시), C) branch 분리 후 squash |
| T-03 | 테스트 러너 | A) Bun test 유지, B) Vitest 전환 |
| T-04 | Mock 정책 | A) 수동 mock 우선, B) spy/mock 라이브러리 도입 |
| T-05 | 우선 재작성 순서 | A) `session`/`text`/`callback` 먼저, B) domain pure 먼저, C) e2e 먼저 |
| T-06 | 커버리지 목표 | A) 수치 강제 없음, B) domain95/service85/adapter70, C) 단일 전체 수치 |
| T-07 | E2E 포함 여부 | A) 유닛/통합만, B) Telegram 포함 e2e 추가 |
| T-08 | 회귀 기준 | A) 핵심 시나리오 golden 테스트 필수, B) unit 중심으로 대체 |
| T-09 | flaky 허용 기준 | A) 0% 허용, B) 재시도 1회 허용 |
| T-10 | CI gate | A) test만, B) test+typecheck+lint 모두 required |

## 3.2 Abstraction A: User Boundary (A-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| A-01 | v3 범위 채널 | A) Telegram only, B) Telegram + Discord 인터페이스 동시 설계 |
| A-02 | 입력 메시지 최소 공통 스키마 필드 | A) `id/chatId/userId/text/attachments/timestamp`, B) thread/reply/locale까지 필수 |
| A-03 | thread 모델링 | A) chat 안의 optional, B) first-class key(`chatId:threadId`) |
| A-04 | 순서 보장 기준 | A) Telegram `message_id`, B) server timestamp, C) hybrid |
| A-05 | 인터럽트 우선순위 | A) 절대 최우선(큐 우회), B) 현재 작업 상태에 따라 정책적 우선 |
| A-06 | 시스템 출력 분리 수준 | A) SystemOutput/ModelOutput 완전 분리, B) 단일 OutputPort + type |
| A-07 | 리액션/키보드 abstraction 포함 여부 | A) Port에 포함, B) Telegram adapter 내부 private 기능 |
| A-08 | 첨부파일 전달 모델 | A) `fileId` 중심 지연 다운로드, B) ingress에서 즉시 byte/경로 변환 |
| A-09 | callback abstraction granularity | A) raw data 전달, B) 도메인 command로 파싱 후 전달 |
| A-10 | 스트리밍 API 형태 | A) push callback, B) async iterator 기반 output event |
| A-11 | rate-limit 책임 위치 | A) inbound middleware, B) core service policy |
| A-12 | auth 책임 위치 | A) inbound middleware 고정, B) core policy로도 중복 검증 |

## 3.3 soma/soul Boundary (S-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| S-01 | soma가 soul 파일을 직접 수정 가능한가? | A) 금지(전용 포트만), B) 제한 허용(allowlist), C) 현행 유지 |
| S-02 | memory analyzer/updater 소속 | A) soul adapter 계층으로 이동, B) soma core service 유지 |
| S-03 | prompts/identity 소스 오브 트루스 | A) soul 우선, B) soma config 우선, C) 병합 룰 정의 |
| S-04 | conversation-reader 기본 경로 정책 | A) 하드코딩 금지(env/config 필수), B) 기본값 허용 |
| S-05 | restart/save context 파일 위치 | A) soma 내부만, B) soul과 공유 경로 허용 |
| S-06 | soul 관련 기능의 보안 경계 | A) read-only 기본, B) read-write 기본 |

## 3.4 Abstraction B: Provider Boundary (P-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| P-01 | v3 provider in-scope | A) Claude only interface, B) Claude+Codex 계약 동시, C) Claude+Codex+Gemini 계약 동시 |
| P-02 | 표준 이벤트 스키마 수준 | A) text/tool/usage/done만, B) session/context/rate-limit까지 포함 |
| P-03 | provider capability 계약 | A) boolean flags 최소, B) context/tool/hook/session 상세 capability |
| P-04 | mid-stream injection 계약 | A) optional capability, B) 필수 기능으로 강제 |
| P-05 | tool safety 책임 | A) core hook chain, B) provider adapter 내부 |
| P-06 | rate-limit fallback 위치 | A) provider orchestrator service, B) handler/text 계층 유지 |
| P-07 | model selection 책임 | A) provider boundary 밖 전략 서비스, B) provider adapter 내부 |
| P-08 | session resume semantics | A) provider 공통 contract, B) Claude 전용 확장 필드 |
| P-09 | usage telemetry 표준화 | A) provider별 raw 유지, B) normalized usage DTO 필수 |
| P-10 | 오류 taxonomy | A) recoverable/fatal 2단계, B) rate_limit/auth/network/tool/abort 세분화 |
| P-11 | retry/backoff 정책 | A) core policy 고정, B) provider별 개별 정책 |
| P-12 | permission mode 설정 위치 | A) provider adapter config, B) core query policy |

## 3.5 Migration/Execution (M-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| M-01 | 마이그레이션 방식 | A) Strangler incremental, B) Big-bang rewrite |
| M-02 | 1차 타겟 | A) `session.ts` 분해, B) `text.ts` 분해, C) provider port 먼저 |
| M-03 | PR 크기 제한 | A) 500 LOC 이하, B) 1000 LOC 이하, C) 제한 없음 |
| M-04 | backward compatibility 기간 | A) 즉시 전환, B) dual-path 1~2주 |
| M-05 | dead code 정리 시점 | A) 마지막 phase 일괄, B) 단계별 즉시 제거 |

## 3.6 `soma-work` 호환 고려 (W-XX)
| ID | 질문 | 옵션 |
|---|---|---|
| W-01 | tenant 식별자 필수화 범위 | A) 미적용(single-tenant), B) optional tenantId, C) required tenantId |
| W-02 | 세션 키 전략 | A) `channel:thread`, B) `tenant:channel:thread`, C) `tenant:channel:thread:user` |
| W-03 | 멀티유저 스레드 인터럽트 정책 | A) owner-only, B) initiator 우선 + owner override, C) role-based |
| W-04 | 작업 디렉토리 격리 기준 | A) per-user, B) per-channel, C) hybrid(tenant/user/channel) |
| W-05 | v3 Slack 최소 지원 범위 | A) text/thread, B) +file/reaction, C) +interactive(choice/form) |
| W-06 | Slack 출력 계약 깊이 | A) text only, B) +status/reaction, C) +interactive output |
| W-07 | 저장소 partition 키 | A) channel/thread, B) tenant/channel/thread, C) tenant/channel/thread/user |
| W-08 | 멀티테넌트 auth 경계 | A) global allowlist, B) tenant allowlist, C) policy provider |
| W-09 | 비병합 상태에서의 반영 방식 | A) docs-only, B) flag behind adapter skeleton, C) dual-runtime bridge |
| W-10 | `soma`↔`soma-work` 계약 동기화 방식 | A) 문서 동기화, B) contract test 동기화, C) shared schema package |

## 3.7 Clarify 상세 문서
- 각 질문별 문맥/트레이드오프/되돌리기 비용은 `docs/clairfy/INDEX.md`를 기준으로 관리한다.
- 개별 파일은 `docs/clairfy/T-01.md` 형식으로 ID별 분리되어 있다.

---

## 4. Test Reset Inventory (현재 삭제 후보)

### 4.1 `src/` 테스트 (23개)
- `src/bd-client.test.ts`
- `src/config.test.ts`
- `src/handlers/choice-flow.integration.test.ts`
- `src/handlers/streaming.test.ts`
- `src/message-queue.test.ts`
- `src/services/chat-capture-service.test.ts`
- `src/services/chat-search-service.test.ts`
- `src/services/claude-md-updater.test.ts`
- `src/services/context-persistence.test.ts`
- `src/services/conversation-reader.test.ts`
- `src/services/memory-analyzer.test.ts`
- `src/services/memory-updater.test.ts`
- `src/services/retention-cleanup.test.ts`
- `src/services/skills-registry.test.ts`
- `src/services/summary-generator.test.ts`
- `src/session.test.ts`
- `src/storage/chat-storage.test.ts`
- `src/storage/summary-storage.test.ts`
- `src/stores/pending-form-store.test.ts`
- `src/utils/error-classification.test.ts`
- `src/utils/system-message.test.ts`
- `src/utils/telegram-choice-builder.test.ts`
- `src/utils/user-choice-extractor.test.ts`

### 4.2 `mcp-servers/` 테스트 (1개)
- `mcp-servers/chat-history/test.ts`

---

## 5. v3 실행 골격 (결정 후 확정)
1. Decision freeze (본 문서 3장 응답 확정)
2. ADR 작성 (`docs/adr/`)
3. 테스트 리셋 실행
4. Abstraction A 계약 + adapter 분리
5. Abstraction B 계약 + provider orchestration 분리
6. `session/text/callback/streaming` 순차 이관
7. 회귀 검증 + dead code 제거

---

## 6. 사용자 답변 템플릿
아래 형식으로 답변하면 즉시 v3 final을 확정할 수 있다.

```text
T-01=B
T-02=A
T-03=A
...
A-01=A
A-02=B
...
S-01=A
...
P-01=B
...
M-01=A
...
W-01=C
...
```

---

## 7. 현재 상태 요약
- v3는 **질문 중심 문서**로 작성됨
- 아키텍처는 아직 lock하지 않음
- 사용자 답변 수신 후 `v3 final`로 확정하고, 구현 phase 문서까지 이어서 작성 가능
