# Agent Prompt - Optional Track (`soma-vbj.13`)

## Copy/Paste Prompt
```text
You are assigned to execute bd issue `soma-vbj.13` in `/Users/zhugehyuk/2lab.ai/soma`.

Nature:
- Optional/deferred, strictly non-blocking to main v3 milestones.

Hard Rules:
1) Work ONLY on `soma-vbj.13`.
2) Follow `bd show soma-vbj.13` and NOTES `[Execution Directive v1]`.
3) Do not add dependency from `soma-vbj.4~.12` to `soma-vbj.13`.
4) Keep work limited to compatibility contracts/docs mapping.

Execution:
- bd show soma-vbj.13
- bd update soma-vbj.13 --status in_progress
- Maintain optional OpenClaw compatibility artifacts in docs/tracks
- Verify main cutover readiness remains independent from this track
- bd close soma-vbj.13 --reason "<what completed>"
- git add -A && git commit -m "<msg>" && git pull --rebase && bd sync && git push

Done Criteria:
- optional track remains fully independent and non-blocking
```
