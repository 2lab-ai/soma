# Clarify Decision Docs

- 목적: v3 Decision Register 각 질문을 독립 문서로 관리하고, 선택지별 트레이드오프와 되돌리기 비용을 명시한다.
- 되돌리기 비용 카테고리: `10줄 미만`, `100줄 미만`, `300줄 미만`, `500줄 미만`, `그 이상`

| ID | 질문 | 최대 되돌리기 비용 | 문서 |
|---|---|---|---|
| A-01 | v3에서 채널 범위를 Telegram-only로 제한할지 | 그 이상 | [A-01.md](./A-01.md) |
| A-02 | 입력 공통 스키마 필드 최소치를 어디까지 둘지 | 300줄 미만 | [A-02.md](./A-02.md) |
| A-03 | thread를 optional로 둘지 first-class key로 올릴지 | 500줄 미만 | [A-03.md](./A-03.md) |
| A-04 | 순서 보장 기준을 message_id/timestamp/hybrid 중 무엇으로 할지 | 300줄 미만 | [A-04.md](./A-04.md) |
| A-05 | interrupt 우선순위를 절대 최우선으로 둘지 정책형으로 둘지 | 100줄 미만 | [A-05.md](./A-05.md) |
| A-06 | SystemOutput/ModelOutput를 분리할지 단일 포트로 합칠지 | 300줄 미만 | [A-06.md](./A-06.md) |
| A-07 | reaction/keyboard를 Abstraction A 계약에 포함할지 | 300줄 미만 | [A-07.md](./A-07.md) |
| A-08 | 첨부파일 전달을 fileId 지연 다운로드로 할지 즉시 변환할지 | 300줄 미만 | [A-08.md](./A-08.md) |
| A-09 | callback을 raw로 넘길지 도메인 command로 파싱해 넘길지 | 300줄 미만 | [A-09.md](./A-09.md) |
| A-10 | 스트리밍 API를 callback push로 할지 async iterator로 할지 | 300줄 미만 | [A-10.md](./A-10.md) |
| A-11 | rate-limit 책임을 inbound에 둘지 core policy에 둘지 | 300줄 미만 | [A-11.md](./A-11.md) |
| A-12 | auth 책임을 inbound-only로 할지 core 중복 검증까지 할지 | 300줄 미만 | [A-12.md](./A-12.md) |
| M-01 | 마이그레이션을 Strangler incremental로 갈지 Big-bang으로 갈지 | 그 이상 | [M-01.md](./M-01.md) |
| M-02 | 1차 타겟을 session/text/provider-port 중 어디로 둘지 | 300줄 미만 | [M-02.md](./M-02.md) |
| M-03 | PR 크기 제한을 얼마나 강하게 둘지 | 100줄 미만 | [M-03.md](./M-03.md) |
| M-04 | backward compatibility 기간을 둘지 즉시 전환할지 | 그 이상 | [M-04.md](./M-04.md) |
| M-05 | dead code 제거 시점을 마지막 일괄/단계별 즉시 중 어디로 둘지 | 300줄 미만 | [M-05.md](./M-05.md) |
| P-01 | v3에서 provider 범위를 어디까지 포함할지 | 그 이상 | [P-01.md](./P-01.md) |
| P-02 | 표준 이벤트 스키마를 최소/확장 중 어디까지 둘지 | 300줄 미만 | [P-02.md](./P-02.md) |
| P-03 | provider capability 계약을 단순 flag로 둘지 상세 계약으로 둘지 | 300줄 미만 | [P-03.md](./P-03.md) |
| P-04 | mid-stream injection을 optional로 둘지 필수로 강제할지 | 300줄 미만 | [P-04.md](./P-04.md) |
| P-05 | tool safety 책임을 core hook chain과 adapter 중 어디에 둘지 | 300줄 미만 | [P-05.md](./P-05.md) |
| P-06 | rate-limit fallback 위치를 core orchestrator로 올릴지 | 그 이상 | [P-06.md](./P-06.md) |
| P-07 | model selection 책임을 provider 밖 전략 서비스로 뺄지 | 300줄 미만 | [P-07.md](./P-07.md) |
| P-08 | session resume를 공통 contract로 고정할지 Claude 확장 필드를 둘지 | 300줄 미만 | [P-08.md](./P-08.md) |
| P-09 | usage telemetry를 raw 유지할지 normalized DTO로 강제할지 | 300줄 미만 | [P-09.md](./P-09.md) |
| P-10 | 오류 taxonomy를 2단계로 단순화할지 세분화할지 | 300줄 미만 | [P-10.md](./P-10.md) |
| P-11 | retry/backoff 정책을 core 고정으로 둘지 provider별로 둘지 | 300줄 미만 | [P-11.md](./P-11.md) |
| P-12 | permission mode 설정 위치를 adapter config와 core query policy 중 어디로 둘지 | 300줄 미만 | [P-12.md](./P-12.md) |
| S-01 | soma가 soul 파일을 직접 수정할 수 있는지 | 그 이상 | [S-01.md](./S-01.md) |
| S-02 | memory analyzer/updater의 소속 계층을 어디로 둘지 | 300줄 미만 | [S-02.md](./S-02.md) |
| S-03 | prompts/identity source of truth를 어디로 고정할지 | 그 이상 | [S-03.md](./S-03.md) |
| S-04 | conversation-reader 기본 경로 정책을 하드코딩 금지할지 | 100줄 미만 | [S-04.md](./S-04.md) |
| S-05 | restart/save context 파일 위치를 soma 내부만 둘지 공유할지 | 300줄 미만 | [S-05.md](./S-05.md) |
| S-06 | soul 관련 기능 보안 경계를 read-only 기본으로 둘지 | 500줄 미만 | [S-06.md](./S-06.md) |
| T-01 | 테스트 삭제 범위를 어디까지로 고정할지 | 그 이상 | [T-01.md](./T-01.md) |
| T-02 | 테스트 삭제/재작성 시점을 어떻게 운영할지 | 500줄 미만 | [T-02.md](./T-02.md) |
| T-03 | 테스트 러너를 유지할지 전환할지 | 500줄 미만 | [T-03.md](./T-03.md) |
| T-04 | Mock 정책을 수동으로 갈지 라이브러리로 갈지 | 300줄 미만 | [T-04.md](./T-04.md) |
| T-05 | 테스트 재작성 우선순서를 어디서 시작할지 | 300줄 미만 | [T-05.md](./T-05.md) |
| T-06 | 커버리지 목표를 어떤 형태로 둘지 | 100줄 미만 | [T-06.md](./T-06.md) |
| T-07 | E2E를 포함할지 범위를 어디까지 둘지 | 300줄 미만 | [T-07.md](./T-07.md) |
| T-08 | 회귀 기준을 golden 중심으로 갈지 unit 중심으로 갈지 | 300줄 미만 | [T-08.md](./T-08.md) |
| T-09 | flaky 허용 정책을 어떻게 둘지 | 100줄 미만 | [T-09.md](./T-09.md) |
| T-10 | CI gate를 어디까지 필수로 묶을지 | 100줄 미만 | [T-10.md](./T-10.md) |
