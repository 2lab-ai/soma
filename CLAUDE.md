# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🔴🟢 RED-GREEN TDD — MANDATORY FOR ALL WORK

**Every bug fix and every feature MUST follow red-green TDD. No exceptions.**

### Bug Fix Workflow
```
1. REPRODUCE: Write a test that FAILS (RED) on the current broken code
2. VERIFY RED: Run the test. It MUST fail. If it passes, your test is wrong.
3. FIX: Write the minimal code fix
4. VERIFY GREEN: Run the test. It MUST pass.
5. PROVE: Show RED output and GREEN output as evidence
```

### Feature Workflow
```
1. SPEC: Write tests that describe the desired behavior (RED — feature doesn't exist yet)
2. VERIFY RED: Run tests. They MUST fail.
3. IMPLEMENT: Write the feature code
4. VERIFY GREEN: Run tests. They MUST pass.
5. REFACTOR: Clean up, tests must stay GREEN
```

### Rules
- **NEVER** close a bd task without a passing test that proves the fix/feature
- **NEVER** say "looks good" or "should work" — prove it with a test
- **NEVER** skip the RED step — if you can't make it fail first, you don't understand the bug
- **Tests go in the same directory** as the code, or in `src/scheduler/` for integration tests
- **Mock telegram (grammY Context)** and **mock model (Claude responses)** for integration tests
- **Name tests after the bd task**: `test("BUG soma-xxx: description", ...)`
- Run `bun test` after every fix. All existing tests must still pass.

### What Counts as a Test
- Unit test proving specific function behavior
- Integration test with mocked telegram + model proving message flow
- Source code assertion (checking actual code content) is a LAST RESORT, not preferred
- **Preferred**: Actual function calls with real inputs/outputs

## Task Management

**CRITICAL: All work must be managed through `bd` (beads issue tracker).**

```bash
# Before starting ANY work
bd list                    # List all open issues
bd show <id>              # Show issue details
bd create "task name"     # Create new issue
bd set-state <id> in_progress  # Mark as in progress

# After completing work
bd close <id>             # Close completed issue
bd dep <child> <parent>   # Link dependencies

# Quick capture
bd q "quick task"         # Create and get ID only

# Check what's ready
bd ready                  # Show ready work (no blockers)
```

**Workflow:**
1. Check `bd list` for existing tasks
2. If no task exists, create with `bd create`
3. Mark as `in_progress` before starting
4. Close with `bd close` after completion
5. **NEVER** start work without a bd task

## Commands

```bash
# Development
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Type check
bun install        # Install dependencies

# Build & Quality
make up            # Deploy: install → build → stop → start
make lint          # Lint code
make fmt           # Format code
make test          # Run tests

# Service Management (macOS)
make start         # Start service
make stop          # Stop service
make restart       # Restart service
make logs          # View logs
make status        # Check status
```

## Architecture

This is a Telegram bot (~3,300 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK V1 with streaming, session persistence, cumulative token tracking (input/output/cache), and defense-in-depth safety checks
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types
- **`src/scheduler.ts`** - Cron scheduler for scheduled prompts (loads `cron.yaml`, auto-reloads on file changes)

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/help`, `/new`, `/stop`, `/status`, `/stats`, `/resume`, `/cron`, `/restart`, `/retry`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via OpenAI, then same flow as text
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** - PDF extraction (pdftotext CLI) and text file processing
- **`callback.ts`** - Inline keyboard button handling for UIAskUserQuestion choice system
- **`streaming.ts`** - Shared `StreamingState` and status callback factory

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts`.

### Runtime Files

- `/tmp/soma-session.json` - Session persistence for `/resume`
- `/tmp/soma/` - Downloaded photos/documents
- `/tmp/soma-audit.log` - Audit log
- `cron.yaml` - Cron scheduler config (in working directory)

## Patterns

**UIAskUserQuestion (Telegram choice keyboard)**: When asking 지혁 questions with discrete options (2-8 choices), emit JSON: `{"type": "user_choice", "question": "...", "choices": [{"id": "a", "label": "...", "description": "..."}]}` - Do NOT use AskUserQuestion tool. This creates Telegram inline keyboards that trigger ActivityState transitions.

**Comprehensive review workflow**: Before deployment, run Oracle + PR review toolkit in sequence: (1) Oracle for architecture, (2) code-reviewer for bugs/style, (3) silent-failure-hunter for error handling, (4) type-design-analyzer for type safety, (5) pr-test-analyzer for test gaps. Found 6 bugs before deployment in ActivityState feature.

**State management in ClaudeSession**: New state fields pattern: private `_field` with getter/setter, console.log transitions for observability, careful finally block guards (check current state before resetting), integration with existing state (isRunning, choiceState).

**Testing discipline**: PR review will expose missing tests. Write tests BEFORE deployment, not after. Critical gaps: state machine transitions, integration scenarios, edge cases (concurrent callbacks, messageId validation).

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested. Use `launchctl kickstart -k gui/$(id -u)/ai.2lab.soma` if running as a service, or `bun run start` for manual runs.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Development Workflow

**CRITICAL: After ANY code changes, ALWAYS follow this workflow in EXACT order:**

```bash
# 1. Code Review - review-pr skill
# Check code quality, errors, types, style violations
/pr-review-toolkit:review-pr

# 2. Fix critical/important issues
# Address ALL findings from review before proceeding

# 3. Code Simplification - code-simplifier agent
# Simplify and refine code for clarity and maintainability
/pr-review-toolkit:code-simplifier

# 4. Lint and Format
make lint
make fmt

# 5. Architecture Review - oracle
# Deep technical review for architecture, design decisions
/oh-my-claude:oracle "Review the recent code changes for architectural issues, security concerns, and design flaws"

# 6. Security Review
# Check for vulnerabilities, unsafe patterns, security issues
/pr-review-toolkit:review-pr --focus security

# 7. Type Check (final verification)
bun run typecheck

# 8. Commit and push
git add -A
git commit -m "feat: description

- Detailed changes
- Bug fixes
- Improvements

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Z <z@2lab.ai>
Co-Authored-By: Elon Musk (AI) <elon@2lab.ai>"
git push

# 9. Deploy
make up  # Builds, type checks, and restarts service
```

**DO NOT SKIP ANY STEP. This workflow is MANDATORY for ALL code changes.**

### Make Targets

```bash
make up          # Full deployment: install → build → stop → start
make install     # Install dependencies (bun install)
make build       # Type check (bun run typecheck)
make lint        # Run ESLint
make fmt         # Format with Prettier
make test        # Run tests
make stop        # Stop launchd service
make start       # Start launchd service
make restart     # Restart service
make logs        # Tail service logs
make errors      # Tail error logs
make status      # Check service status
```

## Commit Style

Commits should include Claude Code footer and Co-Authored-By trailer as shown in the workflow above.

## Running as Service (macOS)

```bash
cp launchagent/ai.2lab.soma.plist.template ~/Library/LaunchAgents/ai.2lab.soma.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/ai.2lab.soma.plist

# Logs
tail -f /tmp/soma.log
tail -f /tmp/soma.err
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
