# SOMA v3 Multi-Agent Assignment Runbook (Copy/Paste)

이 문서는 `soma-vbj` 리팩토링을 여러 에이전트에게 안전하게 분배하기 위한 즉시 실행용 가이드다.

## 0. Recommended Agent Count
- 필수: 6 agents
- 선택: +1 optional agent (`soma-vbj.13` 전용)

권장 배치:
- Agent-Lead: `soma-vbj.4` -> `soma-vbj.9` -> `soma-vbj.12`
- Agent-Core: `soma-vbj.5`
- Agent-Provider: `soma-vbj.6`
- Agent-Telegram: `soma-vbj.7`
- Agent-Slack: `soma-vbj.8`
- Agent-Storage: `soma-vbj.10`
- Agent-Optional (선택): `soma-vbj.13`

## 1. Global Rules (Paste to every agent first)
```text
You are implementing SOMA v3 refactor issues in /Users/zhugehyuk/2lab.ai/soma.

Hard rules:
1) Work ONLY on the assigned bd issue.
2) Follow issue NOTES "[Execution Directive v1]" as source of truth.
3) Do not touch non-refactor issues (they are blocked by soma-wmy).
4) Do not close soma-wmy.
5) Do not add dependency from soma-vbj.4~.12 to soma-vbj.13.

Required flow:
- bd show <ISSUE_ID>
- bd update <ISSUE_ID> --status in_progress
- implement
- run validation (at least typecheck/lint/tests relevant to touched area)
- bd close <ISSUE_ID> --reason "<what was completed>"
- git add -A && git commit && git pull --rebase && bd sync && git push
```

## 2. Wave Plan
- Wave 0: `soma-vbj.4` 단독 완료
- Wave 1 (병렬): `soma-vbj.5`, `soma-vbj.6`, `soma-vbj.7`, `soma-vbj.8`, `soma-vbj.10`
- Wave 2: `soma-vbj.9`
- Wave 3: `soma-vbj.11`
- Wave 4: `soma-vbj.12`
- Optional Track: `soma-vbj.13` (언제든 독립 실행 가능, 메인 비차단)

## 3. Copy/Paste Prompts Per Agent

### Agent-Lead (Phase A: Core Contract)
```text
Execute issue: soma-vbj.4
Repository: /Users/zhugehyuk/2lab.ai/soma

Read and follow:
- bd show soma-vbj.4
- Use NOTES -> [Execution Directive v1] exactly.

Deliverable:
- Core contracts foundation completed and merged.

After completion:
- Close issue with concise reason.
- Report blockers for Wave 1 if any.
```

### Agent-Core (Phase B1)
```text
Execute issue: soma-vbj.5
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.4 is closed.

Read and follow:
- bd show soma-vbj.5
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Domain/session-core extraction with regression safety.
```

### Agent-Provider (Phase B2)
```text
Execute issue: soma-vbj.6
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.4 is closed.

Read and follow:
- bd show soma-vbj.6
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Provider boundary + Claude/Codex orchestrator contracts implemented.
```

### Agent-Telegram (Phase B3)
```text
Execute issue: soma-vbj.7
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.4 is closed.

Read and follow:
- bd show soma-vbj.7
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Telegram channel boundary refactor completed.
```

### Agent-Slack (Phase B4)
```text
Execute issue: soma-vbj.8
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.4 is closed.

Read and follow:
- bd show soma-vbj.8
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Slack skeleton + tenant boundary behind feature flag.
```

### Agent-Storage (Phase B5)
```text
Execute issue: soma-vbj.10
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.4 is closed.

Read and follow:
- bd show soma-vbj.10
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Storage/scheduler partition refactor done.
```

### Agent-Lead (Phase C: Integration)
```text
Execute issue: soma-vbj.9
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.6, soma-vbj.7, soma-vbj.8 are closed.

Read and follow:
- bd show soma-vbj.9
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Outbound orchestration unified and integrated.
```

### Agent-QA (Phase D)
```text
Execute issue: soma-vbj.11
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.5, .6, .7, .8, .9, .10 are closed.

Read and follow:
- bd show soma-vbj.11
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Full test rewrite + all quality gates green.
```

### Agent-Lead (Phase E: Cutover)
```text
Execute issue: soma-vbj.12
Repository: /Users/zhugehyuk/2lab.ai/soma

Precondition:
- Start only after soma-vbj.11 is closed.

Read and follow:
- bd show soma-vbj.12
- Use NOTES -> [Execution Directive v1].

Deliverable:
- Final cutover cleanup and legacy deprecation pass complete.
```

### Agent-Optional (Independent Track)
```text
Execute issue: soma-vbj.13
Repository: /Users/zhugehyuk/2lab.ai/soma

Rule:
- This is optional/deferred and must stay non-blocking to main milestones.

Read and follow:
- bd show soma-vbj.13
- Use NOTES -> [Execution Directive v1].

Deliverable:
- OpenClaw compatibility mapping/docs maintained independently.
```

## 4. Launch Checklist
1. Assign Agent-Lead to `soma-vbj.4` first.
2. After `soma-vbj.4` closes, launch five parallel agents for Wave 1.
3. After Wave 1, run integration (`soma-vbj.9`).
4. Run QA gate (`soma-vbj.11`).
5. Run cutover (`soma-vbj.12`).
6. Keep `soma-vbj.13` optional and non-blocking.
