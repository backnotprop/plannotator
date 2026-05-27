#!/bin/bash
# Sandbox test for Gemini CLI integration
#
# Usage:
#   ./sandbox-gemini.sh              # Use local patched build
#   ./sandbox-gemini.sh --nightly    # Install nightly Gemini (has our fix)
#   ./sandbox-gemini.sh --simulate   # Skip Gemini, just test hook I/O
#
# What it does:
#   1. Builds the hook (ensures latest code)
#   2. Sets up Gemini config (policy TOML + settings.json hook)
#   3. Optionally installs Gemini nightly
#   4. Runs Gemini in plan mode OR simulates the hook stdin/stdout

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MODE="${1:-local}"

echo "=== Plannotator Gemini Sandbox ==="
echo ""

# --- Build ---
echo "Building review + hook..."
cd "$PROJECT_ROOT"
bun run build:hook 2>&1 | tail -1
bun run build:hook 2>&1 | tail -1
echo ""

# --- Backup existing Gemini config ---
GEMINI_DIR="$HOME/.gemini"
BACKUP_DIR=""

if [ -d "$GEMINI_DIR" ]; then
    BACKUP_DIR=$(mktemp -d)
    echo "Backing up existing ~/.gemini to $BACKUP_DIR"
    cp -r "$GEMINI_DIR/policies" "$BACKUP_DIR/policies" 2>/dev/null || true
    cp "$GEMINI_DIR/settings.json" "$BACKUP_DIR/settings.json" 2>/dev/null || true
fi

# --- Cleanup on exit ---
cleanup() {
    if [ -n "$BACKUP_DIR" ]; then
        echo ""
        echo "Restoring original ~/.gemini config..."
        if [ -d "$BACKUP_DIR/policies" ]; then
            cp -r "$BACKUP_DIR/policies/"* "$GEMINI_DIR/policies/" 2>/dev/null || true
        fi
        if [ -f "$BACKUP_DIR/settings.json" ]; then
            cp "$BACKUP_DIR/settings.json" "$GEMINI_DIR/settings.json"
        fi
        rm -rf "$BACKUP_DIR"
        echo "Restored."
    fi
}
trap cleanup EXIT

# --- Install Gemini config ---
echo "Installing Gemini policy..."
mkdir -p "$GEMINI_DIR/policies"
cp "$PROJECT_ROOT/apps/gemini/hooks/plannotator.toml" "$GEMINI_DIR/policies/plannotator.toml"

echo "Configuring Gemini hook (pointing to local source)..."
# Use bun to run the hook source directly (no compiled binary needed)
HOOK_COMMAND="bun run $PROJECT_ROOT/apps/hook/server/index.ts"

cat > "$GEMINI_DIR/settings.json" << SETTINGS_EOF
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "exit_plan_mode",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_COMMAND",
            "timeout": 345600
          }
        ]
      }
    ]
  },
  "experimental": {
    "plan": true
  }
}
SETTINGS_EOF

echo ""

# --- Mode: simulate ---
if [ "$MODE" = "--simulate" ]; then
    echo "=== Simulate Mode ==="
    echo "Piping sample Gemini BeforeTool JSON to hook..."
    echo ""

    # Create a temp plan file
    PLAN_FILE=$(mktemp /tmp/plannotator-test-XXXXX.md)
    cat > "$PLAN_FILE" << 'PLAN_EOF'
# Hello World in Python

## Objective
Create a simple Python script that prints "Hello, World!" to the console.

## Steps

1. Create `hello.py` in the project root
2. Add: `print("Hello, World!")`
3. Run with `python3 hello.py`

## Verification
- Output should be exactly: `Hello, World!`

```python
print("Hello, World!")
```
PLAN_EOF

    # Simulate the Gemini directory structure:
    # <projectTempDir>/<session_id>/plans/<plan_filename>
    # <projectTempDir>/chats/session-<timestamp>.json
    SESSION_ID="sandbox-test-$(date +%s)"
    SIMULATED_TEMP_DIR=$(mktemp -d)
    mkdir -p "$SIMULATED_TEMP_DIR/$SESSION_ID/plans"
    mkdir -p "$SIMULATED_TEMP_DIR/chats"
    cp "$PLAN_FILE" "$SIMULATED_TEMP_DIR/$SESSION_ID/plans/test-plan.md"
    TRANSCRIPT_PATH="$SIMULATED_TEMP_DIR/chats/session-simulate.json"
    echo '[]' > "$TRANSCRIPT_PATH"

    echo "Plan file: $SIMULATED_TEMP_DIR/$SESSION_ID/plans/test-plan.md"
    echo "Browser should open. Approve or deny the plan."
    echo ""

    HOOK_JSON=$(cat << EOF
{
  "tool_name": "exit_plan_mode",
  "tool_input": {"plan_filename": "test-plan.md"},
  "cwd": "/tmp",
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT_PATH",
  "hook_event_name": "BeforeTool",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    )

    echo "$HOOK_JSON" | bun run "$PROJECT_ROOT/apps/hook/server/index.ts"
    rm -rf "$SIMULATED_TEMP_DIR"

    echo ""
    echo "=== Simulate Complete ==="
    rm -f "$PLAN_FILE"
    exit 0
fi

# --- Mode: nightly ---
if [ "$MODE" = "--nightly" ]; then
    echo "Installing Gemini CLI nightly (includes exit_plan_mode fix)..."
    npm install -g @google/gemini-cli@nightly 2>&1 | tail -3
    echo ""
fi

# --- Run Gemini ---
GEMINI_BIN=""
if [ "$MODE" = "--nightly" ]; then
    GEMINI_BIN="gemini"
elif [ -f "$HOME/gemini-cli/packages/cli/dist/index.js" ]; then
    GEMINI_BIN="node $HOME/gemini-cli/packages/cli/dist/index.js"
else
    GEMINI_BIN="gemini"
fi

echo "=== Starting Gemini CLI ==="
echo ""
echo "Instructions:"
echo "  1. Type /plan to enter plan mode"
echo "  2. Ask it to create a simple plan (e.g. 'create a hello world in python')"
echo "  3. When exit_plan_mode fires, your browser should open with Plannotator"
echo "  4. Approve or deny — check that Gemini receives the decision"
echo ""
echo "Running: $GEMINI_BIN"
echo "---"
echo ""

eval $GEMINI_BIN
