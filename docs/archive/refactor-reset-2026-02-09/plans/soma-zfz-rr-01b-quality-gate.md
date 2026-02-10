# Task RR-01B: Stabilize Quality Gate Command Contract

## Objective
`soma-zfz` 리팩토링 전제인 baseline safety net이 항상 실행 가능하도록 테스트 게이트 계약을 고정한다.

## Problem
- 현재 `make test`가 쉘 조건식 문제로 신뢰할 수 없는 결과를 출력한다.
- `bun test`는 환경 변수(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`) 없으면 즉시 실패한다.
- 이 상태에서는 RR-01 이후 각 단계의 품질 게이트 판단이 흔들린다.

## Scope
- `make test` 동작 계약 보정(실제 테스트 실행 여부 판별 로직 수정)
- 로컬/CI 공통 테스트 실행 환경 변수 계약 명시
- 리팩토링 계획 문서와 실행 로그 템플릿에 검증 커맨드 반영

## Command Contract
- `make test`:
  - 테스트 파일 존재 여부는 `find src -type f -name "*.test.ts" -print -quit`로 판별한다.
  - 테스트 실행 시 아래 기본값을 자동 주입한다.
    - `TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-dummy}`
    - `TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-1}`
- 직접 실행 기준:
  - `TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 bun test`

## Acceptance Criteria
- 기본 개발 환경에서 테스트 명령이 오탐 없이 실행된다.
- 테스트 실행 환경 변수 계약이 문서화되어 있다.
- RR-01 및 RR-15가 동일한 테스트 게이트 커맨드를 사용한다.
