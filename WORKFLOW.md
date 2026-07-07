---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "soma-4e1a1a7f80e2"
  active_states:
    - Todo
    - In Progress
    - Human Review
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: $SYMPHONY_WORKSPACE_ROOT
hooks:
  after_create: |
    git clone --depth 1 "${SYMPHONY_SOURCE_REPO:-https://github.com/2lab-ai/soma.git}" .
    export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    bun install
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=xhigh --model gpt-5.3-codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
---

You are working on a Linear ticket `{{ issue.identifier }}` for the `soma` repository.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still active.
- Resume from the current workspace instead of restarting from scratch.
- Do not repeat already-finished investigation or validation unless a new change requires it.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Core contract

1. This is an unattended Symphony session. Operate autonomously end-to-end unless blocked by missing auth, permissions, or secrets.
2. Follow [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) for repo-local engineering rules.
3. Use Linear for orchestration state and `bd` for repo-local task tracking. Reuse an existing `bd` task when one already matches the work; otherwise create one before coding and set `status=in_progress`.
4. Follow red-green TDD for every change. Start by writing or updating a failing test, verify it fails, then implement the smallest fix or feature.
5. Before code edits, run the repo-local `pull` skill to sync with `origin/main`.
6. For code changes, the minimum validation bar is `bun test` and `bun run typecheck`. Run `make lint` when TypeScript or config changes could affect lint output. Run `make fmt` if formatting drift appears.
7. Final responses must describe completed work and blockers only. Do not ask the human for optional follow-up.
8. Work only inside the provided repository copy.

## Required tools

- Prefer the `linear_graphql` tool or a configured Linear MCP server for raw Linear reads and mutations.
- If neither `linear_graphql` nor Linear MCP is available, stop and report the blocker.
- If the Linear project is missing the required custom statuses `Human Review`, `Merging`, or `Rework`, stop and report that setup blocker.

## Repo-specific expectations

- This repository is a Bun + TypeScript Telegram bot.
- Treat `AGENTS.md` as authoritative for test naming, `bd` usage, and local quality gates.
- Use repository commands from `AGENTS.md` and `README.md` rather than assuming Elixir defaults from the Symphony reference repo.
- Prefer narrow, directly-proving tests over broad integration runs when possible.

## Related skills

- `linear`: raw Linear GraphQL operations through Symphony.
- `commit`: create a clean commit that matches the actual diff.
- `push`: run validation, push the branch, and create or update the PR.
- `pull`: merge the latest `origin/main` into the current branch.
- `land`: when the ticket reaches `Merging`, follow `.codex/skills/land/SKILL.md`.

## Status map

- `Todo`: queued work. Move to `In Progress` before active implementation.
- `In Progress`: active implementation and validation.
- `Human Review`: PR is ready and waiting on a human review outcome.
- `Merging`: approved and ready to land via the `land` skill.
- `Rework`: reviewer requested another implementation pass.
- `Done`: terminal; do nothing.

## Execution flow

### 1. Kickoff

1. Read the current Linear state and route based on the status map above.
2. When starting from `Todo`, immediately move the issue to `In Progress`.
3. Find or create a single `## Codex Workpad` comment on the Linear issue and keep using that same comment for all progress updates.
4. Record a short environment stamp in the workpad: `<host>:<abs-workdir>@<short-sha>`.
5. Capture a concrete plan, acceptance criteria, and validation checklist in the workpad before implementation.
6. Run the `pull` skill before code edits and record the result in the workpad notes.
7. Create or reuse the matching `bd` task before starting code changes.

### 2. Implementation

1. Reproduce the bug or encode the feature with a failing test first.
2. Keep the `bd` task and the Linear workpad synchronized as the work evolves.
3. Update the workpad after each meaningful milestone: reproduction, implementation, validation, PR publish, and review-response.
4. Keep changes scoped to the ticket. File a new Linear issue for meaningful out-of-scope work instead of expanding scope silently.
5. If a blocker requires human action, describe the exact missing auth/permission/secret in the workpad and move the issue to `Human Review`.

### 3. Validation and handoff

1. Run the required validation for the scope. For code changes, include `bun test` and `bun run typecheck`.
2. Ensure the `bd` task has proof of the red step and green step before closing it.
3. Use the `push` skill to publish the branch and create or refresh the PR.
4. Sweep all PR feedback channels before moving to `Human Review`: top-level comments, inline review comments, and review summaries.
5. Only move to `Human Review` after validation is green, PR feedback is addressed, and the workpad is fully updated.

### 4. Merge

1. While in `Human Review`, do not code unless feedback arrives.
2. If review feedback arrives, move the issue to `Rework` and repeat the implementation flow on a fresh pass.
3. When the issue moves to `Merging`, open `.codex/skills/land/SKILL.md` and run the `land` skill until the PR is merged.
4. After a successful merge, move the issue to `Done`.
