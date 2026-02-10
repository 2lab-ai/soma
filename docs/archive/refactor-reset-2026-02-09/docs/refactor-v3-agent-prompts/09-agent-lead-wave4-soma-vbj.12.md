# Agent Prompt - Lead Wave4 (`soma-vbj.12`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.12` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.11` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.12`.
2) Follow `bd show soma-vbj.12` and NOTES `[Execution Directive v1]`.
3) Do not leave dual-path runtime after cutover.

Execution:
- bd show soma-vbj.12
- bd update soma-vbj.12 --status in_progress
- Final cutover pass:
  - remove dead legacy runtime paths
  - align docs with final implemented architecture
  - apply deprecation mapping where user confirmation is required
- Final validation: test/typecheck/lint and cutover readiness review
- bd close soma-vbj.12 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- only v3 runtime path remains; docs/issues consistent
```
