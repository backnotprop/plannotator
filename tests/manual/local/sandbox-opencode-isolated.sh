#!/bin/bash
# Manual QA: starts from your real HOME on purpose (it copies the OpenCode login; the session gets a scratch HOME). For an isolated test run, use `bun run test:sandbox`.
# One-command isolated OpenCode sandbox for Plannotator local development.
#
# Usage:
#   ./tests/manual/local/sandbox-opencode-isolated.sh [sandbox-opencode.sh options]
#
# Defaults:
#   - isolated HOME/XDG/Bun cache dirs
#   - forced Plannotator CLI bridge runtime
#   - OpenCode sharing disabled
#
# Examples:
#   ./tests/manual/local/sandbox-opencode-isolated.sh
#   ./tests/manual/local/sandbox-opencode-isolated.sh --runtime auto
#   ./tests/manual/local/sandbox-opencode-isolated.sh --runtime embedded --no-launch

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$SCRIPT_DIR/sandbox-opencode.sh" \
  --isolated \
  --runtime cli \
  --disable-sharing \
  "$@"
