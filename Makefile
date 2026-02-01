.PHONY: up install build lint fmt test stop start restart

# Service configuration
SERVICE_NAME = com.claude-telegram-ts
SERVICE_PLIST = ~/Library/LaunchAgents/$(SERVICE_NAME).plist

# make up: Full deployment pipeline
up: install build stop start
	@echo "✅ Deployment complete"

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
		bun run eslint src --ext .ts; \
	else \
		echo "⚠️  ESLint not installed, skipping..."; \
	fi

# Format code
fmt:
	@echo "🎨 Formatting code..."
	@if [ -f node_modules/.bin/prettier ]; then \
		bun run prettier --write "src/**/*.ts"; \
	else \
		echo "⚠️  Prettier not installed, skipping..."; \
	fi

# Run tests
test:
	@echo "🧪 Running tests..."
	@if [ -d src/__tests__ ] || [ -f src/**/*.test.ts ]; then \
		bun test; \
	else \
		echo "⚠️  No tests found, skipping..."; \
	fi

# Stop service
stop:
	@echo "🛑 Stopping service..."
	@if [ -f $(SERVICE_PLIST) ]; then \
		launchctl unload $(SERVICE_PLIST) 2>/dev/null || true; \
		echo "   Service stopped"; \
	else \
		echo "   Service not installed"; \
	fi

# Start service
start:
	@echo "🚀 Starting service..."
	@if [ -f $(SERVICE_PLIST) ]; then \
		launchctl load $(SERVICE_PLIST); \
		sleep 1; \
		launchctl list | grep $(SERVICE_NAME) && echo "   Service running" || echo "   ⚠️  Service failed to start"; \
	else \
		echo "   ⚠️  Service not installed. Run 'make install-service' first"; \
	fi

# Restart service
restart: stop start

# Install launchd service (one-time setup)
install-service:
	@echo "📝 Installing launchd service..."
	@echo "⚠️  Please manually configure launchagent/com.claude-telegram-ts.plist.template"
	@echo "   Then copy it to ~/Library/LaunchAgents/$(SERVICE_NAME).plist"

# View logs
logs:
	@echo "📋 Service logs:"
	@tail -f /tmp/claude-telegram-bot.log

# View error logs
errors:
	@echo "❌ Error logs:"
	@tail -f /tmp/claude-telegram-bot.err

# Service status
status:
	@echo "📊 Service status:"
	@launchctl list | grep $(SERVICE_NAME) || echo "Service not running"
