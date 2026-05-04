#!/bin/bash
# Launch plan mode with the path-detection test plan.
#
# Usage:
#   ./run-plan.sh [--keep]
#
# Runs setup.sh to create a temp sandbox, builds the hook, then pipes
# test-plan.md as a plan JSON to the hook server. Browser opens with
# the rendered plan. Sandbox is cleaned up on exit unless --keep.
#
# Test focus: in-repo path detection. baseDir is undefined for the
# primary plan; becomes set when you click linked-doc overlays (§12).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Forward --keep
KEEP_FLAG=""
for arg in "$@"; do
  case $arg in
    --keep) KEEP_FLAG="--keep" ;;
  esac
done

echo "=== Path Detection: Plan Mode ==="
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

# Read the test plan
PLAN_MD=$(cat "$SANDBOX/repo/test-plan.md")

# Escape for JSON embedding (newlines, quotes, backslashes)
PLAN_ESCAPED=$(printf '%s' "$PLAN_MD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

# Pipe as hook JSON to the server, running from the sandbox repo dir
echo "Launching plan server from $SANDBOX/repo ..."
echo ""
cd "$SANDBOX/repo"
echo "{\"tool_input\":{\"plan\":$PLAN_ESCAPED}}" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"

echo ""
echo "=== Done ==="
