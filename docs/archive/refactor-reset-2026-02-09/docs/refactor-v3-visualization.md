# SOMA Refactor v3 - Master Visualization

이 문서는 v3 리팩토링의 전체 실행 계획을 다이어그램으로 한 번에 볼 수 있도록 정리한 시각화 문서다.

## 1) Master Plan (Scope + Execution)

```mermaid
flowchart TB
  A["ADR Decision Freeze (55/55)"] --> B["E1 Core Contracts\n(tenant/channel/thread + route + provider port)"]

  B --> C1["E2 Domain/Session Core Extraction"]
  B --> C2["E3 Provider Boundary\n(Claude+Codex)"]
  B --> C3["E4 Telegram Boundary"]
  B --> C4["E5 Slack Skeleton + Tenant Boundary"]
  B --> C5["E6 Storage/Scheduler Partition"]

  C2 --> D["E7 Outbound Orchestrator + Unified OutputPort"]
  C3 --> D
  C4 --> D

  C1 --> E["E8 Full Test Rewrite + Quality Gates"]
  C2 --> E
  C3 --> E
  C4 --> E
  C5 --> E
  D --> E

  E --> F["E9 Cutover Cleanup + Legacy Deprecation"]

  X["Optional Track X\nOpenClaw Compatibility"] -. non-blocking .-> B
  X -. non-blocking .-> F
```

## 2) Target Runtime Architecture (To-Be)

```mermaid
flowchart LR
  U["User(s)"] --> CH["Channel Boundary (Abstraction A)"]
  CH --> MW["Inbound Middleware\n(auth, rate-limit, normalize)"]
  MW --> RR["Route Resolver\nresolveAgentRoute"]
  RR --> CQ["Core Query Orchestrator"]
  CQ --> PB["Provider Boundary (Abstraction B)"]
  PB --> CL["Claude Adapter"]
  PB --> CX["Codex Adapter"]

  CQ --> OB["Outbound Orchestrator\ndeliverOutboundPayloads"]
  OB --> CH

  CH --> TG["Telegram Adapter"]
  CH --> SL["Slack Adapter (minimum)"]
```

## 3) Team Parallelization Plan

```mermaid
flowchart LR
  PRE["Common Prerequisite\nE1 Core Contracts"]

  subgraph LA["Lane A"]
    A1["E3 Provider Boundary"]
  end

  subgraph LB["Lane B"]
    B1["E4 Telegram Boundary"]
  end

  subgraph LC["Lane C"]
    C1["E5 Slack Skeleton"]
  end

  subgraph LD["Lane D"]
    D1["E6 Storage/Scheduler"]
  end

  PRE --> A1
  PRE --> B1
  PRE --> C1
  PRE --> D1

  A1 --> INT["Integration\nE7 Outbound Orchestrator"]
  B1 --> INT
  C1 --> INT

  INT --> QA["E8 Test Rewrite + Gates\n(test + typecheck + lint)"]
  D1 --> QA
  QA --> CUT["E9 Cutover Cleanup"]
```

## 4) Migration Strategy (Big-Bang)

```mermaid
stateDiagram-v2
  [*] --> AsIs: Current Handler/Session-Centric Runtime
  AsIs --> ContractsLocked: Contract Skeleton (A/B/Route/Identity)
  ContractsLocked --> BoundariesImplemented: Provider + Channel Boundaries
  BoundariesImplemented --> OutboundCentralized: Unified Output Orchestration
  OutboundCentralized --> LegacyRemoved: Legacy Paths Deleted
  LegacyRemoved --> TestRebuilt: Full Test Rewrite (from zero)
  TestRebuilt --> Cutover: Big-Bang Cutover
  Cutover --> [*]
```

## 5) Legacy Plan Supersede Map

```mermaid
flowchart LR
  OLD1["Legacy Plan A\nsoma-zl7u.*"] --> NEW["v3 Execution Epics\nsoma-vbj.4 ~ soma-vbj.12"]
  OLD2["Legacy Plan B\nsoma-701o.*"] --> NEW
  NEW --> DONE["v3 Completion = Legacy Scope Auto-Resolved"]
```

## 6) Optional OpenClaw Separation Rule

```mermaid
flowchart TB
  CORE["Main v3 Execution Track\n(Required)"]
  OC["OpenClaw Compatibility Track\n(Optional / Deferred)"]

  CORE --> R1["No main milestone is blocked by OpenClaw"]
  OC --> R2["Can proceed independently when re-enabled"]
  CORE -. reference only .-> OC
```
