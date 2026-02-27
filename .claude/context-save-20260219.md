# Context Save — 2026-02-19 17:12 Session

## Active Issue
- **soma-r5y8** (P1 bug): CLAUDE.md not loaded on session start
  - `session.ts:633` uses global `WORKING_DIR` instead of `this.workingDir`
  - Fix exists in commit `f527808` on branch `origin/codex/auth-error-recovery` (NOT merged to main)
  - Single-line fix: `cwd: WORKING_DIR` → `cwd: this.workingDir`

## Completed Actions ✅
- ~~Cherry-pick `f527808` into main OR merge `origin/codex/auth-error-recovery`~~
- ~~Then `make up` to deploy~~
- **DONE** — deployed successfully, no further action needed

## Also Noted
- `bd ready` in soul/p9 shows 3 issues: p9-bkt.2, p9-bkt.3, p9-d3q (P0 bug)
- beads repo mismatch warning (needs `bd migrate --update-repo-id`)
