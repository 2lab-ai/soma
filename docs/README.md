# SOMA Documentation Index

Updated: 2026-02-10

## Canonical Start Points

1. High-level system spec:
   - `/Users/icedac/2lab.ai/soma/docs/spec.md`
2. Detailed technical spec:
   - `/Users/icedac/2lab.ai/soma/docs/specs.md`
3. Current architecture diagrams:
   - `/Users/icedac/2lab.ai/soma/docs/architecture/current-source-architecture.md`
4. Refactor executive summary (AS-IS vs TO-BE):
   - `/Users/icedac/2lab.ai/soma/docs/architecture/refactor-executive-summary.md`

## Operations

- Current runbook:
  - `/Users/icedac/2lab.ai/soma/docs/operations/service-runbook.md`
- WSL/systemd incident guide (legacy troubleshooting context):
  - `/Users/icedac/2lab.ai/soma/docs/operations/wsl-systemd-service-guide.md`

## Directory Map

```text
docs/
├── architecture/     # Current architecture diagrams + executive summary
├── guides/           # User-facing usage guides
├── operations/       # Deploy/test/runbook docs
├── reference/        # Legacy ADRs and deferred tracks
├── plans/            # Current planning pointer
├── archive/          # Historical frozen docs
├── tasks/save/       # Restart/session save artifacts
├── spec.md           # Canonical high-level spec
├── specs.md          # Canonical detailed spec
└── spec.ssot.md      # Documentation SSOT policy
```

## Current vs Historical

- Current source-accurate docs:
  - `spec.md`, `specs.md`, `architecture/current-source-architecture.md`
- Historical refactor decisions/plans:
  - `/Users/icedac/2lab.ai/soma/docs/archive/refactor-reset-2026-02-09/`
  - `/Users/icedac/2lab.ai/soma/docs/reference/`

## Maintenance Rule

- When code and docs conflict, code is authoritative.
- Update scope guidance is defined in:
  - `/Users/icedac/2lab.ai/soma/docs/spec.ssot.md`
