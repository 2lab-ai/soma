# Agent Prompt - Telegram Wave1 (`soma-vbj.7`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.7` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.4` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.7`.
2) Follow `bd show soma-vbj.7` and NOTES `[Execution Directive v1]`.
3) Keep auth/rate-limit at inbound middleware boundary.

Execution:
- bd show soma-vbj.7
- bd update soma-vbj.7 --status in_progress
- Refactor Telegram into channel boundary contracts:
  - normalize inbound envelope
  - enforce interrupt bypass + timestamp ordering
  - connect outbound via unified output port contract
- Add tests for interrupt/order and boundary behavior
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.7 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- Telegram adapter talks to core only via boundary contracts
```
