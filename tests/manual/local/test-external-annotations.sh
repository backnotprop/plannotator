#!/bin/bash
# Test script for External Annotations API
#
# Usage:
#   ./test-external-annotations.sh
#
# What it does:
#   1. Builds the review app (ensures latest code)
#   2. Starts a sandbox review server with sample diff data
#   3. Opens browser — watch annotations arrive in real-time
#   4. Sends 6 waves of annotations over ~17 seconds:
#      - Wave 1 (2s):  Single eslint warning
#      - Wave 2 (5s):  Batch of 3 (eslint error, typescript error, eslint suggestion)
#      - Wave 3 (8s):  Coverage info annotation
#      - Wave 4 (10s): Depcheck warning
#      - Wave 5 (13s): Delete first annotation
#      - Wave 6 (17s): Clear all eslint annotations
#   5. Prints feedback result when you submit

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== External Annotations API Test ==="
echo ""

# Build first to ensure latest code
echo "Building review app..."
cd "$PROJECT_ROOT"
bun run --cwd apps/review build 2>&1 | tail -3

echo ""
echo "Building hook (copies review HTML)..."
bun run build:hook 2>&1 | tail -3

echo ""
echo "Starting sandbox review server..."
echo "Browser will open automatically."
echo ""
echo "Watch the annotation panel — annotations will appear in real-time."
echo "Timeline:"
echo "  2s  → eslint warning on parser.ts:12"
echo "  5s  → batch: eslint error + typescript error + eslint suggestion"
echo "  8s  → coverage info annotation"
echo "  10s → depcheck warning on package.json"
echo "  13s → delete first annotation"
echo "  17s → clear all eslint annotations"
echo ""

bun run "$PROJECT_ROOT/tests/manual/test-external-annotations.ts"

echo ""
echo "=== Test Complete ==="
