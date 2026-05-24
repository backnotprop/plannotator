#!/bin/bash
# Test script for issue #704: loose list items with blank-line-separated
# continuation content should render indented under their parent bullet.
#
# Usage:
#   ./tests/manual/local/test-loose-list.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FIXTURE="$PROJECT_ROOT/tests/test-fixtures/15-loose-list-items.md"

echo "=== Loose List Items Test (Issue #704) ==="
echo ""

# Build
echo "Building review + hook..."
cd "$PROJECT_ROOT"
bun run build:review
bun run build:hook

echo ""
echo "Starting hook server with loose-list fixture..."
echo "Browser should open automatically."
echo ""

# Read the fixture and escape it for JSON
PLAN_CONTENT=$(python3 -c "
import json, sys
with open('$FIXTURE') as f:
    print(json.dumps(f.read()))
")

PLAN_JSON=$(cat <<EOF
{
  "tool_input": {
    "plan": $PLAN_CONTENT
  }
}
EOF
)

echo "$PLAN_JSON" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"

echo ""
echo "=== Test Complete ==="
