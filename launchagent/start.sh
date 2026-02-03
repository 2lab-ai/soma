#!/bin/bash
set -e

cd /Users/USERNAME/Dev/soma

# Source environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Run the bot
exec /Users/USERNAME/.bun/bin/bun run src/index.ts
