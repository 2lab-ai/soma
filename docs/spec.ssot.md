# Documentation SSOT Policy

Updated: 2026-02-10

## 1. Purpose

이 문서는 SOMA 문서의 Single Source of Truth(SSOT) 체계를 정의한다.  
기능/구조 변경 시 어떤 문서를 우선 갱신해야 하는지 기준을 고정한다.

## 2. Canonical Documents

### Primary Canonical Set

1. System spec (high-level):
   - `/Users/icedac/2lab.ai/soma/docs/spec.md`
2. Technical spec (detailed):
   - `/Users/icedac/2lab.ai/soma/docs/specs.md`
3. Architecture diagrams (source-accurate):
   - `/Users/icedac/2lab.ai/soma/docs/architecture/current-source-architecture.md`

### Support Canonical Set

1. Plans status pointer:
   - `/Users/icedac/2lab.ai/soma/docs/plans/README.md`
2. Refactor archive index:
   - `/Users/icedac/2lab.ai/soma/docs/archive/refactor-reset-2026-02-09/README.md`

## 3. Precedence Rules

1. 코드와 충돌할 때는 코드가 진실이다.
2. 문서 간 충돌 시 우선순위:
   - `specs.md` (구현 상세) > `spec.md` (요약) > 기타 가이드 문서
3. 리팩토링 과거 계획/실행 로그는 archive 문서로만 참조한다.

## 4. Update Policy

다음 변경이 발생하면 최소 아래 문서를 동기화해야 한다:

1. 채널 경계 변경 (Telegram/Slack):
   - `spec.md`, `specs.md`, `current-source-architecture.md`
2. 프로바이더/모델 전략 변경:
   - `spec.md`, `specs.md`
3. 런타임 플로우/세션/스케줄러 경계 변경:
   - `specs.md`, `current-source-architecture.md`
4. 문서 구조/경로 변경:
   - `docs/README.md`, `spec.ssot.md`

## 5. Documentation Lifecycle States

- `Current`: 운영 기준 문서 (active maintenance)
- `Reference`: 과거 결정/트랙 문서 (context only)
- `Archive`: 종료된 계획/초안/레거시 문서 (read-only)

## 6. Current Structure Snapshot

```text
docs/
├── architecture/
│   ├── current-source-architecture.md
│   └── refactor-executive-summary.md
├── guides/
│   └── personal-assistant-guide.md
├── operations/
│   ├── service-runbook.md
│   └── wsl-systemd-service-guide.md
├── reference/
│   ├── adr-v3-legacy.md
│   └── openclaw-compatibility-track.md
├── plans/
│   └── README.md
├── archive/
│   └── refactor-reset-2026-02-09/
├── tasks/save/
│   └── INDEX.md
├── spec.md
├── specs.md
└── spec.ssot.md
```
