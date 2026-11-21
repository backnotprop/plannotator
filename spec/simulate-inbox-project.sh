#!/usr/bin/env bash
# Random simulation of spec/inbox-project.qnt: every property against main
# before the fix (onMain), the fix (onFix) and the fix with its /cd switch off
# (onFixStartOnly). Prints one line per (instance, property).
#
#   bash spec/simulate-inbox-project.sh
#   SAMPLES=200000 STEPS=40 bash spec/simulate-inbox-project.sh
set -u
cd "$(dirname "$0")"
SAMPLES="${SAMPLES:-50000}"
STEPS="${STEPS:-30}"
BACKEND="${BACKEND:-rust}"
INSTANCES="${INSTANCES:-onMain onFix onFixStartOnly}"
PROPERTIES="${PROPERTIES:-OneProjectPerSession NewMessageAgreesWithSend NoProjectFromCd AttachmentsWhereAgentWorks ReadMakesNoProject NamedProjectHonoured}"
for instance in $INSTANCES; do
  for property in $PROPERTIES; do
    result=$(quint run --main "$instance" --backend "$BACKEND" --max-samples "$SAMPLES" --max-steps "$STEPS" \
      --invariant "$property" inbox-project.qnt 2>&1 | grep -E '^\[(ok|violation)\]|error:' | head -1)
    printf '%-15s %-28s %s\n' "$instance" "$property" "$result"
  done
done
