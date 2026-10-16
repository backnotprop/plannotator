#!/usr/bin/env bash
# PROTOTYPE (proto/inbox-fixed-address): start a SCRATCH Inbox with the
# fixed-address prototype on, and open it, so you can click "Sure".
#
#   bash scripts/proto-fixed-address/try-on-this-mac.sh
#
# What it does, and what it never does:
#  - Builds this checkout's Inbox window (bun install, review + hook builds).
#  - Starts an Inbox from this checkout with a temp data dir
#    ($TMPDIR/plannotator-proto-fixed-address/data). It never reads or writes
#    ~/.plannotator, and never touches your real Inbox on port 59812.
#  - Opens it in your default browser. Nothing privileged runs until YOU click
#    Sure: then macOS asks for your password once (the dialog's title says
#    "osascript"; the reason line names Plannotator). That one prompt installs
#    portless's plain-HTTP proxy on port 80 and, when the earlier HTTPS try's
#    service is still installed, replaces it. No certificate is made or trusted.
#  - Records what was there before (Tailscale serve, the real Inbox's session),
#    so checklist.sh can show nothing else changed.
# Then run:  bash scripts/proto-fixed-address/checklist.sh
# To put the Mac back:  bash scripts/proto-fixed-address/undo.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ "$(uname)" = "Darwin" ] || { echo "This recipe is for macOS. Linux/Windows: see scripts/proto-fixed-address/README.md." >&2; exit 2; }
command -v bun >/dev/null || { echo "bun is required." >&2; exit 2; }
NODE_VERSION="$(node --version 2>/dev/null || true)"
case "$NODE_VERSION" in
  v2[4-9].*|v[3-9][0-9].*) ;;
  *) echo "Node 24+ is required on PATH (portless runs on it); found: ${NODE_VERSION:-none}." >&2; exit 2 ;;
esac

# Safety: undo.sh removes portless's service, CA and ~/.portless wholesale, so
# this recipe only runs on a Mac where portless was never set up.
if [ -e "$PORTLESS_STATE" ] || [ -e "$PORTLESS_PLIST" ]; then
  if [ ! -f "$SCRATCH/made-by-try" ]; then
    echo "portless is already set up on this Mac ($PORTLESS_STATE or $PORTLESS_PLIST exists)." >&2
    echo "This recipe's undo would remove it, so it stops here. Remove it yourself first, or test in a VM." >&2
    exit 2
  fi
fi

say "1/4 Building the Inbox window from this checkout (a few minutes the first time)"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$REPO" && bun install >/dev/null && bun run --cwd apps/review build >/dev/null && bun run build:hook >/dev/null)
fi
[ -f "$REPO/apps/hook/dist/inbox.html" ] || { echo "Build failed: apps/hook/dist/inbox.html is missing." >&2; exit 1; }

say "2/4 Recording what is there before"
mkdir -p "$SCRATCH"
touch "$SCRATCH/made-by-try"
REAL_BEFORE="$(real_inbox_session || true)"
printf '%s\n' "$REAL_BEFORE" > "$SCRATCH/real-inbox-session.before"
echo "  real Inbox on :$REAL_INBOX_PORT: ${REAL_BEFORE:-not running}"
if command -v tailscale >/dev/null; then
  tailscale serve status --json > "$SCRATCH/tailscale-serve.before.json" 2>/dev/null || true
  echo "  tailscale serve config saved ($(wc -c < "$SCRATCH/tailscale-serve.before.json" | tr -d ' ') bytes)"
fi
# The earlier HTTPS try left a CA; remember its fingerprint so undo.sh removes exactly that one.
if [ -f "$PORTLESS_STATE/ca.pem" ] && [ ! -s "$CA_RECORD" ]; then
  openssl x509 -in "$PORTLESS_STATE/ca.pem" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g' > "$CA_RECORD" || true
  echo "  the earlier try's CA (no longer used): $(cat "$CA_RECORD")"
fi
if portless_on 443; then echo "  the earlier HTTPS proxy answers on 443; Sure replaces it with the HTTP one (same single prompt)"; fi
if ! portless_on 80 && curl -s -o /dev/null --max-time 2 "http://127.0.0.1:80/" 2>/dev/null; then
  echo "  note: another program answers on port 80; Sure will say so and change nothing"
fi

say "3/4 Starting the scratch Inbox (data: $DATA)"
stop_scratch_inbox || true
# Offer the one-time dialog again (scratch data only): a retry starts from "off".
rm -f "$DATA/inbox/name.json"
URL="$(cd "$SCRATCH" && pn inbox --background)"
PORT="$(scratch_port)"
[ "$PORT" != "$REAL_INBOX_PORT" ] || { echo "The scratch Inbox took the real Inbox's port; refusing." >&2; stop_scratch_inbox; exit 1; }
echo "  $URL (port $PORT, log: $DATA/inbox/inbox.log)"
pn inbox --name status 2>/dev/null | json_field status | sed 's/^/  fixed address: /'
echo

say "4/4 Opening it"
open "$URL"
cat <<EOF

  In the browser tab that just opened:
    1. Wait for the dialog "Give the Inbox a fixed address" (a few seconds;
       or Settings → Devices → Fixed address → Turn on).
    2. Click Sure. macOS asks for your password once ("osascript wants to
       make changes"). Nothing else asks.
    3. The tab moves to $NAME_URL by itself.

  Then:   bash scripts/proto-fixed-address/checklist.sh
  Undo:   bash scripts/proto-fixed-address/undo.sh
EOF
