#!/bin/bash
# Integration test for session discovery and --browser flag (PR #242)
#
# Usage:
#   ./test-sessions.sh [--skip-build]
#
# Automated tests (no browser interaction needed):
#   - Session registration (plan + review servers write session files)
#   - Session file content (all fields: pid, port, url, mode, project, startedAt, label)
#   - `plannotator sessions` listing
#   - `plannotator sessions --open` (reopen URL — uses /usr/bin/true as browser)
#   - `plannotator sessions --clean` (explicit stale cleanup)
#   - Stale session auto-cleanup via listing
#   - Session file removal after server exits
#
# Manual test (not covered here):
#   - `--browser "Google Chrome"` actually opening in Chrome
#     Run: echo '{"tool_input":{"plan":"# Test"}}' | bun run apps/hook/server/index.ts --browser "Google Chrome"

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SESSIONS_DIR="$HOME/.plannotator/sessions"
PASS=0
FAIL=0
BG_PIDS=""

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  for pid in $BG_PIDS; do
    kill "$pid" 2>/dev/null && echo "Killed leftover process $pid" || true
  done
  rm -f "$SESSIONS_DIR/99999999.json" 2>/dev/null || true
  echo ""
  if [[ $FAIL -eq 0 ]]; then
    echo "=== ALL $PASS TESTS PASSED ==="
  else
    echo "=== $PASS passed, $FAIL FAILED ==="
    exit 1
  fi
}
trap cleanup EXIT

pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL: $1"
}

