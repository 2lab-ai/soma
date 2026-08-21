.PHONY: up up-force preflight install build lint fmt test stop start restart logs errors status install-service uninstall-service reinstall-service

# Detect OS
UNAME_S := $(shell uname -s)
IS_WSL := $(shell if [ -f /proc/version ] && grep -qi microsoft /proc/version; then echo 1; else echo 0; fi)

# Environment file - can be overridden: ENV=~/path/.env make up
ENV ?= .env
ENV_EXPANDED := $(shell echo $(ENV))

# Service configuration - reads SERVICE_NAME from .env or uses directory name
-include $(ENV_EXPANDED)
SERVICE_NAME ?= $(notdir $(shell pwd))
MACOS_PLIST = ~/Library/LaunchAgents/ai.2lab.$(SERVICE_NAME).plist
SYSTEMD_SERVICE = ~/.config/systemd/user/$(SERVICE_NAME).service
PIDFILE = /tmp/$(SERVICE_NAME).pid
LOGFILE = /tmp/$(SERVICE_NAME).log
ERRFILE = /tmp/$(SERVICE_NAME).err
BUN_PATH = $(shell which bun)

# WSL systemd requires DBUS session bus
SYSTEMCTL := $(if $(filter 1,$(IS_WSL)),DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$$(id -u)/bus systemctl --user,systemctl --user)

# Preflight checks - must pass before deployment
preflight:
	@echo "🔍 Running preflight checks..."
	@bun run typecheck || (echo "❌ Typecheck failed. Run: bun run typecheck" && exit 1)
	@bun run lint:check || (echo "❌ Lint errors found. Run: bun run lint:check" && exit 1)
	@echo "✅ Preflight passed"

# Full deployment pipeline with preflight (service must be pre-installed via make install-service)
# Darwin: restart exit + liveness gate success BEFORE any ✅ (no false-green).
up: install build preflight
	@echo "🔄 Deploying $(SERVICE_NAME)..."
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		if [ ! -f $(MACOS_PLIST) ]; then \
			echo "❌ macOS: plist missing — run: ENV=$(ENV) make install-service"; \
			exit 1; \
		fi; \
		$(MAKE) restart || { echo "❌ Deployment failed — restart/start did not pass liveness"; exit 1; }; \
		echo "✅ Deployment complete - macOS service restarted"; \
	elif [ "$(IS_WSL)" = "1" ]; then \
		if ! $(SYSTEMCTL) is-enabled $(SERVICE_NAME) >/dev/null 2>&1; then \
			echo "⚠️  Service '$(SERVICE_NAME)' not installed. Run: ENV=$(ENV) make install-service"; \
			exit 1; \
		fi; \
		echo "   Restarting $(SERVICE_NAME)..."; \
		$(SYSTEMCTL) restart $(SERVICE_NAME); \
		sleep 1; \
		if $(SYSTEMCTL) is-active $(SERVICE_NAME) >/dev/null 2>&1; then \
			echo "✅ Deployment complete - $(SERVICE_NAME) restarted"; \
		else \
			echo "❌ $(SERVICE_NAME) failed to start"; \
			$(SYSTEMCTL) status $(SERVICE_NAME) --no-pager 2>&1 | tail -5; \
			exit 1; \
		fi \
	else \
		echo "⚠️  Unsupported platform"; \
		exit 1; \
	fi

# Emergency deployment without preflight (use with caution)
up-force: install build
	@echo "⚠️  Skipping preflight checks (emergency mode)..."
	@echo "🔄 Deploying $(SERVICE_NAME)..."
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		if [ ! -f $(MACOS_PLIST) ]; then \
			echo "❌ macOS: plist missing — run: ENV=$(ENV) make install-service"; \
			exit 1; \
		fi; \
		$(MAKE) restart || { echo "❌ Deployment failed — restart/start did not pass liveness"; exit 1; }; \
		echo "✅ Deployment complete - macOS service restarted"; \
	elif [ "$(IS_WSL)" = "1" ]; then \
		if ! $(SYSTEMCTL) is-enabled $(SERVICE_NAME) >/dev/null 2>&1; then \
			echo "⚠️  Service '$(SERVICE_NAME)' not installed. Run: ENV=$(ENV) make install-service"; \
			exit 1; \
		fi; \
		echo "   Restarting $(SERVICE_NAME)..."; \
		$(SYSTEMCTL) restart $(SERVICE_NAME); \
		sleep 1; \
		if $(SYSTEMCTL) is-active $(SERVICE_NAME) >/dev/null 2>&1; then \
			echo "✅ Deployment complete - $(SERVICE_NAME) restarted"; \
		else \
			echo "❌ $(SERVICE_NAME) failed to start"; \
			$(SYSTEMCTL) status $(SERVICE_NAME) --no-pager 2>&1 | tail -5; \
			exit 1; \
		fi \
	else \
		echo "⚠️  Unsupported platform"; \
		exit 1; \
	fi

# Install dependencies
install:
	@echo "📦 Installing dependencies..."
	bun install

# Build/typecheck
build:
	@echo "🔨 Type checking..."
	bun run typecheck

