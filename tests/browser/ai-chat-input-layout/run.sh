#!/usr/bin/env bash
# Browser regression for the completed-response layout in DocumentAIChatPanel.
# The textarea must remain inside the fixed-height sidebar before and after the
# first response becomes long enough to overflow the message viewport.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${AI_CHAT_LAYOUT_TEST_PORT:-41973}"
HOOK_DIR="$ROOT/apps/hook"
TEST_DIR="$ROOT/tests/browser/ai-chat-input-layout"
TMP_HTML="$HOOK_DIR/.ai-chat-layout-test.html"
TMP_TSX="$HOOK_DIR/.ai-chat-layout-test.tsx"
SERVER_LOG="$(mktemp)"
BROWSER_OUTPUT=""

find_chrome() {
  if [[ -n "${CHROME_BIN:-}" && -x "$CHROME_BIN" ]]; then printf '%s' "$CHROME_BIN"; return; fi
  local mac_chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$mac_chrome" ]]; then printf '%s' "$mac_chrome"; return; fi
  local candidate
  for candidate in google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return; fi
  done
  return 1
}

CHROME="$(find_chrome || true)"
if [[ -z "$CHROME" ]]; then
  echo "Chrome/Chromium not found (set CHROME_BIN to run this browser regression)." >&2
  exit 1
fi

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$TMP_HTML" "$TMP_TSX" "$SERVER_LOG"
  if [[ -n "$BROWSER_OUTPUT" ]]; then
    rm -f "$BROWSER_OUTPUT"
  fi
}
trap cleanup EXIT
cp "$TEST_DIR/fixture.html" "$TMP_HTML"
cp "$TEST_DIR/fixture.tsx" "$TMP_TSX"

bun run --cwd "$HOOK_DIR" vite --host 127.0.0.1 --port "$PORT" --strictPort >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in {1..100}; do
  if curl -sf "http://127.0.0.1:$PORT/.ai-chat-layout-test.html" >/dev/null; then break; fi
  sleep 0.05
done
if ! curl -sf "http://127.0.0.1:$PORT/.ai-chat-layout-test.html" >/dev/null; then
  cat "$SERVER_LOG" >&2
  exit 1
fi

check_state() {
  local state="$1"
  local result metrics
  BROWSER_OUTPUT="$(mktemp)"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=400,700 --virtual-time-budget=1500 --dump-dom \
    "http://127.0.0.1:$PORT/.ai-chat-layout-test.html?state=$state" >"$BROWSER_OUTPUT" 2>/dev/null
  result="$(grep -o 'data-verdict="[A-Z]*"' "$BROWSER_OUTPUT" | head -1 || true)"
  metrics="$(grep -o 'data-metrics="[^"]*"' "$BROWSER_OUTPUT" | head -1 || true)"
  rm -f "$BROWSER_OUTPUT"
  BROWSER_OUTPUT=""
  echo "$state: $result $metrics"
  [[ "$result" == 'data-verdict="PASS"' ]]
}

check_state streaming
check_state completed
