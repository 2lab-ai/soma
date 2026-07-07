---
name: commit
description:
  Create a well-formed git commit from the current changes using session
  history for scope and rationale.
---

# Commit

## Goals

- Produce a commit that matches the staged diff exactly.
- Use a conventional subject and a body that explains what changed and why.
- Include validation evidence from this session.

## Inputs

- Session history for scope and rationale.
- `git status`, `git diff`, and `git diff --staged`.
- Repo conventions from `AGENTS.md`.

## Steps

1. Inspect the working tree and staged diff.
2. Stage only the intended files with `git add -A` after confirming scope.
3. Check for accidental files such as logs, temp files, or build artifacts.
4. Pick an appropriate conventional prefix such as `feat`, `fix`, `refactor`, or `docs`.
5. Write a subject line in imperative mood, 72 characters or less.
6. Write a body that covers:
   - what changed,
   - why it changed,
   - validation run,
   - any notable trade-offs or limitations.
7. Add `Co-authored-by: Codex <codex@openai.com>` unless the user asked for a different identity.
8. Create the commit with `git commit -F <file>` or another newline-safe approach.

## Template

```text
<type>(<scope>): <short summary>

Summary:
- <what changed>

Rationale:
- <why it changed>

Tests:
- <command>

Co-authored-by: Codex <codex@openai.com>
```