# Lint code
lint:
	@echo "🔍 Linting code..."
	@if [ -f node_modules/.bin/eslint ]; then \
		bun run lint; \
	else \
		echo "⚠️  ESLint not installed, skipping..."; \
	fi

# Format code
fmt:
	@echo "🎨 Formatting code..."
	@if [ -f node_modules/.bin/prettier ]; then \
		bun run fmt; \
	else \
		echo "⚠️  Prettier not installed, skipping..."; \
	fi

# Run tests
test:
	@echo "🧪 Running tests..."
	@if find src -type f -name "*.test.ts" -print -quit | grep -q .; then \
		TELEGRAM_BOT_TOKEN=$${TELEGRAM_BOT_TOKEN:-dummy} TELEGRAM_ALLOWED_USERS=$${TELEGRAM_ALLOWED_USERS:-1} bun test; \
	else \
		echo "⚠️  No tests found, skipping..."; \
	fi

# Stop service or process
# Darwin deliberate-stop: bootout + domain absence (NOT SIGTERM — KeepAlive respawns).
# start/restart still use bootstrap-if-missing + kickstart (no bootout churn).
stop:
	@echo "🛑 Stopping..."
	@if [ "$(UNAME_S)" = "Darwin" ] && [ -f $(MACOS_PLIST) ]; then \
		UID_NUM=$$(id -u); \
		LABEL=ai.2lab.$(SERVICE_NAME); \
		if launchctl print gui/$$UID_NUM/$$LABEL >/dev/null 2>&1; then \
			launchctl bootout gui/$$UID_NUM/$$LABEL || { echo "❌ bootout failed for $$LABEL"; exit 1; }; \
			i=0; \
			while launchctl print gui/$$UID_NUM/$$LABEL >/dev/null 2>&1; do \
				i=$$((i+1)); \
				if [ $$i -ge 20 ]; then echo "❌ $$LABEL still loaded after bootout"; exit 1; fi; \
				sleep 0.25; \
			done; \
			echo "   macOS service unloaded ($$LABEL)"; \
		else \
			echo "   macOS service not loaded"; \
		fi \
	elif [ "$(IS_WSL)" = "1" ] && $(SYSTEMCTL) is-active $(SERVICE_NAME) >/dev/null 2>&1; then \
		$(SYSTEMCTL) stop $(SERVICE_NAME); \
		echo "   systemd service stopped"; \
	elif [ -f $(PIDFILE) ]; then \
		kill $$(cat $(PIDFILE)) 2>/dev/null && echo "   Process stopped" || echo "   Process already stopped"; \
		rm -f $(PIDFILE); \
	else \
		echo "   Nothing running"; \
	fi

# Start service or process
# Darwin: never bootout+bootstrap on an already-loaded agent (bootstrap 125).
# Load once if missing, kickstart -k, then require PID + new "Bot started" log line.
start:
	@echo "🚀 Starting..."
	@if [ "$(UNAME_S)" = "Darwin" ] && [ -f $(MACOS_PLIST) ]; then \
		UID_NUM=$$(id -u); \
		LABEL=ai.2lab.$(SERVICE_NAME); \
		PLIST=$$HOME/Library/LaunchAgents/$$LABEL.plist; \
		OUT_LOG=$$HOME/Library/Logs/$$LABEL.out.log; \
		if [ ! -f "$$PLIST" ]; then PLIST=$(MACOS_PLIST); fi; \
		if ! launchctl print gui/$$UID_NUM/$$LABEL >/dev/null 2>&1; then \
			echo "   Loading $$LABEL into gui/$$UID_NUM..."; \
			launchctl bootstrap gui/$$UID_NUM "$$PLIST" || \
				(echo "   bootstrap failed; trying legacy load"; launchctl load "$$PLIST"); \
		fi; \
		if ! launchctl print gui/$$UID_NUM/$$LABEL >/dev/null 2>&1; then \
			echo "❌ Failed to load $$LABEL"; \
			exit 1; \
		fi; \
		MARKER=$$(wc -l < "$$OUT_LOG" 2>/dev/null | tr -d ' ' || echo 0); \
		launchctl kickstart -k gui/$$UID_NUM/$$LABEL || { echo "❌ kickstart failed for $$LABEL"; exit 1; }; \
		ok=0; \
		i=0; \
		while [ $$i -lt 40 ]; do \
			i=$$((i+1)); \
			sleep 0.5; \
			LINE=$$(launchctl list | grep "$$LABEL" || true); \
			PID=$$(echo "$$LINE" | awk '{print $$1}'); \
			if [ -z "$$PID" ] || [ "$$PID" = "-" ]; then continue; fi; \
			if [ ! -f "$$OUT_LOG" ]; then continue; fi; \
			if tail -n +$$((MARKER+1)) "$$OUT_LOG" 2>/dev/null | grep -q "Bot started"; then \
				ok=1; break; \
			fi; \
		done; \
		if [ $$ok -ne 1 ]; then \
			echo "❌ Liveness failed for $$LABEL (no PID and/or no new 'Bot started' within ~20s)"; \
			echo "   log: $$OUT_LOG"; \
			tail -n 20 "$$OUT_LOG" 2>/dev/null || true; \
			exit 1; \
		fi; \
		echo "   macOS service running ($$LABEL pid=$$PID, Bot started)"; \
	elif [ "$(IS_WSL)" = "1" ] && $(SYSTEMCTL) is-enabled $(SERVICE_NAME) >/dev/null 2>&1; then \
		$(SYSTEMCTL) start $(SERVICE_NAME); sleep 1; \
		$(SYSTEMCTL) is-active $(SERVICE_NAME) && echo "   systemd service running" || echo "   ⚠️  Failed to start"; \
	else \
		nohup bun run src/index.ts >$(LOGFILE) 2>&1 & \
		echo $$! > $(PIDFILE); \
		sleep 1; \
		if kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
			echo "   Bot running (PID: $$(cat $(PIDFILE)))"; \
		else \
			echo "   ⚠️  Failed to start"; \
			rm -f $(PIDFILE); \
		fi \
	fi

