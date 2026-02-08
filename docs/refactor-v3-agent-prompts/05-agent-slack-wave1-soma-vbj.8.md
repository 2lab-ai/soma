# Agent Prompt - Slack Wave1 (`soma-vbj.8`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.8` in `/Users/zhugehyuk/2lab.ai/soma`.

Precondition:
- Start only after `soma-vbj.4` is closed.

Hard Rules:
1) Work ONLY on `soma-vbj.8`.
2) Follow `bd show soma-vbj.8` and NOTES `[Execution Directive v1]`.
3) Do NOT merge soma-work runtime.
4) Keep Slack path feature-flagged and non-default.

Execution:
- bd show soma-vbj.8
- bd update soma-vbj.8 --status in_progress
- Add minimal Slack skeleton:
  - text/thread baseline
  - tenant-aware identity/auth boundary
  - feature-flag control
- Add smoke/integration checks without breaking main path
- Run validation: bun run typecheck, make lint, relevant tests
- bd close soma-vbj.8 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- Slack skeleton exists and is safely isolated
```
