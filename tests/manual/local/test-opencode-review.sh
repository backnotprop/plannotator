#!/bin/bash
# Test script to simulate OpenCode code review
#
# Usage:
#   ./test-opencode-review.sh
#
# What it does:
#   1. Builds the review app (ensures latest code)
#   2. Runs the review server with opencode origin
#   3. Opens browser for you to test the UI (should show "OpenCode" badge + "Send Feedback" button)
#   4. Prints the result (feedback)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Plannotator OpenCode Code Review Test ==="
echo ""

# Build first to ensure latest code
echo "Building review app..."
cd "$PROJECT_ROOT"
bun run build:review

echo ""
echo "Starting review server with OpenCode origin..."
echo "Browser should open automatically."
echo "You should see:"
echo "  - 'OpenCode' badge in header"
echo "  - 'Send Feedback' button (instead of 'Copy Feedback')"
echo ""

# Run the test server
bun run "$PROJECT_ROOT/tests/manual/test-review-server.ts"

echo ""
echo "=== Test Complete ==="
