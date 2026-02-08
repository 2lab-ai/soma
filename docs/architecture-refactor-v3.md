# SOMA Architecture Refactor v3.1 — ADR Applied Final

## 0. Status
- 상태: **Decision Freeze Complete**
- 기준 문서: `docs/ADR.md` (55/55 결정 확정)
- 이 문서는 기존 v3 질문 초안을 대체하는 **실행 기준 문서**다.

---

## 1. Locked Constraints
1. 기존 테스트는 레포 전체에서 삭제 후 재작성한다. (`T-01=C`, `T-02=A`)
2. 핵심 경계는 2단 abstraction으로 고정한다.
   - User(s) -> Abstraction A (Channel Boundary) -> soma/soul Core
   - soma/soul Core -> Abstraction B (Provider Boundary) -> Model Providers
3. `soma-work`는 지금 병합하지 않고, Slack + 멀티테넌트 최소 지원이 가능한 계약으로 설계한다.
4. OpenClaw 호환은 **메인 리팩토링 범위에서 분리**하며, 별도 옵션 트랙으로만 관리한다.
5. 마이그레이션은 Big-bang으로 진행하며 dual-path를 두지 않는다. (`M-01=B`, `M-04=A`)

---

## 2. ADR Snapshot (Applied)

### 2.1 Test Strategy (T)
- 범위: 레포 전체 테스트 삭제 후 재작성
- 러너: Bun test 유지
- Mock: 수동 mock
- 순서: domain pure 먼저
- 커버리지: domain95/service85/adapter70
- 테스트 타입: 유닛/통합만 (E2E 제외)
- 회귀 기준: golden 스냅샷
- CI gate: test + typecheck + lint

### 2.2 Abstraction A (A)
- 멀티채널 인터페이스를 기본으로 설계
- 입력 공통 스키마에 thread/reply/locale 포함
- thread는 first-class key
- 순서 기준은 server timestamp
- interrupt는 절대 최우선(큐 우회)
- 출력은 단일 OutputPort + discriminated `type`
- reaction/keyboard는 Port 계약에 포함
- callback은 도메인 command로 파싱 후 전달
- 스트리밍은 push callback
- auth/rate-limit 책임은 inbound middleware

### 2.3 soma/soul Boundary (S)
- soma의 soul write는 allowlist 제한
- memory analyzer/updater는 soul adapter 계층으로 이동
- prompts/identity source of truth는 soul 우선
- restart/save context 파일은 soma 내부만 사용
- soul 보안 경계는 read-only 기본

### 2.4 Abstraction B (P)
- Provider 범위: Claude + Codex
- 이벤트 스키마: text/tool/usage + session/context/rate-limit 포함
- capability 계약: boolean flags 최소화
- mid-stream injection: optional
- tool safety: core hook chain
- rate-limit fallback: provider orchestrator
- model selection: provider boundary 밖 전략 서비스
- session resume: provider 공통 contract
- usage telemetry: normalized DTO
- 오류 taxonomy: 세분화 (rate_limit/auth/network/tool/abort 등)
- retry/backoff: provider별 정책
- permission mode: core query policy

### 2.5 Migration & Integration (M/W)
- Big-bang rewrite, 즉시 전환, dead code 즉시 제거
- tenantId required
- session key: `tenant:channel:thread`
- storage partition key: `tenant/channel/thread`
- working directory: per-thread (`{tenant}/{channel}/{thread}/`)
- Slack 최소 지원: text/thread + status/reaction
- 비병합 반영: feature flag + skeleton adapter
- `soma`↔`soma-work` 동기화: contract test

---

## 3. Final Target Architecture

```mermaid
flowchart LR
  U["User(s)"] --> C["Channel Boundary (Abstraction A)"]
  C --> I["Inbound Middleware\n(auth, rate-limit, normalize)"]
  I --> R["Route Resolver\nresolveAgentRoute"]
  R --> Q["Core Query Orchestrator"]
  Q --> P["Provider Boundary (Abstraction B)"]
  P --> P1["Claude Adapter"]
  P --> P2["Codex Adapter"]
  Q --> O["Outbound Orchestrator\ndeliverOutboundPayloads"]
  O --> C
  C --> TG["Telegram Adapter"]
  C --> SL["Slack Adapter (min)"]
```

### 3.1 Abstraction A Contract (Final)
- 필수 식별자: `tenantId`, `channelId`, `threadId`, `userId`, `messageId`, `timestamp`
- 인바운드 규칙:
  - 입력은 channel adapter에서 공통 envelope로 정규화
  - interrupt는 queue bypass
  - auth/rate-limit은 adapter 진입점에서 차단
- 아웃바운드 규칙:
  - 단일 OutputPort에 `type`으로 payload 분기
  - `text`, `status`, `reaction`, `choice/keyboard`를 공통 이벤트로 취급

### 3.2 Abstraction B Contract (Final)
- 공통 API:
  - `startQuery`
  - `streamEvents`
  - `abortQuery`
  - `resumeSession`
- 이벤트 모델:
  - `text`, `tool`, `usage`, `done`, `session`, `context`, `rate_limit`
- 보안/품질 규칙:
  - tool safety는 core hook chain에서 통합 관리
  - provider별 retry/backoff는 orchestrator에서 라우팅
  - usage는 normalized DTO로만 core에 전달

### 3.3 Optional Track: OpenClaw Compatibility (Deferred)
- 메인 v3 실행의 필수 경로가 아니다.
- 별도 트랙 문서로 분리 관리한다:
  - `docs/tracks/openclaw-compatibility-v3-optional.md`
