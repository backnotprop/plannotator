#!/bin/bash
# End-to-end Codex Stop-hook test harness for Plannotator.
#
# Creates a disposable HOME and sample workspace, enables Codex hooks there,
# runs a real `codex exec` plan-only prompt, and leaves behind artifacts that
# make it easy to inspect rollout files, Plannotator history, and active URLs.
#
# Usage:
#   ./tests/manual/local/test-codex-plan-review-e2e.sh [--keep] [--detach] [--setup-only]
#     [--skip-build] [--root-dir DIR] [--model MODEL] [--sandbox MODE]
#     [--codex-bin PATH] [--prompt-file FILE]

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./tests/manual/local/test-codex-plan-review-e2e.sh [options]

Runs a real Codex exec in a disposable HOME/workspace with Plannotator Stop hooks enabled.

Options:
  --keep              Keep the sandbox directory after exit
  --detach            Best-effort background launch; foreground mode is the validated path
  --setup-only        Create the isolated HOME/workspace/hooks and exit without running Codex
  --skip-build        Reuse existing build artifacts
  --root-dir DIR      Use DIR instead of a temp sandbox root
  --model MODEL       Codex model to use (default: gpt-5.4-mini)
  --sandbox MODE      Codex sandbox for `exec` (default: read-only)
  --codex-bin PATH    Override the Codex CLI binary or codex.js path
  --prompt-file FILE  Use a custom prompt file instead of the built-in sample prompt
  --help              Show this help

Environment:
  PLANNOTATOR_BROWSER  Passed through to the disposable Codex run. Set to
                       /usr/bin/true when you want to drive the review with
                       Playwright from another terminal instead of an auto-opened browser.
  CODEX_AUTH_JSON      Override the auth.json copied into the disposable HOME.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_cmd() {
  local name="$1"
  local fallback="${2:-}"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  if [[ -n "$fallback" && -x "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return
  fi
  echo "Missing required command: $name" >&2
  exit 1
}

KEEP_SANDBOX=false
DETACH=false
SETUP_ONLY=false
SKIP_BUILD=false
ROOT_DIR=""
MODEL="${PLANNOTATOR_CODEX_MODEL:-gpt-5.4-mini}"
SANDBOX_MODE="${PLANNOTATOR_CODEX_SANDBOX:-read-only}"
CODEX_BIN="${CODEX_BIN:-}"
PROMPT_FILE=""
ORIGINAL_HOME="$HOME"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP_SANDBOX=true
      ;;
    --detach)
      DETACH=true
      KEEP_SANDBOX=true
      ;;
    --setup-only)
      SETUP_ONLY=true
      KEEP_SANDBOX=true
      ;;
    --skip-build)
      SKIP_BUILD=true
      ;;
    --root-dir)
      ROOT_DIR="$2"
      shift
      ;;
    --model)
      MODEL="$2"
      shift
      ;;
    --sandbox)
      SANDBOX_MODE="$2"
      shift
      ;;
    --codex-bin)
      CODEX_BIN="$2"
      shift
      ;;
    --prompt-file)
      PROMPT_FILE="$2"
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUN_BIN="$(resolve_cmd bun "$ORIGINAL_HOME/.bun/bin/bun")"
GIT_BIN="$(resolve_cmd git)"
NODE_BIN="$(resolve_cmd node)"
export PATH="$(dirname "$BUN_BIN"):$PATH"

resolve_codex_js() {
  find "$PROJECT_ROOT/node_modules" -path '*/@openai/codex/bin/codex.js' | sort | head -n 1
}

declare -a CODEX_CMD=()
if [[ -n "$CODEX_BIN" ]]; then
  if [[ "$CODEX_BIN" == *.js ]]; then
    CODEX_CMD=("$NODE_BIN" "$CODEX_BIN")
  else
    CODEX_CMD=("$CODEX_BIN")
  fi
else
  REPO_CODEX_JS="$(resolve_codex_js)"
  if [[ -n "$REPO_CODEX_JS" ]]; then
    CODEX_CMD=("$NODE_BIN" "$REPO_CODEX_JS")
    CODEX_BIN="$REPO_CODEX_JS"
  elif command -v codex >/dev/null 2>&1; then
    CODEX_CMD=("$(command -v codex)")
    CODEX_BIN="${CODEX_CMD[0]}"
  else
    echo "Could not find a Codex CLI. Install dependencies or pass --codex-bin PATH." >&2
    exit 1
  fi
