#!/bin/bash
# Launch annotate mode with the test plan inside the sandbox repo.
#
# Usage:
#   ./run-annotate-in-tree.sh [--keep]
#
# Test focus: annotate mode where the primary file is inside the
# project root. baseDir = repo/test-plan.md's parent = repo root.
# All in-repo paths should resolve normally. §12 linked-doc overlay
# transitions baseDir to the external directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

KEEP_FLAG=""
for arg in "$@"; do
  case $arg in
    --keep) KEEP_FLAG="--keep" ;;
  esac
done

echo "=== Path Detection: Annotate In-Tree ==="
echo ""

# Build
echo "Building review + hook..."
cd "$PROJECT_ROOT"
bun run build:review > /dev/null 2>&1
bun run build:hook > /dev/null 2>&1
echo "Build complete."
echo ""

# Setup sandbox
source "$SCRIPT_DIR/setup.sh" $KEEP_FLAG

# Run annotate from the sandbox repo directory
echo "Launching annotate server from $SANDBOX/repo ..."
echo ""
cd "$SANDBOX/repo"
bun run "$PROJECT_ROOT/apps/hook/server/index.ts" annotate test-plan.md

echo ""
echo "=== Done ==="
