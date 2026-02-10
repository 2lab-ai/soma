# SOMA Current Source Architecture (2026-02-10)

기준: `main` branch, refactor-reset(`soma-zfz`) 반영 이후 구조.

## 1) System Context

```mermaid
flowchart LR
    U["User"] --> T["Telegram"]
    T --> B["Bot Runtime"]
    B --> H["Handlers"]
    H --> C["Core Session Domain"]
    C --> P["Provider Orchestrator"]
    P --> A["Claude Adapter"]
    P --> X["Codex Adapter"]
    C --> O["Channel Outbound Orchestrator"]
    O --> TB["Telegram Boundary"]
    C --> S["Session Store"]
    C --> CH["Chat Capture Service"]
    CH --> ST["Partitioned Chat Storage"]
    B --> SC["Scheduler Service"]
    SC --> C
```

## 2) Layered Boundary View

```mermaid
flowchart TB
    subgraph APP["App Composition Layer (`src/app/*`)"]
        I["index.ts"]
        BOOT["bootstrap.ts"]
        TGB["telegram-bot.ts"]
        SR["scheduler-runner.ts"]
    end

    subgraph INBOUND["Inbound Interface Layer (`src/handlers/*`, `src/adapters/*`)"]
        HT["handleText orchestrator"]
        HF["text flow modules"]
        CB["TelegramChannelBoundary"]
    end

    subgraph CORE["Core Domain Layer (`src/core/*`)"]
        SM["SessionManager"]
        CS["ClaudeSession"]
        QR["query-runtime"]
        ROUTE["session-key / route contracts"]
    end

    subgraph PROVIDER["Provider Layer (`src/providers/*`)"]
        ORCH["ProviderOrchestrator"]
        CAD["ClaudeProviderAdapter"]
        COD["CodexProviderAdapter"]
    end

    subgraph SCHED["Scheduler Layer (`src/scheduler/*`)"]
        SVC["SchedulerService"]
        RB["runtime-boundary"]
        SQ["queue"]
        FW["file-watcher"]
    end

    subgraph DATA["Data / Utility Layer"]
        SS["FileSessionStore"]
        CCS["ChatCaptureService"]
        FS["FileChatStorage"]
        U["utils/* + types/*"]
    end

    APP --> INBOUND
    APP --> SCHED
    INBOUND --> CORE
    CORE --> PROVIDER
    CORE --> DATA
    SCHED --> CORE
```

## 3) Text Message Runtime Sequence

```mermaid
sequenceDiagram
    participant User as "User"
    participant TG as "Telegram"
    participant HT as "handlers/text.ts"
    participant IF as "text flow modules"
    participant SM as "SessionManager"
    participant CS as "ClaudeSession"
    participant QR as "query-runtime"
    participant PO as "ProviderOrchestrator"
    participant AD as "ProviderAdapter"
    participant OUT as "ChannelOutboundOrchestrator"
    participant TB as "TelegramBoundary"

    User->>TG: "message"
    TG->>HT: "message:text event"
    HT->>IF: "runInboundGuard + interrupt/direct-input/query flow"
    IF->>SM: "getSession(chatId, threadId)"
    SM-->>IF: "ClaudeSession"
    IF->>CS: "sendMessageStreaming(prompt)"
    CS->>QR: "executeQueryRuntime(...)"
    QR->>PO: "executeProviderQuery(primary, fallback)"
    PO->>AD: "startQuery + streamEvents"
    AD-->>QR: "text/tool/usage events"
    QR-->>CS: "normalized result + usage"
    CS-->>IF: "response"
    IF->>OUT: "send status/text/reaction"
    OUT->>TB: "deliverOutbound(normalized payload)"
    TB-->>TG: "send/edit/reaction"
    TG-->>User: "final response"
```

## 4) Provider Fallback State

```mermaid
stateDiagram-v2
    [*] --> PrimaryAttempt
    PrimaryAttempt --> PrimarySuccess: "stream completed"
    PrimaryAttempt --> RetryPrimary: "retryable error"
    RetryPrimary --> PrimaryAttempt: "backoff elapsed"
    PrimaryAttempt --> FallbackAttempt: "rate-limit with fallback configured"
    RetryPrimary --> FallbackAttempt: "retry budget exhausted + fallback condition"
    FallbackAttempt --> FallbackSuccess: "stream completed"
    FallbackAttempt --> Failed: "non-retryable or fallback exhausted"
    PrimaryAttempt --> Failed: "non-retryable error"
    PrimarySuccess --> [*]
    FallbackSuccess --> [*]
    Failed --> [*]
```

## 5) Scheduler Execution Path

```mermaid
flowchart TD
    C["cron.yaml"] --> SV["SchedulerService.loadCronConfig"]
    SV --> CJ["Cron jobs registered"]
    CJ --> TR["Job trigger"]
    TR --> RL["Rate-limit check"]
    RL -->|pass| Q["Queue job"]
    RL -->|fail| SK["Skip / defer"]
    Q --> DR["Queue drain timer"]
    DR --> RB["Scheduler runtime-boundary.execute"]
    RB --> SM["SessionManager.getSession(userId)"]
    SM --> CS["ClaudeSession.sendMessageStreaming(prompt, cron context)"]
    CS --> RES["Result/status callback"]
```

## 6) Persistence and Partition Model

```mermaid
flowchart LR
    SID["Session Identity: tenant:channel:thread"] --> SK["Session Key"]
    SID --> PK["Storage Partition Key: tenant/channel/thread"]

    SK --> SF["Session JSON files (`/tmp/soma-sessions/*`)"]
    PK --> ND["Daily NDJSON (`.db/chat-history/chats/<partition>/YYYY-MM-DD.ndjson`)"]
    SK --> REF["sessions.ndjson references"]
```

## 7) Current Directory Ownership

- `src/app/*`
  - 프로세스 부팅, bot wiring, scheduler wiring.
- `src/handlers/*`
  - Telegram inbound 이벤트 처리 orchestration.
- `src/core/session/*`
  - 세션 상태머신, 질의 실행, 세션 라이프사이클.
- `src/core/routing/*`
  - 세션/스토리지 키 규약(tenant:channel:thread).
- `src/providers/*`
  - 모델 어댑터 및 retry/fallback orchestrator.
- `src/adapters/*`, `src/channels/*`
  - 채널 boundary 정책과 outbound payload dispatch/normalize.
- `src/scheduler/*`
  - cron 로드, 큐/워처/실행 orchestration.
- `src/storage/*`, `src/services/*`
  - chat/summary 저장 및 캡처/검색 서비스.
- `src/types/*`, `src/utils/*`
  - 도메인별 타입과 유틸리티 분리.

## 8) Compatibility Notes

- 삭제 완료된 legacy root modules:
  - `src/config.ts`
  - `src/model-config.ts`
  - `src/session.ts`
  - `src/session-manager.ts`
  - `src/scheduler.ts`
  - `src/utils.ts`
- 유지 중인 compatibility exports:
  - `src/routing/session-key.ts` -> `src/core/routing/session-key.ts`
  - `src/routing/resolve-route.ts` -> `src/core/routing/resolve-route.ts`
  - `src/types.ts` -> `src/types/*` barrel export

## 9) Entry Points

- Application boot: `src/index.ts` -> `src/app/bootstrap.ts`
- Text runtime path: `src/handlers/text.ts` -> `src/handlers/text/query-flow.ts` -> `src/core/session/session.ts` -> `src/core/session/query-runtime.ts`
- Scheduler runtime path: `src/app/scheduler-runner.ts` -> `src/scheduler/service.ts` -> `src/scheduler/runtime-boundary.ts` -> `src/core/session/session-manager.ts`
