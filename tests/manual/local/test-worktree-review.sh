#!/bin/bash
# Test script for worktree support and expandable diff context in code review
#
# Usage:
#   ./test-worktree-review.sh [--keep]
#
# Options:
#   --keep  Don't clean up the temp repo on exit (for debugging)
#
# What it does:
#   1. Builds the review app (ensures latest code)
#   2. Creates a temp git repo with:
#      - Main repo: 6 uncommitted changes including disjoint hunks, deleted file,
#        renamed file, and new file (for expandable diff context testing)
#      - 4 worktrees: feature-auth, fix-parser, empty-branch, detached HEAD
#   3. Launches review server — browser opens automatically
#   4. You test worktree dropdown, diff switching, and expandable context
#   5. Cleans up on exit (unless --keep)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Plannotator Worktree Review Test ==="
echo ""

# Build first to ensure latest code
echo "Building review app..."
cd "$PROJECT_ROOT"
bun run build:hook

echo ""
echo "Setting up sandbox with worktrees..."
echo ""

# Forward args to the TypeScript test server
bun run "$PROJECT_ROOT/tests/manual/test-worktree-review.ts" "$@"

echo ""
echo "=== Test Complete ==="
