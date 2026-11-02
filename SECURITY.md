# Security Model

This document describes the security architecture of the Claude Telegram Bot.

## Permission Mode: Full Bypass

**This bot runs Claude Code with all permission prompts disabled.**

```typescript
// src/session.ts
permissionMode: "bypassPermissions"
allowDangerouslySkipPermissions: true
```

This means Claude can:
- **Read and write files** without asking for confirmation
- **Execute shell commands** without permission prompts
- **Use all tools** (Bash, Edit, Write, etc.) autonomously

This is intentional. The bot is designed for personal use from mobile, where confirming every file read or command would be impractical. Instead of per-action prompts, we rely on defense-in-depth with multiple security layers described below.

**This is not configurable** - the bot always runs in bypass mode. If you need permission prompts, use Claude Code directly instead.

Ordinary tool calls are allowed by the bot's own `PreToolUse` hook once its safety check passes, and run without a round trip; inputs the hook hard-denies are still blocked there. If the SDK nonetheless routes a call to `canUseTool` while in bypass mode, that call becomes a Telegram approve/deny keyboard — the bot does not try to second-guess why the SDK asked. Critical-path `rm`/`rmdir` and similar destructive commands are blocked by the bot's own command safety check, not by an SDK prompt. By default the bot also loads no filesystem settings (`settingSources: []`), so the operator's own `~/.claude/settings.json` permission defaults and hooks never apply inside it.

`SOMA_SETTING_SOURCES` (comma-separated `user`, `project`, `local`; default empty) opts a bot into those sources, for example `user` so a single-owner bot can use the skills in `~/.claude/skills`. Each loaded source brings its whole `settings.json`, hooks included: those hooks then run inside every bot query. Loaded permission defaults do not bring back Telegram prompts, because the `PreToolUse` hook answers every call it passes with an explicit allow. With `project` the CLI loads `CLAUDE.md` itself and the bot skips its own copy in the system prompt. Invalid entries are logged and dropped.

## Threat Model

The bot is designed for **personal use by trusted users**. The primary threats we defend against:

1. **Unauthorized access** - Someone discovers or steals your bot token
2. **Prompt injection** - Malicious content in messages tries to manipulate Claude
3. **Accidental damage** - Legitimate users accidentally running destructive commands
4. **Credential exposure** - Attempts to extract API keys, passwords, or secrets

## Defense in Depth

The bot implements multiple layers of security:

### Layer 1: User Allowlist

Only Telegram users whose IDs are in `TELEGRAM_ALLOWED_USERS` can interact with the bot.

```
User sends message → Check user ID in allowlist → Reject if not authorized
```

