#!/bin/bash
# Create a fresh isolated Codex + Plannotator sandbox and open a shell inside it.

set -euo pipefail

ROOT_DIR="${1:-/tmp/plannotator-codex-desktop}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspace/sample-app"

echo "Resetting sandbox: $ROOT_DIR"
rm -rf "$ROOT_DIR"

"$PROJECT_ROOT/tests/manual/local/test-codex-plan-review-e2e.sh" \
  --setup-only \
  --skip-build \
  --root-dir "$ROOT_DIR"

export HOME="$ROOT_DIR/home"
export CODEX_HOME="$ROOT_DIR/home/.codex"
export PATH="$ROOT_DIR/bin:$PATH"

cd "$WORKSPACE_DIR"

cat <<EOF

Ready.

Workspace:
  $WORKSPACE_DIR

Sandbox env:
  HOME=$HOME
  CODEX_HOME=$CODEX_HOME

Run Desktop Codex from this shell:
  codex --enable hooks -m gpt-5.4-mini -s workspace-write app

After a failed hook, inspect:
  cat $ROOT_DIR/artifacts/plannotator-hook-events.log
  cat $ROOT_DIR/artifacts/plannotator-hook.stderr.log

Starting a shell in the sandbox workspace now. Type "exit" to leave it.

EOF

exec "${SHELL:-/bin/bash}"