fi

if [[ -n "$PROMPT_FILE" && ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if [[ -z "$ROOT_DIR" ]]; then
  ROOT_DIR="$(mktemp -d -t plannotator-codex-stop-e2e-XXXXXX)"
else
  mkdir -p "$ROOT_DIR"
  ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
fi

TEMP_HOME="$ROOT_DIR/home"
WORKSPACE_DIR="$ROOT_DIR/workspace/sample-app"
BIN_DIR="$ROOT_DIR/bin"
ARTIFACTS_DIR="$ROOT_DIR/artifacts"
CODEX_LOG="$ARTIFACTS_DIR/codex-output.log"
METADATA_FILE="$ARTIFACTS_DIR/metadata.env"
PROMPT_PATH="$ARTIFACTS_DIR/prompt.txt"
RUNNER_SCRIPT="$BIN_DIR/run-codex-e2e"

cleanup() {
  local exit_code=$?
  echo
  if [[ "$KEEP_SANDBOX" == "true" || $exit_code -ne 0 ]]; then
    echo "Sandbox preserved at: $ROOT_DIR"
    if [[ -f "$METADATA_FILE" ]]; then
      echo "Artifact metadata: $METADATA_FILE"
    fi
    return
  fi
  echo "Cleaning up sandbox: $ROOT_DIR"
  rm -rf "$ROOT_DIR"
}
trap cleanup EXIT

mkdir -p "$TEMP_HOME/.codex" "$WORKSPACE_DIR/src" "$BIN_DIR" "$ARTIFACTS_DIR"

AUTH_SRC="${CODEX_AUTH_JSON:-$ORIGINAL_HOME/.codex/auth.json}"
if [[ ! -f "$AUTH_SRC" ]]; then
  echo "Codex auth file not found: $AUTH_SRC" >&2
  echo "Set CODEX_AUTH_JSON or run codex login first." >&2
  exit 1
fi

cp "$AUTH_SRC" "$TEMP_HOME/.codex/auth.json"
if [[ -f "$ORIGINAL_HOME/.codex/installation_id" ]]; then
  cp "$ORIGINAL_HOME/.codex/installation_id" "$TEMP_HOME/.codex/installation_id"
fi

cat > "$TEMP_HOME/.codex/config.toml" <<'EOF'
[features]
hooks = true
EOF

cat > "$TEMP_HOME/.codex/hooks.json" <<'EOF'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
EOF

cat > "$BIN_DIR/plannotator" <<EOF
#!/bin/sh
export PATH="$(dirname "$BUN_BIN"):\$PATH"
payload_file="$ARTIFACTS_DIR/hook-payload.\$\$.\$(date +%s).json"
cat > "\$payload_file"
{
  printf -- '--- %s ---\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'pid=%s cwd=%s args=%s\\n' "\$\$" "\$(pwd)" "\$*"
  printf 'HOME=%s CODEX_HOME=%s PATH=%s\\n' "\$HOME" "\${CODEX_HOME:-}" "\$PATH"
  cat "\$payload_file"
  printf '\\n'
} >> "$ARTIFACTS_DIR/plannotator-hook-events.log"
PLANNOTATOR_DEBUG=1 exec "$BUN_BIN" run "$PROJECT_ROOT/apps/hook/server/index.ts" "\$@" < "\$payload_file" 2>> "$ARTIFACTS_DIR/plannotator-hook.stderr.log"
EOF
chmod +x "$BIN_DIR/plannotator"

cat > "$WORKSPACE_DIR/package.json" <<'EOF'
{
  "name": "sample-app",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "echo \"No tests yet\""
  }
}
EOF

cat > "$WORKSPACE_DIR/README.md" <<'EOF'
# Sample App

Tiny TypeScript app for exercising Codex plan review through Plannotator.
EOF

cat > "$WORKSPACE_DIR/src/index.ts" <<'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet("World"));
EOF

(
  cd "$WORKSPACE_DIR"
  "$GIT_BIN" init -q -b master
  "$GIT_BIN" config user.email "test@example.com"
  "$GIT_BIN" config user.name "Test User"
  "$GIT_BIN" add -A
  "$GIT_BIN" commit -q -m "Initial commit"
)

if [[ -n "$PROMPT_FILE" ]]; then
  cp "$PROMPT_FILE" "$PROMPT_PATH"
else
  cat > "$PROMPT_PATH" <<'EOF'
Produce a concise implementation plan for adding theme support, tests, and docs to this sample app. Return your final answer ONLY as a <proposed_plan>...</proposed_plan> block and do not implement anything.
EOF
fi

if [[ "$SKIP_BUILD" != "true" ]]; then
  echo "Building hook + review apps..."
  (
    cd "$PROJECT_ROOT"
    "$BUN_BIN" run build:review >/dev/null
    "$BUN_BIN" run build:hook >/dev/null
  )
fi

echo "Recording Codex metadata..."
env HOME="$TEMP_HOME" "${CODEX_CMD[@]}" --version > "$ARTIFACTS_DIR/codex-version.txt" 2>&1
env HOME="$TEMP_HOME" "${CODEX_CMD[@]}" features list > "$ARTIFACTS_DIR/codex-features.txt" 2>&1
env HOME="$TEMP_HOME" "${CODEX_CMD[@]}" login status > "$ARTIFACTS_DIR/codex-login-status.txt" 2>&1 || true

if ! grep -Eq '^hooks[[:space:]]' "$ARTIFACTS_DIR/codex-features.txt"; then
  echo "Selected Codex CLI does not expose hooks." >&2
  echo "See: $ARTIFACTS_DIR/codex-features.txt" >&2
  exit 1
fi

cat > "$METADATA_FILE" <<EOF
ROOT_DIR=$ROOT_DIR
TEMP_HOME=$TEMP_HOME
WORKSPACE_DIR=$WORKSPACE_DIR
BIN_DIR=$BIN_DIR
ARTIFACTS_DIR=$ARTIFACTS_DIR
CODEX_LOG=$CODEX_LOG
PROMPT_FILE=$PROMPT_PATH
PLANNOTATOR_SESSIONS_DIR=$TEMP_HOME/.plannotator/sessions
PLANNOTATOR_HISTORY_DIR=$TEMP_HOME/.plannotator/history
PLANNOTATOR_PLANS_DIR=$TEMP_HOME/.plannotator/plans
CODEX_ROLLOUTS_DIR=$TEMP_HOME/.codex/sessions
CODEX_BIN=$CODEX_BIN
MODEL=$MODEL
SANDBOX_MODE=$SANDBOX_MODE
EOF

PROMPT_CONTENT="$(cat "$PROMPT_PATH")"

{
  echo "#!/bin/bash"
  echo "set -euo pipefail"
  printf 'export HOME=%q\n' "$TEMP_HOME"
  printf 'export CODEX_HOME=%q\n' "$TEMP_HOME/.codex"
  printf 'export PATH=%q\n' "$BIN_DIR:$PATH"
  printf 'cd %q\n' "$WORKSPACE_DIR"
  printf 'PROMPT_CONTENT="$(cat %q)"\n' "$PROMPT_PATH"
  printf 'exec '
  printf '%q ' "${CODEX_CMD[@]}"
  printf 'exec --enable hooks -m %q -s %q -C %q "$PROMPT_CONTENT"\n' "$MODEL" "$SANDBOX_MODE" "$WORKSPACE_DIR"
} > "$RUNNER_SCRIPT"
chmod +x "$RUNNER_SCRIPT"

echo "=== Plannotator Codex Stop-hook E2E ==="
echo "Sandbox root: $ROOT_DIR"
echo "Workspace:    $WORKSPACE_DIR"
echo "Artifacts:    $ARTIFACTS_DIR"
echo "Codex binary: $CODEX_BIN"
echo "Model:        $MODEL"
echo

if [[ "$SETUP_ONLY" == "true" ]]; then
  echo "Setup complete. Codex was not started."
  echo
  echo "To run the isolated Codex command manually:"
  echo "  $RUNNER_SCRIPT"
  echo
  echo "Or enter the isolated workspace yourself:"
  echo "  export HOME=\"$TEMP_HOME\""
  echo "  export CODEX_HOME=\"$TEMP_HOME/.codex\""
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo "  cd \"$WORKSPACE_DIR\""
  echo
  echo "Then run Codex however you want. The sandbox will be preserved."
  exit 0
fi

if [[ "$DETACH" == "true" ]]; then
  nohup "$RUNNER_SCRIPT" >"$CODEX_LOG" 2>&1 < /dev/null &
else
  "$RUNNER_SCRIPT" >"$CODEX_LOG" 2>&1 &
fi
CODEX_PID=$!
echo "$CODEX_PID" > "$ARTIFACTS_DIR/codex.pid"

read_json_field() {
  "$NODE_BIN" -e 'const fs=require("fs"); const [file,key]=process.argv.slice(1); const data=JSON.parse(fs.readFileSync(file,"utf8")); const value=data[key]; if (value !== undefined) process.stdout.write(String(value));' "$1" "$2"
}

FIRST_SESSION_FILE=""
FIRST_SESSION_URL=""
deadline=$((SECONDS + 240))
while (( SECONDS < deadline )); do
  if compgen -G "$TEMP_HOME/.plannotator/sessions/*.json" >/dev/null; then
    FIRST_SESSION_FILE="$(find "$TEMP_HOME/.plannotator/sessions" -maxdepth 1 -type f -name '*.json' | sort | tail -n 1)"
    FIRST_SESSION_URL="$(read_json_field "$FIRST_SESSION_FILE" url)"
    echo "$FIRST_SESSION_FILE" > "$ARTIFACTS_DIR/first-session-file.txt"
    printf '%s\n' "$FIRST_SESSION_URL" > "$ARTIFACTS_DIR/first-session-url.txt"
    echo "First Plannotator session: $FIRST_SESSION_URL"
    break
  fi
  if ! kill -0 "$CODEX_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$DETACH" == "true" ]]; then
  echo
  echo "Codex is still running in the background."
  echo "PID:          $CODEX_PID"
  echo "Codex log:    $CODEX_LOG"
  echo "Metadata:     $METADATA_FILE"
  echo
  echo "To inspect active Plannotator sessions inside the sandbox:"
  echo "  HOME=\"$TEMP_HOME\" PATH=\"$BIN_DIR:\$PATH\" plannotator sessions"
  exit 0
