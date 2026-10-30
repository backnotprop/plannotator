#!/usr/bin/env bash
# Random simulation of spec/update-lifecycle.qnt: every property against the
# code on main, on PR #2337 (with and without its draft release flow, and with
# the F2-F4 fix), and with the Windows replace. Prints one line per (instance, property).
#
#   bash spec/simulate.sh                 # 300k samples x 40 steps each
#   SAMPLES=50000 STEPS=30 bash spec/simulate.sh
#   TRACES=/tmp/traces bash spec/simulate.sh   # keep each violation's trace (ITF)
#   bun spec/show-trace.ts /tmp/traces/onMain-WhatsNewWithinRun.itf.json
#
# Uses Quint's rust simulator (BACKEND=typescript for the slower one). No
# Apalache: `quint verify` is not run here.
set -u
cd "$(dirname "$0")"
SAMPLES="${SAMPLES:-300000}"
STEPS="${STEPS:-40}"
BACKEND="${BACKEND:-rust}"
TRACES="${TRACES:-}"
[ -n "$TRACES" ] && mkdir -p "$TRACES"

INSTANCES="${INSTANCES:-onMain onFix onWhatsNewFix onFixDraft onWindows}"
PROPERTIES="${PROPERTIES:-NoTwoInstallers BinaryAlwaysThere InboxCanStart NothingFetchedWhileChecksOff RequestRateBounded StaleLockRecovered PersonCanUpdate WhatsNewWithinRun WhatsNewAfterAbandonedRequest WhatsNewAfterBlip WhatsNewAfterUpdate NewReleaseOffered NewReleaseOfferedAfterAbandonedCheck FailedUpdateShown}"

for instance in $INSTANCES; do
  for property in $PROPERTIES; do
    out=()
    [ -n "$TRACES" ] && out=(--out-itf "$TRACES/$instance-$property.itf.json")
    result=$(quint run --main "$instance" --backend "$BACKEND" --max-samples "$SAMPLES" --max-steps "$STEPS" \
      --invariant "$property" "${out[@]}" update-lifecycle.qnt 2>&1 | grep -E '^\[(ok|violation)\]|error:' | head -1)
    printf '%-11s %-30s %s\n' "$instance" "$property" "$result"
  done
done