- 본문 execution dependency에는 포함하지 않는다.

### 3.4 soma-work Compatibility Profile (Non-Merge)
- 채널 매핑 규칙:
  - Telegram 일반채팅 <-> Slack DM 1:1
  - Telegram 그룹방 <-> Slack 채널
  - Telegram 그룹 thread <-> Slack 채널 thread
- 권한 모델:
  - tenant allowlist
  - interrupt는 initiator 우선 + owner override

---

## 4. Execution Plan (Big-bang)
1. Decision freeze 적용 (완료)
2. Core 계약 스켈레톤 생성 (Channel/Provider/Route/Identity)
3. Provider boundary 구현 (Claude+Codex) — `M-02=C`
4. Channel boundary 구현 (Telegram 우선 + Slack skeleton)
5. Outbound orchestrator 중앙화
6. 레거시 handler/session 경로 제거 (단계별 즉시 삭제)
7. 테스트 전면 재작성
8. quality gate 통과: test + typecheck + lint

롤백 원칙:
- dual-path는 두지 않는다.
- 실패 시 git revert로 전체 단위 되돌림.

---

## 5. Execution Epics Graph (Multi-Team)

메인 실행 에픽(`agi-vbj` 하위):
- `agi-vbj.4` v3-exec-1: core contracts foundation
- `agi-vbj.5` v3-exec-1b: domain/session-core extraction
- `agi-vbj.6` v3-exec-2: provider boundary
- `agi-vbj.7` v3-exec-3: telegram channel boundary
- `agi-vbj.8` v3-exec-4: slack skeleton + tenant boundary
- `agi-vbj.9` v3-exec-5: outbound orchestration + unified output port
- `agi-vbj.10` v3-exec-6: storage/scheduler partition refactor
- `agi-vbj.11` v3-exec-7: full test rewrite + quality gates
- `agi-vbj.12` v3-exec-8: cutover cleanup + legacy deprecation

옵션 트랙:
- `agi-vbj.13` v3-track-x: optional openclaw compatibility (deferred, non-blocking)

```mermaid
flowchart LR
  E1["agi-vbj.4 Core Contracts"]
  E2["agi-vbj.5 Domain Session Core"]
  E3["agi-vbj.6 Provider Boundary"]
  E4["agi-vbj.7 Telegram Boundary"]
  E5["agi-vbj.8 Slack Skeleton"]
  E6["agi-vbj.10 Storage Scheduler Partition"]
  E7["agi-vbj.9 Outbound Orchestrator"]
  E8["agi-vbj.11 Test Rewrite + Gates"]
  E9["agi-vbj.12 Cutover Cleanup"]
  X["agi-vbj.13 OpenClaw Optional Track"]

  E1 --> E2
  E1 --> E3
  E1 --> E4
  E1 --> E5
  E1 --> E6
  E3 --> E7
  E4 --> E7
  E5 --> E7
  E2 --> E8
  E3 --> E8
  E4 --> E8
  E5 --> E8
  E6 --> E8
  E7 --> E8
  E8 --> E9
```

병렬 실행 가이드:
- Lane A: `agi-vbj.6` (Provider)
- Lane B: `agi-vbj.7` (Telegram)
- Lane C: `agi-vbj.8` (Slack skeleton)
- Lane D: `agi-vbj.10` (Storage/Scheduler)
- 공통 선행: `agi-vbj.4`
- 통합 병목: `agi-vbj.9` -> `agi-vbj.11` -> `agi-vbj.12`
- `agi-vbj.13`은 메인 경로와 독립 실행

---

## 6. Test Reset Plan (Applied)

### 5.1 Reset
- 레포 전체 테스트 파일 삭제
- 기존 flaky 관용 없음 (0%)

### 5.2 Rebuild Order
1. Domain tests (pure)
2. Service tests (port orchestration)
3. Adapter integration tests

### 5.3 Quality Gates
- `bun test`
- `bun run typecheck`
- `make lint`

---

## 7. Directory Plan (TO-BE)

```text
src/
├─ channels/
│  ├─ dock.ts
│  └─ plugins/
│     ├─ types.core.ts
│     ├─ types.adapters.ts
│     ├─ types.plugin.ts
│     ├─ telegram.ts
│     └─ slack.ts
├─ routing/
│  ├─ resolve-route.ts
│  └─ session-key.ts
├─ core/
│  ├─ query-orchestrator.ts
│  ├─ tool-safety-chain.ts
│  └─ model-selection-strategy.ts
├─ providers/
│  ├─ types.models.ts
│  ├─ orchestrator.ts
│  ├─ claude-adapter.ts
│  └─ codex-adapter.ts
├─ infra/outbound/
│  └─ deliver.ts
└─ adapters/
   ├─ telegram/
   └─ slack/
```

---

## 8. Legacy Plan Handling
- 아래 2개 계획은 v3에 의해 superseded 상태로 유지한다.
  - v2 Hexagonal plan (`soma-zl7u`)
  - message-processing refactor (`soma-701o`)
- v3 구현 완료 시 해당 범위는 자동 해소로 간주한다.

---

## 9. References
- 결정 소스: `docs/ADR.md`
- OpenClaw 옵션 트랙: `docs/tracks/openclaw-compatibility-v3-optional.md`
- Clarify 상세 기록(archive): `docs/archive/refactor-pre-adr-2026-02/clairfy/INDEX.md`
- v3 전체 시각화 다이어그램: `docs/refactor-v3-visualization.md`