fi

set +e
wait "$CODEX_PID"
CODEX_EXIT=$?
set -e
printf '%s\n' "$CODEX_EXIT" > "$ARTIFACTS_DIR/codex-exit-code.txt"

ROLLOUT_PATH="$(find "$TEMP_HOME/.codex/sessions" -type f -name 'rollout-*.jsonl' | sort | tail -n 1 || true)"
if [[ -n "$ROLLOUT_PATH" ]]; then
  printf '%s\n' "$ROLLOUT_PATH" > "$ARTIFACTS_DIR/rollout-path.txt"
fi

if [[ -d "$TEMP_HOME/.plannotator/history" ]]; then
  find "$TEMP_HOME/.plannotator/history" -type f | sort > "$ARTIFACTS_DIR/plannotator-history-files.txt"
fi

if [[ -d "$TEMP_HOME/.plannotator/plans" ]]; then
  find "$TEMP_HOME/.plannotator/plans" -type f | sort > "$ARTIFACTS_DIR/plannotator-plan-files.txt"
fi

echo
echo "Codex exit code: $CODEX_EXIT"
echo "Codex log:       $CODEX_LOG"
if [[ -n "$ROLLOUT_PATH" ]]; then
  echo "Rollout:         $ROLLOUT_PATH"
fi
if [[ -f "$ARTIFACTS_DIR/plannotator-history-files.txt" ]]; then
  echo "History index:   $ARTIFACTS_DIR/plannotator-history-files.txt"
fi
if [[ -f "$ARTIFACTS_DIR/plannotator-plan-files.txt" ]]; then
  echo "Plan index:      $ARTIFACTS_DIR/plannotator-plan-files.txt"
fi

exit "$CODEX_EXIT"