# Snapshot session files, returning sorted list
snapshot_sessions() {
  ls "$SESSIONS_DIR"/*.json 2>/dev/null | sort || true
}

# Find new session files by diffing two snapshots
new_sessions() {
  comm -13 <(echo "$1") <(echo "$2")
}

# Read a field from a session JSON file
session_field() {
  python3 -c "import json; print(json.load(open('$1'))['$2'])"
}

# Wait for a new session file to appear (up to N seconds)
wait_for_new_session() {
  local before="$1"
  local timeout="${2:-10}"
  local elapsed=0
  while true; do
    local now
    now=$(snapshot_sessions)
    local added
    added=$(new_sessions "$before" "$now")
    if [[ -n "$added" ]]; then
      echo "$added" | head -1
      return 0
    fi
    sleep 0.5
    elapsed=$(echo "$elapsed + 0.5" | bc)
    if (( $(echo "$elapsed >= $timeout" | bc -l) )); then
      return 1
    fi
  done
}

# Helper to run the CLI entry point
run_cli() {
  bun run "$PROJECT_ROOT/apps/hook/server/index.ts" "$@"
}

echo "=== Session Discovery Integration Test ==="
echo ""

# -------------------------------------------------------
# Step 0: Build
# -------------------------------------------------------
if [[ "${1:-}" != "--skip-build" ]]; then
  echo "--- Building ---"
  cd "$PROJECT_ROOT"
  bun run build:hook 2>&1 | tail -1
  bun run build:hook 2>&1 | tail -1
  echo ""
else
  echo "--- Skipping build (--skip-build) ---"
  cd "$PROJECT_ROOT"
  echo ""
fi

mkdir -p "$SESSIONS_DIR"

# -------------------------------------------------------
# Step 1: Clean slate
# -------------------------------------------------------
echo "--- Step 1: Clean slate ---"
BEFORE=$(snapshot_sessions)
EXISTING_COUNT=$(echo "$BEFORE" | grep -c ".json" || echo 0)
echo "  Existing session files: $EXISTING_COUNT"
echo ""

# -------------------------------------------------------
# Step 2: Launch plan server, validate session file content
# -------------------------------------------------------
echo "--- Step 2: Launch plan server + validate session content ---"

PLAN_JSON='{"tool_input":{"plan":"# Test Plan\n\nThis is a test."}}'

echo "$PLAN_JSON" | PLANNOTATOR_BROWSER="/usr/bin/true" \
  run_cli > /dev/null &
PLAN_BG_PID=$!
BG_PIDS="$BG_PIDS $PLAN_BG_PID"

PLAN_SESSION=$(wait_for_new_session "$BEFORE" 10) || true

if [[ -n "$PLAN_SESSION" && -f "$PLAN_SESSION" ]]; then
  pass "Plan session file created"

  # Validate all fields
  PLAN_PORT=$(session_field "$PLAN_SESSION" port)
  PLAN_URL=$(session_field "$PLAN_SESSION" url)
  PLAN_MODE=$(session_field "$PLAN_SESSION" mode)
  PLAN_PID=$(session_field "$PLAN_SESSION" pid)
  PLAN_PROJECT=$(session_field "$PLAN_SESSION" project)
  PLAN_STARTED=$(session_field "$PLAN_SESSION" startedAt)
  PLAN_LABEL=$(session_field "$PLAN_SESSION" label)

  [[ "$PLAN_MODE" == "plan" ]] && pass "mode = 'plan'" || fail "mode should be 'plan', got '$PLAN_MODE'"
  [[ "$PLAN_URL" == "http://localhost:$PLAN_PORT" ]] && pass "url matches port" || fail "url '$PLAN_URL' doesn't match port $PLAN_PORT"
  [[ "$PLAN_PID" =~ ^[0-9]+$ ]] && pass "pid is numeric ($PLAN_PID)" || fail "pid is not numeric: '$PLAN_PID'"
  [[ -n "$PLAN_PROJECT" ]] && pass "project is set ($PLAN_PROJECT)" || fail "project is empty"
  [[ "$PLAN_STARTED" =~ ^20[0-9]{2}- ]] && pass "startedAt is ISO date" || fail "startedAt not ISO: '$PLAN_STARTED'"
  [[ "$PLAN_LABEL" == plan-* ]] && pass "label starts with 'plan-'" || fail "label should start with 'plan-', got '$PLAN_LABEL'"
else
  fail "Plan session file not created"
  PLAN_PORT=""
  PLAN_SESSION=""
fi

AFTER_PLAN=$(snapshot_sessions)
echo ""

# -------------------------------------------------------
# Step 3: Launch review server, validate session file content
# -------------------------------------------------------
echo "--- Step 3: Launch review server + validate session content ---"

PLANNOTATOR_BROWSER="/usr/bin/true" \
  run_cli review > /dev/null &
REVIEW_BG_PID=$!
BG_PIDS="$BG_PIDS $REVIEW_BG_PID"

REVIEW_SESSION=$(wait_for_new_session "$AFTER_PLAN" 10) || true

if [[ -n "$REVIEW_SESSION" && -f "$REVIEW_SESSION" ]]; then
  pass "Review session file created"

  REVIEW_PORT=$(session_field "$REVIEW_SESSION" port)
  REVIEW_MODE=$(session_field "$REVIEW_SESSION" mode)
  REVIEW_LABEL=$(session_field "$REVIEW_SESSION" label)

  [[ "$REVIEW_MODE" == "review" ]] && pass "mode = 'review'" || fail "mode should be 'review', got '$REVIEW_MODE'"
  [[ "$REVIEW_LABEL" == review-* ]] && pass "label starts with 'review-'" || fail "label should start with 'review-', got '$REVIEW_LABEL'"
else
  fail "Review session file not created"
  REVIEW_PORT=""
  REVIEW_SESSION=""
fi

echo ""

# -------------------------------------------------------
# Step 4: Test `plannotator sessions` listing
# -------------------------------------------------------
echo "--- Step 4: Test sessions listing ---"

SESSIONS_OUTPUT=$(run_cli sessions 2>&1 || true)
echo "$SESSIONS_OUTPUT" | head -10

# Check both modes appear in listing with their ports
if echo "$SESSIONS_OUTPUT" | grep -q "plan.*localhost"; then
  pass "Listing shows plan session with URL"
else
  fail "Listing missing plan session"
fi

if echo "$SESSIONS_OUTPUT" | grep -q "review.*localhost"; then
  pass "Listing shows review session with URL"
else
  fail "Listing missing review session"
fi

if echo "$SESSIONS_OUTPUT" | grep -q "Reopen with"; then
  pass "Listing shows --open hint"
else
  fail "Listing missing --open hint"
fi

echo ""

# -------------------------------------------------------
# Step 5: Test `sessions --open`
# -------------------------------------------------------
echo "--- Step 5: Test sessions --open ---"

# Use PLANNOTATOR_BROWSER=/usr/bin/true so --open doesn't actually open a browser.
# We just need it to not error out.
OPEN_OUTPUT=$(PLANNOTATOR_BROWSER="/usr/bin/true" run_cli sessions --open 2>&1 || true)

if echo "$OPEN_OUTPUT" | grep -q "Opened.*session in browser"; then
  pass "sessions --open reports success"
else
  fail "sessions --open didn't report opening (output: $OPEN_OUTPUT)"
fi

# Test --open with explicit index
OPEN_2_OUTPUT=$(PLANNOTATOR_BROWSER="/usr/bin/true" run_cli sessions --open 2 2>&1 || true)

if echo "$OPEN_2_OUTPUT" | grep -q "Opened.*session in browser"; then
  pass "sessions --open 2 reports success"
else
  fail "sessions --open 2 didn't report opening (output: $OPEN_2_OUTPUT)"
fi

# Test --open with out-of-range index
OPEN_BAD_OUTPUT=$(PLANNOTATOR_BROWSER="/usr/bin/true" run_cli sessions --open 99 2>&1 || true)

if echo "$OPEN_BAD_OUTPUT" | grep -q "not found"; then
  pass "sessions --open 99 reports not found"
else
  fail "sessions --open 99 should report not found (output: $OPEN_BAD_OUTPUT)"
fi

echo ""

# -------------------------------------------------------
# Step 6: Test stale session cleanup (auto + --clean)
# -------------------------------------------------------
echo "--- Step 6: Test stale session cleanup ---"

mkdir -p "$SESSIONS_DIR"
cat > "$SESSIONS_DIR/99999999.json" << 'STALE_EOF'
{
  "pid": 99999999,
  "port": 11111,
  "url": "http://localhost:11111",
  "mode": "plan",
  "project": "fake-project",
  "startedAt": "2020-01-01T00:00:00.000Z",
  "label": "stale-test"
}
STALE_EOF

if [[ -f "$SESSIONS_DIR/99999999.json" ]]; then
  pass "Stale session file created for dead PID"
else
  fail "Could not create stale session file"
fi

# Listing auto-cleans stale entries
run_cli sessions 2>&1 >/dev/null || true
sleep 0.5

if [[ ! -f "$SESSIONS_DIR/99999999.json" ]]; then
  pass "Stale file auto-cleaned by sessions listing"
else
  fail "Stale file NOT auto-cleaned by listing"
fi

# Re-create and test explicit --clean flag
cat > "$SESSIONS_DIR/99999999.json" << 'STALE_EOF'
{
  "pid": 99999999,
  "port": 11111,
  "url": "http://localhost:11111",
  "mode": "plan",
  "project": "fake-project",
  "startedAt": "2020-01-01T00:00:00.000Z",
  "label": "stale-test-2"
}
STALE_EOF

CLEAN_OUTPUT=$(run_cli sessions --clean 2>&1 || true)

if [[ ! -f "$SESSIONS_DIR/99999999.json" ]]; then
  pass "sessions --clean removed stale file"
else
  fail "sessions --clean did NOT remove stale file"
fi

if echo "$CLEAN_OUTPUT" | grep -q "Cleaned up"; then
  pass "sessions --clean reports cleanup"
else
  fail "sessions --clean didn't report cleanup (output: $CLEAN_OUTPUT)"
fi

echo ""

# -------------------------------------------------------
# Step 7: Approve/submit servers, verify session cleanup on exit
# -------------------------------------------------------
echo "--- Step 7: Approve servers and verify cleanup ---"

if [[ -n "${PLAN_PORT:-}" ]]; then
  echo "  Approving plan server on port $PLAN_PORT..."
  curl -sf -X POST "http://localhost:$PLAN_PORT/api/approve" \
    -H "Content-Type: application/json" \
    -d '{"planSave":false}' >/dev/null 2>&1 || echo "  (approve failed — server may have exited)"
fi

if [[ -n "${REVIEW_PORT:-}" ]]; then
  echo "  Submitting feedback to review server on port $REVIEW_PORT..."
  curl -sf -X POST "http://localhost:$REVIEW_PORT/api/feedback" \
    -H "Content-Type: application/json" \
    -d '{"feedback":"LGTM"}' >/dev/null 2>&1 || echo "  (feedback failed — server may have exited)"
fi

# Wait for servers to shut down
sleep 3

if [[ -n "${PLAN_SESSION:-}" ]]; then
  if [[ ! -f "$PLAN_SESSION" ]]; then
    pass "Plan session cleaned up after exit"
  else
    fail "Plan session file still exists after exit"
  fi
fi

if [[ -n "${REVIEW_SESSION:-}" ]]; then
  if [[ ! -f "$REVIEW_SESSION" ]]; then
    pass "Review session cleaned up after exit"
  else
    fail "Review session file still exists after exit"
  fi
fi

BG_PIDS=""
echo ""
