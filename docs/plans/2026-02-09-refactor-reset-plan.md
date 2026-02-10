# SOMA Refactoring Reset Plan (2026-02-09)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 현재 혼재된 리팩토링 상태를 정리해, `session` 중심 단일 진입 흐름을 명확한 계층 구조로 재배치하고 안정적으로 마이그레이션한다.

**Architecture:** 런타임 진입점/핸들러/세션 실행/채널 경계/프로바이더 경계를 분리한다. 우선은 동작을 유지한 채 파일 책임을 분해하고, 이후 인터페이스를 기준으로 교체 가능한 구조로 수렴한다.

**Tech Stack:** TypeScript, Bun, grammY, Claude Agent SDK, bd tracker

## 1) Scope and Rules

- 이번 문서는 기존 v3 문서군을 대체하는 기준 계획이다.
- 목표는 "완전 재작성"이 아니라 "현재 코드와 테스트를 살리는 점진적 재구성"이다.
- 우선순위:
  1. 런타임 안정성 (`src/index.ts`, `src/session.ts`, `src/handlers/text.ts`)
  2. 경계 명확화 (channel/provider boundary)
  3. 타입/유틸 분리 (`src/types.ts`, `src/utils.ts`)

## 2) AS-IS Directory Target (Current Reality)

```text
src/
  index.ts
  config.ts
  model-config.ts
  session.ts
  session-manager.ts
  scheduler.ts
  types.ts
  utils.ts
  formatting.ts
  security.ts
  usage.ts
  message-queue.ts
  handlers/
  core/session/
  channels/
  adapters/
    telegram/
    slack/
  providers/
  routing/
  scheduler/
  services/
  storage/
  stores/
  constants/
```

### AS-IS 문제 요약

- 루트 레벨 파일(`index.ts`, `session.ts`, `scheduler.ts`) 책임이 과도하게 크다.
- `src/session.ts` 중심 구조와 `src/core/session/*`, `src/providers/*`, `src/channels/*` 추출 구조가 병행되어 경계가 불명확하다.
- 핸들러(`src/handlers/text.ts`)가 채널 경계/세션 제어/사용자 UX/에러 처리까지 동시에 담당한다.
- 공통 타입/유틸(`src/types.ts`, `src/utils.ts`)이 집약되어 변경 영향 범위가 크다.

## 3) TO-BE Directory Target (Refactor Goal)

```text
src/
  app/                        # 런타임 조립(부트스트랩/등록/시작)
    bootstrap.ts
    telegram-bot.ts
    scheduler-runner.ts
  config/                     # 환경변수/모델 설정
    index.ts
    model.ts
  core/
    session/                  # 상태 머신, 선택 흐름, 쿼리 실행
      state-machine.ts
      choice-flow.ts
      steering-manager.ts
      query-runtime.ts
      session.ts
      session-manager.ts
    routing/
      session-key.ts
      resolve-route.ts
  channels/
    boundary/
      types.ts
    outbound/
      orchestrator.ts
  adapters/
    telegram/
      channel-boundary.ts
      outbound-port.ts
    slack/
      channel-boundary.ts
  providers/
    orchestrator.ts
    registry.ts
    anthropic-adapter.ts
    codex-adapter.ts
  handlers/                   # 얇은 입력 어댑터
    commands.ts
    text.ts
    voice.ts
    photo.ts
    document.ts
    callback.ts
  scheduler/                  # 스케줄링 도메인
    service.ts
    route.ts
    runtime-boundary.ts
  services/
  storage/
  types/
    runtime.ts
    external.ts
  utils/
    audit.ts
    typing.ts
    error.ts
```

### TO-BE 원칙

- `app`은 wiring만, `core`는 비즈니스 상태 전이만 담당한다.
- `handlers`는 input-normalize + route 호출만 수행한다.
- `providers`는 SDK 의존성을 내부에 가둔다.
- 루트 단일 파일 의존성을 줄이고 디렉토리 기반 책임 단위로 이동한다.

## 4) Major Files and Refactoring Goals

