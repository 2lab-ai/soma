# Architecture Decision Records — soma v3

## Status: DECISION FREEZE COMPLETE (2025-02-08)

55/55 decisions locked.

---

## Test Strategy (T)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 1 | T-01 | **C: 레포 전체 삭제** | Big-bang과 일관, 테스트 철학 완전 리셋 |
| 2 | T-02 | **A: 한번에 전부 삭제** | T-01, M-01과 일관 |
| 3 | T-03 | **A: Bun test 유지** | 런타임 일관, 전환 이점 없음 |
| 4 | T-04 | **A: 수동 mock** | 포트 기반 아키텍처, 인터페이스 직접 구현이 의도 명확 |
| 5 | T-05 | **B: domain pure 먼저** | 기초부터, 포트/도메인 타입 잡고 위로 |
| 6 | T-06 | **B: 계층별 목표 (domain95/service85/adapter70)** | 포트 기반이니 계층별 중요도 다름 |
| 7 | T-07 | **A: 유닛/통합만** | 1인 프로젝트, e2e flaky + 인프라 관리비 비효율 |
| 8 | T-08 | **A: golden 스냅샷** | 새 아키텍처 기준 새 golden 촬영 |
| 9 | T-09 | **A: 0% flaky** | unit/통합만이라 flaky 나면 테스트 자체 문제 |
| 10 | T-10 | **B: test+typecheck+lint** | TS 프로젝트 typecheck 필수 |

## Abstraction A: Channel Boundary (A)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 11 | A-01 | **B: 멀티채널 인터페이스** | Telegram 우선, Slack adapter 확장 고려 |
| 12 | A-02 | **B: thread/reply/locale 포함** | thread first-class와 일관 |
| 13 | A-03 | **B: first-class key (chatId:threadId)** | W-07 partition 키와 일관 |
| 14 | A-04 | **B: 서버 timestamp** | 멀티채널 중립적, Slack ts와 통일 |
| 15 | A-05 | **A: 절대 최우선 (큐 우회)** | 사용자 경험 우선, cleanup은 후처리 |
| 16 | A-06 | **B: 단일 OutputPort + type** | discriminated union, 포트 관리 단순화 |
| 17 | A-07 | **A: Port에 reaction/keyboard 포함** | Slack도 reaction/button 있음, 멀티채널 일관 |
| 18 | A-08 | **B: ingress 즉시 byte/경로 변환** | 현행 유지, adapter 경계에서 변환 |
| 19 | A-09 | **B: 도메인 command 파싱** | adapter가 번역, core는 도메인만 |
| 20 | A-10 | **A: push callback** | SDK가 callback 기반, 변환 레이어 불필요 |
| 21 | A-11 | **A: inbound middleware** | adapter 진입점 차단, 채널 특성별 처리 |
| 22 | A-12 | **A: inbound middleware 고정** | 1인 프로젝트, 내부 경로 단순 |

## soma/soul Boundary (S)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 23 | S-01 | **B: allowlist 제한** | MEMO.txt, history/, MEMORY.md만 write |
| 24 | S-02 | **A: soul adapter 계층** | I/O 책임 분리, S-01과 일관 |
| 25 | S-03 | **A: soul 우선** | identity는 soul 영역, soma는 읽기만 |
| 26 | S-04 | **B: 기본값 허용** | 1인/단일 환경, env override 가능하면 충분 |
| 27 | S-05 | **A: soma 내부만** | restart context는 soma 프로세스 내부 상태 |
| 28 | S-06 | **A: read-only 기본** | S-01 allowlist와 일관 |

## Abstraction B: Provider Boundary (P)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 29 | P-01 | **B: Claude+Codex 동시 계약** | Codex 이미 사용 중, 2 provider면 generic |
| 30 | P-02 | **B: session/context/rate-limit 포함** | compact event 등 이미 실제 필요 증명됨 |
| 31 | P-03 | **A: boolean flags 최소** | 2 provider에 상세 capability는 과설계 |
| 32 | P-04 | **A: optional capability** | Codex steering 미지원, 강제하면 억지 구현 |
| 33 | P-05 | **A: core hook chain** | tool safety는 보안, core 통합 관리 |
| 34 | P-06 | **A: provider orchestrator** | 멀티 provider별 rate-limit 정책 다를 수 있음 |
| 35 | P-07 | **A: provider 밖 전략 서비스** | model selection은 비즈니스 정책 |
| 36 | P-08 | **A: provider 공통 contract** | adapter 내부에서 Claude session_id 매핑 |
| 37 | P-09 | **B: normalized usage DTO** | cross-provider 비용 추적 필요 |
| 38 | P-10 | **B: 세분화 taxonomy** | 에러별 맞춤 대응, 기존 패턴과 일관 |
| 39 | P-11 | **B: provider별 개별 정책** | provider 특성 의존, orchestrator가 관리 |
| 40 | P-12 | **B: core query policy** | permission은 보안, P-05와 일관 |

## Migration (M)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 41 | M-01 | **B: Big-bang rewrite** | 1인 프로젝트, ~5K LOC, 테스트 리셋 |
| 42 | M-02 | **C: provider port 먼저** | T-05 domain pure와 일관, 기초부터 |
| 43 | M-03 | **C: 제한 없음** | 1인 + Big-bang, PR 크기 제한 불필요 |
| 44 | M-04 | **A: 즉시 전환** | Big-bang과 일관, git revert로 롤백 |
| 45 | M-05 | **B: 단계별 즉시 제거** | Big-bang이니 레거시 불필요, git history 참고 |

## soma-work Integration (W)

| # | ID | 결정 | 근거 |
|---|---|---|---|
| 46 | W-01 | **C: required tenantId** | 멀티채널+멀티테넌트, null 분기 제거 |
| 47 | W-02 | **B: tenant:channel:thread** | W-07과 동일 복합 키 |
| 48 | W-03 | **B: initiator 우선 + owner override** | 마지막 발화자 주도권, owner 긴급 중단 |
| 49 | W-04 | **per-thread** | thread first-class와 일관, {tenant}/{channel}/{thread}/ |
| 50 | W-05 | **A: text/thread만** | skeleton adapter에 최소 계약 |
| 51 | W-06 | **B: +status/reaction** | 실용적 최소 출력 계약 |
| 52 | W-07 | **B: tenant/channel/thread** | TG일반↔SlackDM, TG그룹↔Slack채널, TG thread↔Slack thread |
| 53 | W-08 | **B: tenant allowlist** | required tenantId와 일관, tenant별 권한 |
| 54 | W-09 | **B: feature flag + skeleton** | 포트 컴파일 타임 검증, 런타임 비활성 |
| 55 | W-10 | **B: contract test** | CI 자동 드리프트 탐지 |

---

## Channel Mapping Rule

```
Telegram 일반채팅    ↔  Slack DM 1:1
Telegram 그룹방      ↔  Slack 채널
Telegram 그룹 thread ↔  Slack 채널 thread
```

---

## Non-Negotiables (변경 불가)
1. 기존 테스트는 전부 삭제 후 재작성
2. 2단 abstraction: User↔Channel Boundary↔Core↔Provider Boundary↔Model
3. 불명확한 설계는 사용자 질문→답변 기반 확정
4. soma-work 즉시 병합 안 함, 단 Slack+멀티테넌트 고려 설계
