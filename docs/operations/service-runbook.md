# SOMA Service Runbook (Current)

Updated: 2026-02-10  
Scope: Current `main` branch behavior (`Makefile`, `bun test`, scheduler/runtime flow)

## 1) Preconditions

- Run from repository root:
  - `/Users/icedac/2lab.ai/soma`
- Required env for tests:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_ALLOWED_USERS`
- For local/CI test runs without real bot token, use dummy values.

## 2) Standard Quality Gates

```bash
make lint
make test
bun run typecheck
```

`make test` already injects fallback env when missing:
- `TELEGRAM_BOT_TOKEN=dummy`
- `TELEGRAM_ALLOWED_USERS=1`

## 3) Coverage Commands

### 3.1 Full test coverage

```bash
TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 \
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov \
  --coverage-dir coverage/all
```

### 3.2 E2E-only coverage

```bash
TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 \
bun test src/e2e --coverage --coverage-reporter=text --coverage-reporter=lcov \
  --coverage-dir coverage/e2e
```

Fallback (single e2e contract file):

```bash
TELEGRAM_BOT_TOKEN=dummy TELEGRAM_ALLOWED_USERS=1 \
bun test src/e2e/v3-runtime.e2e.test.ts --coverage \
  --coverage-reporter=text --coverage-reporter=lcov \
  --coverage-dir coverage/e2e
```

## 4) Deployment and Service Lifecycle

### 4.1 Primary deploy path

```bash
make up
```

`make up` sequence:
1. `bun install`
2. `bun run typecheck`
3. `bun run typecheck` + `bun run lint:check` via preflight
4. Platform service restart/reinstall

### 4.2 Emergency deploy (skip preflight)

```bash
make up-force
```

### 4.3 Service control

```bash
make start
make stop
make restart
make status
make logs
make errors
```

## 5) Platform Notes

### macOS

- Uses LaunchAgent (`~/Library/LaunchAgents/ai.2lab.<SERVICE_NAME>.plist`).
- If plist is missing, run `make install-service` guidance and install plist first.

### WSL

- Uses user systemd service at:
  - `~/.config/systemd/user/<SERVICE_NAME>.service`
- `make up` auto-rebuilds/reloads the service file.
- Historical incident details are documented in:
  - `/Users/icedac/2lab.ai/soma/docs/operations/wsl-systemd-service-guide.md`

## 6) Fast Troubleshooting

### Bot appears duplicated / Telegram 409 conflict

```bash
ps aux | grep "bun run src/index.ts" | grep -v grep
pkill -f "bun run src/index.ts"
make restart
```

### Service status unclear

```bash
make status
make logs
make errors
```

## 7) Related Docs

- `/Users/icedac/2lab.ai/soma/docs/specs.md`
- `/Users/icedac/2lab.ai/soma/docs/architecture/current-source-architecture.md`
