#!/bin/bash
# Launch annotate mode with the external notes.md (outside the repo).
#
# Usage:
#   ./run-annotate-out-of-tree.sh [--keep]
#
# Test focus: annotate mode where the primary file is OUTSIDE cwd.
# baseDir = external/, cwd = repo/. This is the key scenario for
# baseDir threading — sibling references like `script.ts` should
# resolve against external/, not the repo.
#
# Also tests: linked-doc overlay from notes.md → design.md and
# notes.md → sub/subdoc.md (nested baseDir transitions).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

KEEP_FLAG=""
for arg in "$@"; do
  case $arg in
    --keep) KEEP_FLAG="--keep" ;;
  esac
done

echo "=== Path Detection: Annotate Out-of-Tree ==="
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

# Run annotate from the sandbox repo (cwd = repo), pointing at external file
echo "Launching annotate server..."
echo "  cwd:  $SANDBOX/repo"
echo "  file: $SANDBOX/external/notes.md"
echo ""
cd "$SANDBOX/repo"
bun run "$PROJECT_ROOT/apps/hook/server/index.ts" annotate "$SANDBOX/external/notes.md"

echo ""
echo "=== Done ==="
