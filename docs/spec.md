# SOMA System Specification (Current)

Updated: 2026-02-10  
Scope: `main` branch current runtime architecture

## 1. Purpose

SOMA is a Telegram-first AI agent runtime that:

- receives user input from chat channels,
- executes model queries through a provider boundary,
- streams tool/text/status output back to the channel,
- persists session and chat history for recovery and continuity.

## 2. Current Platform/Provider Scope

### Channels

| Channel | Status | Notes |
|---|---|---|
| Telegram | Active | Full inbound/outbound path, thread-aware, reactions/choices support |
| Slack | Skeleton (optional) | Contract-compatible boundary behind `SLACK_SKELETON_ENABLED=true` (`SLACK_ALLOWED_TENANTS` allowlist) |

### Providers

| Provider | Status | Notes |
|---|---|---|
| Anthropic (`ClaudeProviderAdapter`) | Active default | Primary runtime execution path |
| Codex (`CodexProviderAdapter`) | Integrated, opt-in | Adapter exists; enabled by `CODEX_PROVIDER_ENABLED=true` |

### Model Context Defaults

| Context | Model | Reasoning |
|---|---|---|
| `general` | Opus 4.6 | `high` |
| `summary` | Sonnet 4.5 | `minimal` |
| `cron` | Haiku 4.5 | `none` |

Source: `/Users/icedac/2lab.ai/soma/src/config/model.ts`

## 3. High-Level Architecture

```mermaid
flowchart LR
    U["User"] --> TG["Telegram"]
    TG --> BOT["Bot Runtime (grammY)"]
    BOT --> H["Handlers"]
    H --> CORE["Core Session Domain"]
    CORE --> PROV["Provider Orchestrator"]
    PROV --> CLA["Anthropic Adapter"]
    PROV --> COD["Codex Adapter"]
    CORE --> OUT["Channel Outbound Orchestrator"]
    OUT --> TB["Telegram Boundary"]
    BOT --> SCH["Scheduler Service"]
    SCH --> CORE
    CORE --> STORE["Session Store + Chat Storage"]
```

## 4. Runtime Request Flow

```mermaid
sequenceDiagram
    participant User as "User"
    participant Tg as "Telegram"
    participant Txt as "handlers/text.ts"
    participant Sm as "SessionManager"
    participant Cs as "ClaudeSession"
    participant Qr as "query-runtime"
    participant Or as "ProviderOrchestrator"
    participant Pa as "ProviderAdapter"

    User->>Tg: "Send text/voice/photo/document"
    Tg->>Txt: "Inbound event"
    Txt->>Sm: "getSession(chat, thread)"
    Sm-->>Txt: "Session instance"
    Txt->>Cs: "sendMessageStreaming(...)"
    Cs->>Qr: "executeQueryRuntime(...)"
    Qr->>Or: "executeProviderQuery(primary, fallback?)"
    Or->>Pa: "startQuery + streamEvents"
    Pa-->>Qr: "text/tool/usage/done events"
    Qr-->>Cs: "normalized result"
    Cs-->>Txt: "response metadata"
    Txt-->>Tg: "streamed updates + final output"
```

## 5. Boundary Contracts

- Channel boundary contract: `/Users/icedac/2lab.ai/soma/src/channels/plugins/types.core.ts`
- Session identity contract: `/Users/icedac/2lab.ai/soma/src/core/routing/session-key.ts`
- Provider boundary contract: `/Users/icedac/2lab.ai/soma/src/providers/types.models.ts`
- Scheduler runtime boundary: `/Users/icedac/2lab.ai/soma/src/scheduler/runtime-boundary.ts`

## 6. Security and Safety Controls

- User/group allowlist + mention policy: `/Users/icedac/2lab.ai/soma/src/security.ts`
- Rate limiting (token bucket): `/Users/icedac/2lab.ai/soma/src/security.ts`
- Path allowlist enforcement and command safety checks: `/Users/icedac/2lab.ai/soma/src/security.ts`
- Provider/tool/runtime guardrails are enforced in query runtime hooks.

## 7. Canonical Deep-Dive Docs

- Technical deep spec: `/Users/icedac/2lab.ai/soma/docs/specs.md`
- Architecture diagrams: `/Users/icedac/2lab.ai/soma/docs/architecture/current-source-architecture.md`
- Refactor executive summary: `/Users/icedac/2lab.ai/soma/docs/architecture/refactor-executive-summary.md`
- Documentation SSOT policy: `/Users/icedac/2lab.ai/soma/docs/spec.ssot.md`
- Operations runbook: `/Users/icedac/2lab.ai/soma/docs/operations/service-runbook.md`
