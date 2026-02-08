# Agent Prompt - Provider Wave1 (`soma-vbj.6`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.6` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.4` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.6`.
2) Follow `bd show soma-vbj.6` and NOTES `[Execution Directive v1]`.
3) Do not leak provider-native event shapes into core.

Execution:
- bd show soma-vbj.6
- bd update soma-vbj.6 --status in_progress
- Implement provider boundary:
  - ProviderPort + adapter registry
  - Claude/Codex adapters on same contract
  - normalized usage/events/errors DTO taxonomy
  - retry/backoff/rate-limit policy in orchestrator
- Add contract/integration tests for provider swap stability
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.6 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- core callsites stay provider-agnostic
- telemetry taxonomy is normalized
```
