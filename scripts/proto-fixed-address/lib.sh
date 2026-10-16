# shellcheck shell=bash
# PROTOTYPE (proto/inbox-fixed-address): shared paths for the owner's scripts.
# Sourced by try-on-this-mac.sh, checklist.sh and undo.sh. Never touches the
# real Inbox (port 59812, ~/.plannotator): every Plannotator command here runs
# with PLANNOTATOR_DATA_DIR pointed at the scratch folder below.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# A fixed scratch folder, so the checklist and the undo find what the try made.
SCRATCH="${PROTO_SCRATCH:-${TMPDIR:-/tmp}/plannotator-proto-fixed-address}"
SCRATCH="${SCRATCH%/}"
DATA="$SCRATCH/data"
REAL_INBOX_PORT="${REAL_INBOX_PORT:-59812}"
NAME_HOST="inbox.plannotator.localhost"
NAME_URL="http://$NAME_HOST"
PORTLESS_STATE="$HOME/.portless"
PORTLESS_PLIST="/Library/LaunchDaemons/sh.portless.proxy.plist"
PORTLESS_CA_NAME="portless Local CA"
# The CA the earlier HTTPS try made (the plain-HTTP flow makes none), kept by fingerprint so undo removes only it.
CA_RECORD="$SCRATCH/portless-ca.sha1"

# The scratch Inbox's environment: scratch data dir, no agent connecting, no
# note dialog (it would offer to write into the person's real agent files),
# and the prototype switched on.
scratch_env() {
  env PLANNOTATOR_DATA_DIR="$DATA" \
    PLANNOTATOR_INBOX_CONNECT=0 \
    PLANNOTATOR_INBOX_NOTES=0 \
    PLANNOTATOR_PROTO_FIXED_ADDRESS=1 \
    PLANNOTATOR_UPDATE_CHECK=0 \
    PLANNOTATOR_AUTO_UPDATE=0 \
    "$@"
}

# `plannotator ...` from this checkout, against the scratch data dir only.
pn() {
  scratch_env bun "$REPO/apps/hook/server/index.ts" "$@"
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASSES=$((${PASSES:-0} + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((${FAILS:-0} + 1)); }
note() { printf '  \033[33mNOTE\033[0m %s\n' "$*"; }

# Who answers on 127.0.0.1:<port> as portless (X-Portless), without following a redirect.
portless_on() {
  curl -s -o /dev/null -D - --max-time 2 -H "Host: $NAME_HOST" "http://127.0.0.1:$1/" 2>/dev/null | grep -qi '^x-portless'
}

# A JSON field from stdin, with Node (present: portless needs it anyway).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{}})' "$1"
}

scratch_registry() { cat "$DATA/inbox/inbox.json" 2>/dev/null; }
scratch_port() { scratch_registry | json_field port; }
scratch_session() { scratch_registry | json_field serverSession; }
scratch_token() { scratch_registry | json_field token; }

# The real Inbox's serverSession, read over HTTP only (no file under ~/.plannotator is opened).
real_inbox_session() {
  curl -s --max-time 3 "http://127.0.0.1:$REAL_INBOX_PORT/api/inbox/health" | json_field serverSession
}

# Stop the scratch Inbox through its own token-guarded stop route (never a signal by pid).
stop_scratch_inbox() {
  local port token
  port="$(scratch_port)"
  token="$(scratch_token)"
  [ -n "$port" ] && [ -n "$token" ] || return 0
  [ "$port" = "$REAL_INBOX_PORT" ] && { echo "refusing: the scratch registry names the real Inbox's port" >&2; return 1; }
  curl -s --max-time 5 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}' \
    "http://127.0.0.1:$port/api/inbox/control/stop" >/dev/null || true
  for _ in $(seq 1 30); do
    curl -s --max-time 1 "http://127.0.0.1:$port/api/inbox/health" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
}
