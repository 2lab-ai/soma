# Agent Prompt - Lead Wave2 (`soma-vbj.9`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.9` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.6`, `soma-vbj.7`, `soma-vbj.8` are closed.

Hard Rules:
1) Work ONLY on `soma-vbj.9`.
2) Follow `bd show soma-vbj.9` and NOTES `[Execution Directive v1]`.
3) Remove duplicated outbound paths; keep one orchestrator path.

Execution:
- bd show soma-vbj.9
- bd update soma-vbj.9 --status in_progress
- Centralize outbound orchestration:
  - single orchestrator for text/status/reaction/choice
  - adapters consume unified output contract
  - remove per-handler send branching
- Add integration tests for mixed outbound event flows
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.9 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- all outbound traffic goes through one orchestrator
```
