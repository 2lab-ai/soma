# Refactor Reset Epic: Runtime/Core Boundary Consolidation

## Objective
Drive the AS-IS -> TO-BE refactor from `docs/plans/2026-02-09-refactor-reset-plan.md` with deterministic order, 1h execution slices, and behavior-preserving migration.

## Source of Truth
- `docs/plans/2026-02-09-refactor-reset-plan.md`

## Final Architecture Target
- Move runtime wiring to `src/app/*`
- Move session domain to `src/core/session/*`
- Move route and identity contracts to `src/core/routing/*`
- Keep provider SDK details isolated in `src/providers/*`
- Keep channel boundary and outbound normalization isolated in `src/channels/*` and `src/adapters/*`
- Remove broad root modules only after cutover (`src/session.ts`, `src/session-manager.ts`, `src/scheduler.ts`, `src/config.ts`, `src/types.ts`, `src/utils.ts`)

## Execution Rules
1. Keep behavior stable at each task boundary; no big-bang rewrite.
2. Every RR task must be executed in <=1h slices with test evidence.
3. Keep temporary compatibility exports while consumers are migrated.
4. Run quality gates at the end of every phase.
5. Do not delete legacy files until all imports are cut over and verified.

## Ordered Workstream
1. `soma-zfz.1` RR-00: Create dedicated refactor branch/worktree
2. `soma-zfz.19` RR-01B: Stabilize quality gate command contract
3. `soma-zfz.2` RR-01: Build baseline safety net for refactor
4. `soma-zfz.3` RR-02: Extract runtime wiring from index.ts into app modules
5. `soma-zfz.4` RR-03: Split config into focused modules
6. `soma-zfz.17` RR-03B: Migrate routing contracts from `src/routing/*` to `src/core/routing/*`
7. `soma-zfz.5` RR-04: Extract query runtime from session.ts
8. `soma-zfz.18` RR-04B: Move ClaudeSession class to `src/core/session/session.ts`
9. `soma-zfz.6` RR-05: Separate session lifecycle and persistence boundaries
10. `soma-zfz.7` RR-06: Decompose handlers/text.ts into flow modules
11. `soma-zfz.8` RR-07: Decompose handlers/commands.ts into command modules
12. `soma-zfz.9` RR-08: Externalize provider policy and app-level wiring
13. `soma-zfz.10` RR-09: Split Telegram boundary policies and Slack parity
14. `soma-zfz.11` RR-10: Split outbound payload normalization from dispatch
15. `soma-zfz.12` RR-11: Extract scheduler domain service from scheduler.ts
16. `soma-zfz.13` RR-12: Split shared types.ts into focused type modules
17. `soma-zfz.14` RR-13: Split utils.ts into focused utility modules
18. `soma-zfz.15` RR-14: Cut over imports and remove dead compatibility layers
19. `soma-zfz.16` RR-15: Run full quality gates and write handoff log

## Dependency Highlights
- Main chain:
  - `soma-zfz.1 -> soma-zfz.19 -> soma-zfz.2 -> soma-zfz.3 -> soma-zfz.4 -> soma-zfz.17 -> soma-zfz.5 -> soma-zfz.18 -> soma-zfz.6 -> soma-zfz.7 -> soma-zfz.8 -> soma-zfz.15 -> soma-zfz.16`
- Boundary branch:
  - `soma-zfz.3 + soma-zfz.4 + soma-zfz.18 -> soma-zfz.9 -> soma-zfz.10 -> soma-zfz.11 -> soma-zfz.15`
- Scheduler/types/utils branch:
  - `soma-zfz.3 + soma-zfz.4 -> soma-zfz.12`
  - `soma-zfz.4 -> soma-zfz.13 -> soma-zfz.14 -> soma-zfz.15`

## Acceptance Criteria
- Epic child tasks contain file-level and function-level instructions.
- Dependency graph enforces execution order for critical path.
- Running all completed child tasks results in:
  - `make lint` passing
  - `bun run typecheck` passing
  - `TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 bun test` passing
  - `bun test src/e2e/v3-runtime.e2e.test.ts` passing
  - `bun test src/session-manager.contract.test.ts` passing

## Tracking
- `bd list --label epic:refactor-reset`
