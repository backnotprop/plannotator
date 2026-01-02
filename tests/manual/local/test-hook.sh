#!/bin/bash
# Test script to simulate Claude Code hook locally
#
# Usage:
#   ./test-hook.sh
#
# What it does:
#   1. Builds the hook (ensures latest code)
#   2. Pipes sample plan JSON to the server (simulating Claude Code)
#   3. Opens browser for you to test the UI
#   4. Prints the hook output (allow/deny decision)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Plannotator Hook Test ==="
echo ""

# Build first to ensure latest code
echo "Building hook..."
cd "$PROJECT_ROOT"
bun run build:hook

echo ""
echo "Starting hook server..."
echo "Browser should open automatically. Approve or deny the plan."
echo ""

# Sample plan with code blocks (for tag extraction testing)
PLAN_JSON=$(cat << 'EOF'
{
  "tool_input": {
    "plan": "# Implementation Plan: User Authentication\n\n## Overview\nAdd secure user authentication using JWT tokens and bcrypt password hashing.\n\n## Phase 1: Database Schema\n\n```sql\nCREATE TABLE users (\n  id UUID PRIMARY KEY,\n  email VARCHAR(255) UNIQUE NOT NULL,\n  password_hash VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT NOW()\n);\n```\n\n## Phase 2: API Endpoints\n\n```typescript\n// POST /auth/register\napp.post('/auth/register', async (req, res) => {\n  const { email, password } = req.body;\n  const hash = await bcrypt.hash(password, 10);\n  // ... create user\n});\n\n// POST /auth/login\napp.post('/auth/login', async (req, res) => {\n  // ... verify credentials\n  const token = jwt.sign({ userId }, SECRET);\n  res.json({ token });\n});\n```\n\n## Checklist\n\n- [ ] Set up database migrations\n- [ ] Implement password hashing\n- [ ] Add JWT token generation\n- [ ] Create login/register endpoints\n- [x] Design database schema\n\n---\n\n**Target:** Complete by end of sprint"
  }
}
EOF
)

# Run the hook server
echo "$PLAN_JSON" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"

echo ""
echo "=== Test Complete ==="
