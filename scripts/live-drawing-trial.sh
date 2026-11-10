#!/bin/sh
# Start the live-drawing prototype's trial Inbox (scripts/live-drawing-trial.ts)
# in a scratch world under /tmp: its own data dir and HOME, so the person's own
# Inbox, config and agents are never read or written.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
world=/tmp/plannotator-live-drawing-trial
mkdir -p "$world/home" "$world/data"

HOME="$world/home" \
PLANNOTATOR_DATA_DIR="$world/data" \
PLANNOTATOR_TEST_SANDBOX=1 \
  exec bun "$root/scripts/live-drawing-trial.ts"
