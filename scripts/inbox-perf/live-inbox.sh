#!/bin/sh
# Starts ONE sandboxed Inbox for the live baseline (scripts/inbox-perf/live.ts runs it).
#
#   /bin/sh scripts/inbox-perf/live-inbox.sh <repo> <data dir> <scratch dir>
#
# `env -i` with every variable spelled out: nothing of the caller's environment
# reaches the Inbox. HOME, the agent homes and the config dirs are inside the
# scratch dir; PATH holds only <scratch>/bin (a link to bun) and the system
# folders, so no agent CLI can be found or started. Never run it on a data dir
# that is not a scratch copy.
set -eu
REPO="$1"
DATA="$2"
SCRATCH="$3"
case "$DATA" in
  /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;;
  *) echo "live-inbox.sh: refusing data dir $DATA (not a scratch folder)" >&2; exit 2 ;;
esac
exec /usr/bin/env -i \
  HOME="$SCRATCH/home" \
  PATH="$SCRATCH/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  PLANNOTATOR_DATA_DIR="$DATA" \
  PLANNOTATOR_INBOX_CONNECT=0 \
  PLANNOTATOR_UPDATE_CHECK=0 \
  PLANNOTATOR_BROWSER=/usr/bin/true \
  NO_BROWSER=1 \
  NO_ANON_PING=1 \
  PLANNOTATOR_INBOX_NOTES=0 \
  PLANNOTATOR_TEST_SANDBOX=1 \
  PLANNOTATOR_RELAY_URL=http://127.0.0.1:9 \
  PLANNOTATOR_INBOX_DEBUG=1 \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_TERMINAL_PROMPT=0 \
  GCM_INTERACTIVE=never \
  GH_CONFIG_DIR="$SCRATCH/gh" \
  GH_TOKEN=sandbox-not-a-token \
  GH_ENTERPRISE_TOKEN=sandbox-not-a-token \
  GH_PROMPT_DISABLED=1 \
  GH_NO_UPDATE_NOTIFIER=1 \
  XDG_CONFIG_HOME="$SCRATCH/xdg" \
  CODEX_HOME="$SCRATCH/codex" \
  "$SCRATCH/bin/bun" "$REPO/apps/hook/server/index.ts" inbox --no-open
