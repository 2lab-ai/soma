# Agent Prompt - Storage Wave1 (`soma-vbj.10`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.10` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.4` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.10`.
2) Follow `bd show soma-vbj.10` and NOTES `[Execution Directive v1]`.
3) Remove implicit chat-only key assumptions.

Execution:
- bd show soma-vbj.10
- bd update soma-vbj.10 --status in_progress
- Refactor storage/scheduler boundaries:
  - partition key: tenant/channel/thread
  - per-thread working directory rule
  - decouple scheduler from handler/session internals
- Add migration-safe tests for keying/routing invariants
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.10 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- storage/scheduler boundaries are adapter-driven with stable partition invariants
```
