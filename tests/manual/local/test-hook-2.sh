#!/bin/bash
# Test script to simulate Claude Code hook locally (alternate plan)
#
# Usage:
#   ./test-hook-2.sh
#
# What it does:
#   1. Builds the hook (ensures latest code)
#   2. Pipes sample plan JSON to the server (simulating Claude Code)
#   3. Opens browser for you to test the UI
#   4. Prints the hook output (allow/deny decision)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Plannotator Hook Test (Plan 2) ==="
echo ""

# Build first to ensure latest code
echo "Building hook..."
cd "$PROJECT_ROOT"
bun run build:hook

echo ""
echo "Starting hook server..."
echo "Browser should open automatically. Approve or deny the plan."
echo ""

# Different sample plan - API rate limiting feature
PLAN_JSON=$(cat << 'EOF'
{
  "tool_input": {
    "plan": "# Implementation Plan: API Rate Limiting\n\n## Overview\nAdd rate limiting to protect API endpoints from abuse using a sliding window algorithm with Redis.\n\n## Phase 1: Redis Setup\n\n```typescript\nimport Redis from 'ioredis';\n\nconst redis = new Redis({\n  host: process.env.REDIS_HOST,\n  port: 6379,\n  password: process.env.REDIS_PASSWORD,\n});\n```\n\n## Phase 2: Rate Limiter Middleware\n\n```typescript\ninterface RateLimitConfig {\n  windowMs: number;  // Time window in milliseconds\n  max: number;       // Max requests per window\n}\n\nasync function rateLimiter(req: Request, config: RateLimitConfig) {\n  const key = `ratelimit:${req.ip}`;\n  const current = await redis.incr(key);\n  \n  if (current === 1) {\n    await redis.pexpire(key, config.windowMs);\n  }\n  \n  if (current > config.max) {\n    throw new RateLimitError('Too many requests');\n  }\n}\n```\n\n## Phase 3: Apply to Routes\n\n```typescript\n// Apply different limits per endpoint\napp.use('/api/auth/*', rateLimiter({ windowMs: 60000, max: 5 }));\napp.use('/api/public/*', rateLimiter({ windowMs: 60000, max: 100 }));\napp.use('/api/admin/*', rateLimiter({ windowMs: 60000, max: 30 }));\n```\n\n## Checklist\n\n- [ ] Set up Redis connection\n- [ ] Implement sliding window algorithm\n- [ ] Add rate limit headers to responses\n- [ ] Create bypass for internal services\n- [ ] Add monitoring/alerts for rate limit hits\n\n---\n\n**Note:** Consider using `X-RateLimit-Remaining` headers for client feedback."
  }
}
EOF
)

# Run the hook server
echo "$PLAN_JSON" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"

echo ""
echo "=== Test Complete ==="
