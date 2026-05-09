#!/bin/bash
# Test script for JJ local review support.
#
# Usage:
#   ./tests/manual/local/test-jj-review.sh [--keep] [--setup-only]
#
# Options:
#   --keep        Don't clean up the temp repo after the review session exits.
#   --setup-only  Create the JJ sandbox and print useful commands without
#                 launching the browser review UI. Implies --keep.
#
# What it does:
#   1. Builds the review app.
#   2. Creates a local bare Git remote that acts like a tiny GitHub origin.
#   3. Clones it with `jj git clone --colocate`.
#   4. Creates a committed JJ change and a current working-copy change.
#   5. Launches the real review server through the VCS abstraction.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if ! command -v jj >/dev/null 2>&1; then
  echo "jj is required for this manual sandbox but was not found on PATH." >&2
  exit 1
fi

echo "=== Plannotator JJ Review Test ==="
echo ""

echo "Building review app..."
cd "$PROJECT_ROOT"
bun run build:review

echo ""
echo "Setting up JJ sandbox..."
echo ""

bun run "$PROJECT_ROOT/tests/manual/test-jj-review.ts" "$@"

echo ""
echo "=== Test Complete ==="
