---
name: pull
description:
  Merge the latest origin/main into the current branch and resolve conflicts.
---

# Pull

## Goals

- Sync the current branch with the latest `origin/main`.
- Resolve conflicts carefully and rerun repo validation afterwards.

## Steps

1. Confirm the working tree is clean or intentionally stashed.
2. Enable rerere locally:
   - `git config rerere.enabled true`
   - `git config rerere.autoupdate true`
3. Fetch the latest remote refs with `git fetch origin`.
4. Fast-forward the remote copy of the current branch:
   - `git pull --ff-only origin $(git branch --show-current)`
5. Merge `origin/main` into the current branch:
   - `git -c merge.conflictstyle=zdiff3 merge origin/main`
6. If conflicts occur:
   - inspect both sides before editing,
   - prefer intention-preserving resolutions,
   - resolve one file at a time,
   - run `git diff --check` before continuing.
7. Stage the resolved files and complete the merge.
8. Run the repo checks required by `AGENTS.md` for the touched scope.
9. Summarize the merge result, conflicts, and assumptions.

## Ask the user only if

- the conflict changes a user-visible contract and the intended behavior cannot be inferred, or
- the merge would cause irreversible data or schema loss without a safe default.
