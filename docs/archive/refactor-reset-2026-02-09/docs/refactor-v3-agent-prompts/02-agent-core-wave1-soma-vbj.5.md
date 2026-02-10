# Agent Prompt - Core Wave1 (`soma-vbj.5`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.5` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.4` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.5`.
2) Follow `bd show soma-vbj.5` and NOTES `[Execution Directive v1]`.
3) Do not touch non-refactor backlog blocked by `soma-wmy`.

Execution:
- bd show soma-vbj.5
- bd update soma-vbj.5 --status in_progress
- Extract domain/session-core from handler/session monolith:
  - move state transitions and core rules into core modules
  - keep adapters thin
  - prevent transport/provider coupling in domain layer
- Add regression tests for moved state-machine paths
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.5 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- core owns state transitions
- handlers become thin orchestration only
```
