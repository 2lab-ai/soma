# Symphony Setup

This repository now includes the repo-local files Symphony expects:

- [`WORKFLOW.md`](/Users/zhugehyuk/2lab.ai/soma/WORKFLOW.md)
- [`commit`](/Users/zhugehyuk/2lab.ai/soma/.codex/skills/commit/SKILL.md)
- [`push`](/Users/zhugehyuk/2lab.ai/soma/.codex/skills/push/SKILL.md)
- [`pull`](/Users/zhugehyuk/2lab.ai/soma/.codex/skills/pull/SKILL.md)
- [`land`](/Users/zhugehyuk/2lab.ai/soma/.codex/skills/land/SKILL.md)
- [`linear`](/Users/zhugehyuk/2lab.ai/soma/.codex/skills/linear/SKILL.md)

## Manual follow-up

1. Set `LINEAR_API_KEY` in the environment where Symphony runs.
2. Set `SYMPHONY_WORKSPACE_ROOT` to the directory where per-issue workspaces should be created.
3. Keep `tracker.api_key: $LINEAR_API_KEY` in [`WORKFLOW.md`](/Users/zhugehyuk/2lab.ai/soma/WORKFLOW.md) and make sure the variable is exported before launching Symphony.
4. Update `tracker.project_slug` in [`WORKFLOW.md`](/Users/zhugehyuk/2lab.ai/soma/WORKFLOW.md) to your real Linear project slug.
5. Ensure the Linear team workflow includes `Human Review`, `Merging`, and `Rework`.
6. Start Symphony with this repo's workflow file:

```sh
./bin/symphony /path/to/soma/WORKFLOW.md
```

## Notes

- The workflow bootstraps a fresh workspace by cloning `https://github.com/2lab-ai/soma.git` and running `bun install`.
- The prompt explicitly preserves this repo's local contract from `AGENTS.md`: `bd` tracking, red-green TDD, `bun test`, and `bun run typecheck`.
