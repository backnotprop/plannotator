#!/bin/bash
# Test script to simulate OpenCode origin
#
# Usage:
#   ./test-hook-2.sh
#
# What it does:
#   1. Builds the hook (ensures latest code)
#   2. Runs the test server with opencode origin
#   3. Opens browser for you to test the UI (should show blue "OpenCode" badge)
#   4. Prints the result (approved/denied)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Plannotator OpenCode Origin Test ==="
echo ""

# Build first to ensure latest code
echo "Building hook..."
cd "$PROJECT_ROOT"
bun run build:hook

echo ""
echo "Starting server with OpenCode origin..."
echo "Browser should open automatically. Approve or deny the plan."
echo ""

# Run the test server with opencode origin
bun run "$PROJECT_ROOT/tests/manual/test-server.ts" opencode

echo ""
echo "=== Test Complete ==="
