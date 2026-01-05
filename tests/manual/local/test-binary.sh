#!/bin/bash
# Test script using the installed plannotator binary (not local codebase)
#
# Usage:
#   ./test-binary.sh
#
# Prerequisites:
#   plannotator binary must be installed and on PATH
#   (via: curl -fsSL https://plannotator.ai/install.sh | bash)
#
# What it does:
#   1. Verifies plannotator is on PATH
#   2. Pipes sample plan JSON to the binary (simulating Claude Code)
#   3. Opens browser for you to test the UI
#   4. Prints the hook output (allow/deny decision)

set -e

echo "=== Plannotator Binary Test ==="
echo ""

# Check if plannotator is installed
if ! command -v plannotator &> /dev/null; then
    echo "Error: plannotator not found on PATH"
    echo ""
    echo "Install it with:"
    echo "  curl -fsSL https://plannotator.ai/install.sh | bash"
    echo ""
    echo "Or add ~/.local/bin to your PATH:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    exit 1
fi

BINARY_PATH=$(which plannotator)
echo "Using binary: $BINARY_PATH"
echo ""

echo "Starting plannotator..."
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

# Run the installed binary
echo "$PLAN_JSON" | plannotator

echo ""
echo "=== Test Complete ==="
