---
name: land
description:
  Land a PR by monitoring review feedback and checks, fixing issues as needed,
  and squash-merging once the branch is clean.
---

# Land

## Goals

- Keep the PR conflict-free with `main`.
- Wait for checks and review feedback.
- Fix failures or merge cleanly without handing control back early.

## Preconditions

- `gh` is authenticated.
- You are on the PR branch.
- The working tree is clean or intentionally ready to be committed.

## Related skills

- `commit`: create a clean commit for ready changes.
- `push`: publish branch changes and create/update the PR.
- `pull`: merge `origin/main` when the branch is stale or conflicting.

## Steps

1. Identify the PR for the current branch with `gh pr view`.
2. Run the local validation gate before waiting on remote checks:
   - `bun test`
   - `bun run typecheck`
   - `make lint`
3. If the working tree is dirty with intended changes, use `commit` and then `push`.
4. Check mergeability:
   - if conflicting, run `pull`, resolve conflicts, rerun validation, then `push`.
5. Use the async watcher:

```sh
python3 .codex/skills/land/land_watch.py
```

Exit codes:

- `0`: no new review feedback and all checks passed
- `2`: new review feedback detected
- `3`: one or more checks failed
- `4`: PR head changed while watching

6. If review feedback appears, classify each item as accept, clarify, or push back, then reply inline before changing code.
7. If checks fail, inspect the failing run, fix the issue locally, rerun validation, `commit`, `push`, and restart the watcher.
8. When checks are green and feedback is addressed, squash-merge:

```sh
pr_title=$(gh pr view --json title -q .title)
pr_body=$(gh pr view --json body -q .body)
gh pr merge --squash --subject "$pr_title" --body "$pr_body"
```

## Notes

- Do not enable auto-merge.
- Use `--force-with-lease` only when a deliberate history rewrite makes it necessary.
- Keep GitHub replies prefixed with `[codex]`.