| File | Current Risk | Refactoring Goal | Done Criteria |
| --- | --- | --- | --- |
| `src/index.ts` | 초기화/등록/스케줄러/종료 훅이 한 파일에 집중 | `app/bootstrap` + `app/telegram-bot`로 분리 | 엔트리 파일 150라인 이하, 부트스트랩/등록 테스트 분리 |
| `src/session.ts` | 세션 상태, 스트리밍, 훅, SDK 호출이 결합 | `core/session/query-runtime.ts`와 `core/session/session.ts`로 책임 분리 | SDK 호출 경로가 query-runtime 단일 모듈로 수렴 |
| `src/session-manager.ts` | 세션 생성 + 파일 스토리지 + 작업 디렉토리 관리 결합 | 세션 수명주기와 영속화 경계를 분리 (`session-manager` vs `session-store`) | 세션 매니저 단위 테스트에서 파일 I/O mocking 단순화 |
| `src/handlers/text.ts` | 900+ 라인급 핸들러, 입력/상태/응답 흐름 혼재 | `text.ts`를 오케스트레이션 전용으로 축소, direct-input/interrupt 처리 분리 | 텍스트 핸들러의 핵심 함수 길이 100라인 이하 |
| `src/handlers/commands.ts` | 명령 핸들러가 하나의 거대 모듈 | 명령별 서브모듈 또는 registry 기반 분리 | 신규 커맨드 추가 시 파일 1개만 수정 |
| `src/core/session/state-machine.ts` | 상태 전이는 존재하나 규칙 선언이 분산 | 전이 규칙표와 불변식 검증 함수 추가 | 허용되지 않은 전이는 테스트에서 즉시 실패 |
| `src/core/session/choice-flow.ts` | 선택 흐름 규칙이 핸들러와 상호결합 | choice 상태 전이를 core에 고정하고 핸들러는 입출력만 담당 | callback/direct-input 경로가 동일 transition API 사용 |
| `src/providers/orchestrator.ts` | fallback/retry 정책이 하드코딩 | provider별 정책 설정을 config로 분리 | 정책 변경이 코드 수정 없이 설정으로 가능 |
| `src/providers/create-orchestrator.ts` | provider wiring 위치가 임시 구성 | `app` 레이어에서 orchestrator 조립 | 테스트에서 mock provider 삽입 경로 명확 |
| `src/adapters/telegram/channel-boundary.ts` | 인가/레이트리밋/정규화가 단일 클래스에 집중 | 인증/레이트리밋을 분리 가능한 전략으로 분해 | 채널 바운더리 테스트에서 정책 모듈 독립 검증 |
| `src/channels/outbound-orchestrator.ts` | payload normalize와 dispatch가 결합 | normalize 전략을 분리하고 orchestrator는 dispatch만 수행 | choice/status 텍스트 변환 테스트가 독립 모듈로 이동 |
| `src/scheduler.ts` | 큐/락/파일 watcher/실행이 단일 파일 | `scheduler/service.ts` 중심으로 실행·큐·watcher 분리 | 큐 처리 단위 테스트 추가, 런타임 경계 의존성 주입 |
| `src/config.ts` | 환경 파싱과 정책/메시지 설정 결합 | 설정 스키마 모듈화 (`config/index.ts`, `config/model.ts`) | 설정 변경 영향이 한 모듈로 제한 |
| `src/types.ts` | 광범위 공용 타입 집중 | `types/runtime.ts`, `types/external.ts`로 분해 | import cycle 없이 타입 의존 방향 단순화 |
| `src/utils.ts` | 감사로그/타이핑/전사 등 다기능 집합 | 용도별 유틸 파일로 분리 | 핸들러가 `utils.ts` wildcard 의존을 제거 |

## 5) Migration Phases

### Phase A: Stabilize Runtime Boundary

1. `src/index.ts` 책임 분해 (`app` 디렉토리 도입)
2. `src/session.ts`에서 SDK 실행 경로를 별도 모듈로 추출
3. `src/handlers/text.ts`를 interrupt/direct-input/normal flow로 분할

### Phase B: Normalize Boundaries

1. provider orchestrator 조립 지점을 `app`으로 이동
2. telegram/slack boundary 계약 테스트 보강
3. outbound normalize 로직 분리

### Phase C: Type and Utility Debt Cleanup

1. `types.ts` 분해
2. `utils.ts` 분해
3. `scheduler.ts` 서비스화

### Phase D: Cleanup and Cutover

1. 구 경로 import 제거 및 dead file 삭제
2. e2e + handler + contract 테스트 전체 재실행
3. 문서(`docs/plans/*`)를 최종 구조 기준으로 갱신

## 6) Quality Gates

- `make lint`
- `make test`
- `bun run typecheck`
- 경계 회귀 테스트:
  - `src/adapters/telegram/channel-boundary.test.ts`
  - `src/channels/outbound-orchestrator.test.ts`
  - `src/session-manager.contract.test.ts`
  - `src/e2e/v3-runtime.e2e.test.ts`

## 7) Legacy Refactor Docs Policy

- 기존 v3 리팩토링 문서는 `docs/archive/refactor-reset-2026-02-09/`로 이관한다.
- 신규 기준 문서는 본 문서 1개(`docs/plans/2026-02-09-refactor-reset-plan.md`)를 단일 진실원천(SSOT)으로 사용한다.
