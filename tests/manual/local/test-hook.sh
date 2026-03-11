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
echo "Building review + hook..."
cd "$PROJECT_ROOT"
bun run build:review
bun run build:hook

echo ""
echo "Starting hook server..."
echo "Browser should open automatically. Approve or deny the plan."
echo ""

# Sample plan with YAML frontmatter and code blocks
PLAN_JSON=$(cat << 'EOF'
{
  "tool_input": {
    "plan": "---\ntitle: User Authentication Plan\nauthor: Claude\ndate: 2026-01-09\ntags:\n  - auth\n  - security\n  - backend\n---\n\n# Implementation Plan: User Authentication\n\n## Overview\nAdd secure user authentication using JWT tokens and bcrypt password hashing.\n\n## Phase 1: Database Schema\n\n```sql\nCREATE TABLE users (\n  id UUID PRIMARY KEY,\n  email VARCHAR(255) UNIQUE NOT NULL,\n  password_hash VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT NOW()\n);\n```\n\n## Phase 2: API Endpoints\n\n```typescript\n// POST /auth/register\napp.post('/auth/register', async (req, res) => {\n  const { email, password } = req.body;\n  const hash = await bcrypt.hash(password, 10);\n  // ... create user\n});\n\n// POST /auth/login\napp.post('/auth/login', async (req, res) => {\n  // ... verify credentials\n  const token = jwt.sign({ userId }, SECRET);\n  res.json({ token });\n});\n```\n\n## Phase 3: Data Quality Checks\n\nThis section tests the light mode code block fix (PR #234). The markdown code block below contains underscores, asterisks, and backticks that highlight.js parses as emphasis/strong/code tokens — these were nearly invisible in light mode before the fix.\n\n```markdown\n# data_quality_report\n\nThe `data_quality_good` flag indicates whether the **QUANT.** pipeline passed.\nFields like `user_email_verified` and `account_status_active` are checked.\n\n_Note: values marked with *asterisks* require manual review._\n\n## Steps\n\n1. Run `validate_schema --strict` against the input\n2. Check that `row_count >= expected_minimum`\n3. Verify `null_ratio < 0.05` for all **required** columns\n```\n\n## Checklist\n\n- [ ] Set up database migrations\n- [ ] Implement password hashing\n- [ ] Add JWT token generation\n- [ ] Create login/register endpoints\n- [x] Design database schema\n\n---\n\n**Target:** Complete by end of sprint"
  }
}
EOF
)

# Run the hook server
echo "$PLAN_JSON" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"

echo ""
echo "=== Test Complete ==="
