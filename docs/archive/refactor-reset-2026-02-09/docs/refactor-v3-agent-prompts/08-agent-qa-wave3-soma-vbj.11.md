# Agent Prompt - QA Wave3 (`soma-vbj.11`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.11` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.5`, `.6`, `.7`, `.8`, `.9`, `.10` are closed.

Hard Rules:
1) Work ONLY on `soma-vbj.11`.
2) Follow `bd show soma-vbj.11` and NOTES `[Execution Directive v1]`.
3) Do not keep flaky/legacy test behavior.

Execution:
- bd show soma-vbj.11
- bd update soma-vbj.11 --status in_progress
- Perform full test rewrite:
  - remove obsolete legacy tests
  - rebuild domain/service/adapter layers
  - add integration tests for boundary interactions
- Enforce quality gates:
  - bun test
  - bun run typecheck
  - make lint
- bd close soma-vbj.11 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- new test suite is stable and all gates green
```
