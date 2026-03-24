# SOMA Documentation Index

Updated: 2026-03-25

## Canonical Start Points

1. High-level system spec: `docs/spec.md`
2. Detailed technical spec: `docs/specs.md`
3. Architecture diagrams: `docs/architecture/current-source-architecture.md`
4. Refactor executive summary: `docs/architecture/refactor-executive-summary.md`

## Operations

- Current runbook: `docs/operations/service-runbook.md`
- WSL/systemd incident guide: `docs/operations/wsl-systemd-service-guide.md`

## Directory Map

```text
docs/
├── architecture/          # Architecture diagrams + executive summary
├── debugging/             # Debug traces for specific incidents
├── fix-reentry-guard-v2/  # Reentry guard fix spec + trace
├── fix-stuck-reentry-guard/ # Stuck reentry guard fix spec + trace
├── guides/                # User-facing usage guides
├── operations/            # Deploy/test/runbook docs
├── reference/             # Legacy ADRs and deferred tracks
├── archive/               # Historical frozen docs
├── spec.md                # Canonical high-level spec
├── specs.md               # Canonical detailed spec
└── spec.ssot.md           # Documentation SSOT policy
```

## Maintenance Rule

- When code and docs conflict, code is authoritative.
- Update scope guidance: `docs/spec.ssot.md`
