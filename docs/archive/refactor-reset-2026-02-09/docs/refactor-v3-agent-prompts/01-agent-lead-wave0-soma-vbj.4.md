# Agent Prompt - Lead Wave0 (`soma-vbj.4`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.4` in `/Users/zhugehyuk/2lab.ai/soma`.

Hard Rules:
1) Work ONLY on `soma-vbj.4`.
2) Follow `bd show soma-vbj.4` and NOTES `[Execution Directive v1]` as source of truth.
3) Do not touch non-refactor backlog (blocked by `soma-wmy`).
4) Do not close or modify `soma-wmy`.
5) Do not add dependencies from main milestones to `soma-vbj.13`.

Execution:
- bd show soma-vbj.4
- bd update soma-vbj.4 --status in_progress
- Implement core contracts foundation:
  - ChannelBoundary/ProviderBoundary/RouteResolver contracts
  - tenant/channel/thread identity and session-key contract
  - compile-safe contract exposure for downstream epics
- Add minimal validation tests for contract/key invariants
- Run validation (minimum): bun run typecheck, make lint
- bd close soma-vbj.4 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- core contracts compile and downstream epics can build against them
- no provider/channel runtime-specific logic leaked into this issue
```
