# SOMA Refactoring Reset Plan (2026-02-09, Reviewed 2026-02-10)

> **For Claude:** REQUIRED SUB-SKILL: Use `new-task` workflow and execute this plan task-by-task.

**Goal:** 혼재된 리팩토링 상태를 정리해 `session` 중심 실행 경로를 명확한 계층 구조로 재배치하고, 동작 회귀 없이 점진 마이그레이션한다.

**Architecture:** runtime wiring / handler input boundary / core session lifecycle / provider boundary / channel boundary를 분리한다.

**Tech Stack:** TypeScript, Bun, grammY, Claude Agent SDK, bd tracker

## 0) 2026-02-10 Review Snapshot

### Verified current baseline

- 주요 파일 크기
  - `src/index.ts`: 514 lines
  - `src/session.ts`: 1376 lines
  - `src/handlers/text.ts`: 985 lines
  - `src/handlers/commands.ts`: 863 lines
  - `src/scheduler.ts`: 397 lines
- 품질 게이트 현황
  - `bun run typecheck`: pass
  - `make lint`: pass (warnings only)
  - `make test`: command bug (`/bin/sh: line 0: [: too many arguments`)
  - `bun test`: env 필요 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`)

### Gaps fixed by this update

1. 품질 게이트 계약(`make test`)이 현재 기준선 검증에 부적합
2. `RR-08 (soma-zfz.9)`는 app wiring 전제(`RR-02`)에 직접 의존해야 함
3. RR 태스크 설명은 충분히 상세하지만 실행 단위를 1시간 체크포인트로 더 잘게 관리할 필요가 있음
4. 경로 목표를 "최종 구조"와 "중간 호환 shim 구조"로 분리해 문서화할 필요가 있음

## 1) Scope and Rules

- 이 문서는 `soma-zfz` 에픽의 단일 기준 계획(SSOT)이다.
- 목표는 재작성이 아니라 동작 보존 기반 점진 리팩토링이다.
- 모든 RR 태스크는 **1시간 단위 execution slice**로 진행하고, 슬라이스 종료 시 테스트를 남긴다.
- 호환 shim(`src/*.ts` root entry)은 RR-14 전까지 유지하고, RR-14에서만 제거한다.
- 한 RR에서 실패하면 다음 RR로 넘어가지 않는다.

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
  handlers/
  core/session/
  adapters/
    telegram/
    slack/
  channels/
  providers/
  routing/
  scheduler/
  services/
  storage/
  stores/
  constants/
```

### AS-IS issues

- 루트 레벨 대형 파일(`index.ts`, `session.ts`, `scheduler.ts`)에 책임 집중
- `session.ts` 중심 구조와 추출된 `core/session/*` 구조가 병행되어 경계 혼재
- `handlers/text.ts`가 inbound filtering, UX, session control, error mapping을 동시에 담당
- `types.ts`, `utils.ts`의 변경 영향 범위가 과도함

## 3) TO-BE Directory Target (Final + Transitional)

```text
src/
  app/
    bootstrap.ts
    telegram-bot.ts
    scheduler-runner.ts
  config/
    index.ts
    env.ts
    model.ts
    safety-prompt.ts
  core/
    session/
      state-machine.ts
      choice-flow.ts
      steering-manager.ts
      query-runtime.ts
      session.ts
      session-manager.ts
      session-store.ts
    routing/
      session-key.ts
      resolve-route.ts
  adapters/
    telegram/
      channel-boundary.ts
      auth-policy.ts
      rate-limit-policy.ts
      order-policy.ts
      outbound-port.ts
    slack/
      channel-boundary.ts
  channels/
    plugins/
      types.core.ts
    outbound/
      normalize-payload.ts
      render-choice.ts
    outbound-orchestrator.ts   # RR-14 전까지 compatibility 유지 가능
  providers/
    orchestrator.ts
    retry-policy.ts
    create-orchestrator.ts
    registry.ts
    claude-adapter.ts
    codex-adapter.ts
  scheduler/
    service.ts
    queue.ts
    file-watcher.ts
    route.ts
    runtime-boundary.ts
  handlers/
    text/
      direct-input-flow.ts
      interrupt-flow.ts
      query-flow.ts
      inbound-guard.ts
    commands/
      session-commands.ts
      system-commands.ts
      usage-commands.ts
      formatters.ts
      index.ts
  types/
    runtime.ts
    session.ts
    provider.ts
    audit.ts
  utils/
    audit.ts
    typing.ts
    voice.ts
    interrupt.ts
```

## 4) Architecture Decisions (Oracle-equivalent review result)

1. **Compatibility shim policy**
   - Option A: early-delete root files
   - Option B: keep shim until cutover
   - **Decision: B (recommended)**
   - Reason: 현재 회귀 리스크가 큰 구조에서 롤백 비용을 최소화함

2. **Routing contract placement**
   - Option A: keep `src/routing/*` permanently
   - Option B: move to `src/core/routing/*` and keep re-export shim
   - **Decision: B (recommended)**
   - Reason: session identity는 core invariant이며 channel adapter 계층 밖에 두는 것이 맞음

3. **Provider execution path**
   - Option A: `ClaudeSession` direct SDK call 유지
   - Option B: runtime path를 `ProviderOrchestrator.executeProviderQuery()`로 단일화
   - **Decision: B (recommended)**
   - Reason: fallback/retry 정책 일관성과 테스트 가능성 확보

4. **Quality gate contract**
   - Option A: `make test` 유지 (현재 상태)
   - Option B: RR-01 단계에서 테스트 실행 계약을 고정
   - **Decision: B (recommended)**
   - Reason: baseline safety net 자체가 실행 불가능하면 이후 RR 검증이 무의미함

## 5) Feature Workstreams

- Runtime bootstrap 분리 (`index.ts` -> `app/*`)
- Config/module boundary 분리 (`config.ts`, `model-config.ts`)
- Routing/session identity core 이전
- Session query runtime 분리
- `ClaudeSession` class core 이동
- Session lifecycle/persistence 분리
- Text handler flow 분해
- Commands handler 분해
- Provider policy/wiring 외부화
- Telegram/Slack channel policy 분해
- Outbound normalize 분리
- Scheduler service/queue/watcher 분리
- Shared types 분해
- Shared utils 분해
- Import cutover + dead compatibility 제거 + full verification

## 6) Revised RR Task Tree (with 1h execution slices)

### Setup + Phase A

1. `soma-zfz.1` RR-00 (1h)
   - Slice A: `codex/` 브랜치/워크트리 분리
   - Slice B: baseline SHA/branch 기록
2. `soma-zfz.19` RR-01B (1h, new)
   - Slice A: `make test` 실행 계약 보정 계획 확정
   - Slice B: baseline test command 입력값/환경 변수 기준 문서화
3. `soma-zfz.2` RR-01 (1-2h)
   - Slice A: 리그레션 테스트 추가
   - Slice B: state/session contract 경계 테스트 보강
4. `soma-zfz.3` RR-02 (1-2h)
   - Slice A: `app/telegram-bot.ts` 추출
   - Slice B: `app/bootstrap.ts` + `app/scheduler-runner.ts` 추출
5. `soma-zfz.4` RR-03 (1-2h)
   - Slice A: `config/env.ts`, `config/safety-prompt.ts` 분리
   - Slice B: `config/index.ts`, `config/model.ts`로 import 정리
6. `soma-zfz.17` RR-03B (1h)
   - Slice A: `routing/*` -> `core/routing/*` 이동 + shim 유지
7. `soma-zfz.5` RR-04 (1-2h)
   - Slice A: `query-runtime.ts` 생성
   - Slice B: `sendMessageStreaming()` orchestration-only로 축소
8. `soma-zfz.18` RR-04B (1h)
   - Slice A: `ClaudeSession` core 이동 + compatibility export
9. `soma-zfz.6` RR-05 (1-2h)
   - Slice A: `session-store.ts` 분리
   - Slice B: manager lifecycle + persistence 경계 분리
10. `soma-zfz.7` RR-06 (1-2h)
    - Slice A: direct-input/interrupt flow 분리
    - Slice B: `handleText()` thin orchestrator화
11. `soma-zfz.8` RR-07 (1-2h)
    - Slice A: command group 모듈 분리
    - Slice B: export compatibility 유지

### Phase B + C + D

12. `soma-zfz.9` RR-08 (1h)
    - Slice A: retry policy 외부화 + app wiring 경유 실행 경로 확정
13. `soma-zfz.10` RR-09 (1h)
    - Slice A: telegram boundary policy 모듈 분리 + slack parity 맞춤
14. `soma-zfz.11` RR-10 (1h)
    - Slice A: outbound normalize/render 모듈 분리
15. `soma-zfz.12` RR-11 (1-2h)
    - Slice A: scheduler service/queue 분리
    - Slice B: file-watcher 분리 + runtime-boundary 정리
16. `soma-zfz.13` RR-12 (1h)
    - Slice A: types 분해 + barrel compatibility 유지
17. `soma-zfz.14` RR-13 (1h)
    - Slice A: utils 분해 + wildcard import 제거
18. `soma-zfz.15` RR-14 (1-2h)
    - Slice A: import cutover
    - Slice B: compatibility 삭제 + dead files 정리
19. `soma-zfz.16` RR-15 (1h)
    - Slice A: 전체 품질 게이트 + handoff log 작성

## 7) Dependency Corrections Applied

- `RR-01B (soma-zfz.19)` 추가
  - blocked by: `soma-zfz.1`
  - blocks: `soma-zfz.2`, `soma-zfz.16`
- `RR-08 (soma-zfz.9)`는 `RR-02 (soma-zfz.3)`에 직접 의존하도록 수정

## 8) Quality Gates (updated execution contract)

- `make lint`
- `bun run typecheck`
- `make test` (must execute `bun test` when `src/**/*.test.ts` exists)
- `TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 bun test`
- critical regression tests
  - `bun test src/e2e/v3-runtime.e2e.test.ts`
  - `bun test src/session-manager.contract.test.ts`
  - `bun test src/adapters/telegram/channel-boundary.test.ts`
  - `bun test src/channels/outbound-orchestrator.test.ts`

### Test env contract

- Required runtime env for tests:
  - `TELEGRAM_BOT_TOKEN` (use `dummy` in local/CI when not calling real Telegram)
  - `TELEGRAM_ALLOWED_USERS` (use `1` for local/CI baseline)
- `make test` must provide deterministic defaults:
  - `TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-dummy}`
  - `TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-1}`
- RR-01 baseline, per-task slice checks, and RR-15 final validation must all use this same contract.

## 9) Legacy Refactor Docs Policy

- 기존 v3 리팩토링 문서는 `docs/archive/refactor-reset-2026-02-09/`로 이관 유지
- 본 문서(`docs/archive/refactor-reset-2026-02-09/plans/2026-02-09-refactor-reset-plan.md`)를 `soma-zfz` 실행 기준 SSOT로 유지
