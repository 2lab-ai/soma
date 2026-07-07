---
name: push
description:
  Push the current branch to origin and create or update the matching pull
  request.
---

# Push

## Prerequisites

- `gh` is installed and authenticated.
- Local validation for the current scope is green.

## Goals

- Push the current branch safely.
- Create a PR if none exists, otherwise update the existing PR.
- Keep branch history current when the remote has moved.

## Related skills

- `pull`: use this when push is rejected because the branch is stale or non-fast-forward.
- `commit`: use this when the working tree is dirty and the changes are ready to publish.

## Validation gate

Run the repository checks required by `AGENTS.md` before every push:

```sh
bun test
bun run typecheck
make lint
```

Run `make fmt` before pushing if formatting drift exists.

## Steps

1. Identify the current branch and inspect `git status`.
2. Run the validation gate above.
3. Push to `origin`, adding upstream tracking if needed:
   - `git push -u origin HEAD`
4. If the push fails because the branch is stale or non-fast-forward:
   - run the `pull` skill,
   - rerun validation,
   - push again,
   - use `--force-with-lease` only when history was intentionally rewritten.
5. Ensure there is an open PR for the branch:
   - create one if missing,
   - update the title/body if it already exists,
   - create a new branch + PR if the current branch is tied to a closed or merged PR.
6. Make the PR body reflect the full scope of the current diff, not only the latest commit.
7. Reply with the PR URL.

## Suggested commands

```sh
branch=$(git branch --show-current)
git push -u origin HEAD

pr_state=$(gh pr view --json state -q .state 2>/dev/null || true)
pr_title="<clear title for the shipped change>"

if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
  echo "Current branch is tied to a closed PR; create a new branch first." >&2
  exit 1
fi

if [ -z "$pr_state" ]; then
  gh pr create --title "$pr_title" --body-file /tmp/pr_body.md
else
  gh pr edit --title "$pr_title" --body-file /tmp/pr_body.md
fi

gh pr view --json url -q .url
```

## PR body checklist

Include concise sections for:

- Summary
- Validation
- Risks or follow-ups