- User IDs are numeric and cannot be spoofed in Telegram
- Get your ID from [@userinfobot](https://t.me/userinfobot)
- Unauthorized attempts are logged

### Layer 2: Rate Limiting

Token bucket rate limiting prevents abuse even if credentials are compromised.

```
Default: 20 requests per 60 seconds per user
```

Configure via:
- `RATE_LIMIT_ENABLED` - Enable/disable (default: true)
- `RATE_LIMIT_REQUESTS` - Requests per window (default: 20)
- `RATE_LIMIT_WINDOW` - Window in seconds (default: 60)

### Layer 3: Path Validation

File operations are restricted to explicitly allowed directories.

```
Default allowed paths:
- CLAUDE_WORKING_DIR
- ~/Documents
- ~/Downloads
- ~/Desktop
```

Customize via `ALLOWED_PATHS` (comma-separated).

**Validation uses proper path containment checks:**
- Symlinks are resolved before checking
- Path traversal attacks (../) are prevented
- Only exact directory matches are allowed

**Exception for temp files:**
- Reading from /tmp/ and /var/folders/ is allowed
- This enables handling of Telegram-downloaded files

### Layer 4: Command Safety

Dangerous shell commands are blocked as defense-in-depth.

#### Completely Blocked Patterns

These patterns are **always rejected**, regardless of context:

| Pattern | Reason |
|---------|--------|
| `rm -rf /` | System destruction |
| `rm -rf ~` | Home directory wipe |
| `rm -rf $HOME` | Home directory wipe |
| `sudo rm` | Privileged deletion |
| `:(){ :\|:& };:` | Fork bomb |
| `> /dev/sd` | Disk overwrite |
| `mkfs.` | Filesystem formatting |
| `dd if=` | Raw disk operations |

#### Path-Validated Commands

`rm` commands (that don't match blocked patterns above) are **allowed but path-validated**:

```bash
rm file.txt              # Allowed if in ALLOWED_PATHS
rm /etc/passwd           # Blocked - outside ALLOWED_PATHS
rm -rf ./node_modules    # Allowed if cwd is in ALLOWED_PATHS
rm -r /tmp/mydir         # Allowed - /tmp is always permitted
```

Each path argument is checked against `ALLOWED_PATHS` before execution.

#### Bash File-Argument Check

For `cat`, `head`, `tail`, `less`, `more`, `cp`, `mv`, `tee`, `wc`, `sort`, `sed` and `awk`, absolute-path arguments are also checked against `ALLOWED_PATHS` (the `/dev` stream pseudo-files such as `/dev/null` excepted). This check is a heuristic with known bypasses — a quoted path, `python3 -c`, any program not on that list — and was never the security boundary. In standard mode it is unchanged. `SOMA_TRUST_MODE=owner` disables it, deliberately accepting outside-root Bash file access from the owner's bot in exchange for no false blocks on fragments of quoted `sed`/`awk` programs and the like. Owner mode is a trusted-owner policy, not filesystem confinement. The blocked patterns, the `rm` path check and the Read/Write/Edit/Grep/Glob root checks apply in both modes.

### Layer 5: System Prompt

Claude receives a safety prompt that instructs it to:

1. **Never delete files without explicit confirmation** - Must ask "Are you sure?"
2. **Only access allowed directories** - Refuse operations outside them
3. **Never run dangerous commands** - Even if asked
4. **Ask for confirmation on destructive actions**

This is the primary protection layer. The other layers are defense-in-depth.

`SOMA_TRUST_MODE=owner` (default `standard`, which is the prompt above) is for a bot used only by its owner. It keeps rules 1 and 3 — no file deletion without the owner's explicit confirmation, no `rm -rf` — and replaces rules 2 and 4: `ALLOWED_PATHS` is described as what the `PreToolUse` guard checks Read/Write/Edit/Grep/Glob paths and `rm` targets against, the model runs installed programs and reports a guard block instead of refusing in advance, and irreversible actions follow the working directory's `CLAUDE.md`. It also separates refusals from cancellations: a new owner message in the chat, a Telegram denial ("The user denied this tool use in Telegram.") or a "Permission denied: …" result is a real refusal and always wins; only the generic CLI text "The user doesn't want to take this action right now…" with none of those is an automatic cancellation, and the model checks whether a cancelled call already took effect before re-running only what did not complete. The guard layers (3 and 4) are the same in both modes, except that owner mode disables the Bash file-argument check (see Layer 4). An unknown value is logged and treated as `standard`.

### Layer 6: Audit Logging

All interactions are logged for security review.

```
Log location: /tmp/soma-audit.log (configurable)
```

Logged events:
- `message` - User messages and Claude responses
- `auth` - Authorization attempts
- `tool_use` - Claude tool usage
- `error` - Errors during processing
- `rate_limit` - Rate limit events

Enable JSON format for easier parsing: `AUDIT_LOG_JSON=true`

## What This Doesn't Protect Against

1. **Malicious authorized users** - If you add someone to the allowlist, they have full access
2. **Zero-day vulnerabilities** - Unknown bugs in Claude, the SDK, or dependencies
3. **Physical access** - Someone with access to the machine running the bot
4. **Network interception** - Though Telegram uses encryption

## Recommendations

1. **Keep the allowlist small** - Only add users you fully trust
2. **Use a dedicated working directory** - Don't point at `/` or `~`
3. **Review audit logs periodically** - Look for suspicious patterns
4. **Keep dependencies updated** - Security patches for the SDK and Telegram library
5. **Use a dedicated API key** - Create a separate Anthropic API key for the bot
6. **Enable email alerts** - Get notified when new sessions start

## Incident Response

If you suspect unauthorized access:

1. **Stop the bot**: `launchctl unload ~/Library/LaunchAgents/ai.2lab.soma.plist`
2. **Revoke the Telegram bot token**: Message @BotFather and create a new token
3. **Review audit logs**: Check `/tmp/soma-audit.log`
4. **Check for file changes**: Review recent activity in allowed directories
5. **Update credentials**: Rotate any API keys that may have been exposed

## Security Updates

If you discover a security issue:

1. **Don't open a public GitHub issue**
2. Contact the maintainer privately
3. Allow time for a fix before disclosure