# Restart service — Darwin uses kickstart -k (no bootout/bootstrap flip)
restart:
	@if [ "$(UNAME_S)" = "Darwin" ] && [ -f $(MACOS_PLIST) ]; then \
		$(MAKE) start; \
	else \
		$(MAKE) stop; \
		sleep 2; \
		$(MAKE) start; \
	fi

# Install service (one-time setup)
install-service:
	@echo "📝 Installing service..."
	@echo "   Using env file: $(ENV_EXPANDED)"
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		bash launchagent/install-macos-service.sh "$(SERVICE_NAME)" "$(ENV_EXPANDED)" "$$(pwd)"; \
	elif [ "$(IS_WSL)" = "1" ]; then \
		mkdir -p ~/.config/systemd/user; \
		printf '[Unit]\nDescription=$(SERVICE_NAME)\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%s\nEnvironmentFile=%s\nExecStart=%s run start\nRestart=always\nRestartSec=10\nEnvironment=PATH=%s:/usr/local/bin:/usr/bin:/bin\nStandardOutput=append:$(LOGFILE)\nStandardError=append:$(ERRFILE)\n\n[Install]\nWantedBy=default.target\n' "$(shell pwd)" "$(ENV_EXPANDED)" "$(BUN_PATH)" "$(dir $(BUN_PATH))" > $(SYSTEMD_SERVICE); \
		$(SYSTEMCTL) daemon-reload; \
		$(SYSTEMCTL) enable $(SERVICE_NAME); \
		echo "✅ WSL systemd service installed ($(SERVICE_NAME))"; \
		echo "   Env file: $(ENV_EXPANDED)"; \
		echo "   Start with: make start"; \
	else \
		echo "⚠️  Unsupported platform"; \
	fi

# Reinstall service (uninstall + install + start)
reinstall-service: uninstall-service install-service start
	@echo "✅ Service reinstalled and started"

# Uninstall service (complete removal)
uninstall-service:
	@echo "🗑️  Uninstalling service..."
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		UID_NUM=$$(id -u); \
		LABEL=ai.2lab.$(SERVICE_NAME); \
		if launchctl print gui/$$UID_NUM/$$LABEL >/dev/null 2>&1; then \
			launchctl bootout gui/$$UID_NUM/$$LABEL || { echo "❌ bootout failed for $$LABEL"; exit 1; }; \
		fi; \
		rm -f $(MACOS_PLIST); \
		echo "✅ macOS service removed"; \
	elif [ "$(IS_WSL)" = "1" ]; then \
		$(SYSTEMCTL) stop $(SERVICE_NAME) 2>/dev/null || true; \
		$(SYSTEMCTL) disable $(SERVICE_NAME) 2>/dev/null || true; \
		$(SYSTEMCTL) unmask $(SERVICE_NAME) 2>/dev/null || true; \
		rm -f $(SYSTEMD_SERVICE); \
		$(SYSTEMCTL) daemon-reload; \
		echo "✅ WSL systemd service removed"; \
	else \
		echo "⚠️  Unsupported platform"; \
	fi

# View logs
logs:
	@echo "📋 Service logs:"
	@tail -f $(LOGFILE)

# View error logs
errors:
	@echo "❌ Error logs:"
	@tail -f $(ERRFILE)

# Service/process status
status:
	@echo "📊 Status:"
	@if [ "$(UNAME_S)" = "Darwin" ] && [ -f $(MACOS_PLIST) ]; then \
		launchctl list | grep ai.2lab.$(SERVICE_NAME) || echo "   macOS service not running"; \
	elif [ "$(IS_WSL)" = "1" ] && $(SYSTEMCTL) is-enabled $(SERVICE_NAME) >/dev/null 2>&1; then \
		$(SYSTEMCTL) status $(SERVICE_NAME) --no-pager || echo "   systemd service not running"; \
	elif [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null; then \
		PID=$$(cat $(PIDFILE)); \
		echo "   Bot running (PID: $$PID, dev mode)"; \
		ps -p $$PID -o pid,etime,rss,args --no-headers 2>/dev/null || true; \
	else \
		rm -f $(PIDFILE) 2>/dev/null; \
		echo "   Not running"; \
	fi
