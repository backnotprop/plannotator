#!/usr/bin/env bash
# The agents' marks in the iPhone app are the product's own icon files (.github/assets/icons: the ones the README
# shows), copied into an asset catalog, one image set per agent id (`agent-claude-code`), so Swift finds a mark by
# the id the wire carries and never draws its own. The app asks the catalog which agents have a mark; there is no
# second list in Swift.
#
#   bash apps/mobile/ios/agent-marks.sh           copy the icons into App/AgentMarks.xcassets
#   bash apps/mobile/ios/agent-marks.sh --check   fail when a committed file differs from its source
#
# .github/workflows/mobile-ios.yml runs the check (through ci.sh) and starts for a change under
# .github/assets/icons, so an icon that changes cannot leave the app's copy behind unseen. Nothing else in CI
# reads the icons: a pull request that changes only an icon still runs no Inbox test.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
icons="$here/../../../.github/assets/icons"
catalog="$here/App/AgentMarks.xcassets"
check=0
[ "${1:-}" = "--check" ] && check=1

# agent id, its icon, and (when it has one) the icon for a dark ground.
marks="claude-code claude.svg
codex codex.png
gemini gemini.png
amp amp.svg
kiro kiro.svg
opencode opencode-light.svg opencode-dark.svg
pi pi-light.svg pi-dark.svg"

if [ "$check" = 1 ] && [ ! -d "$catalog" ]; then
  echo "agent-marks: no catalog yet, nothing to check."
  exit 0
fi

stale=0
put() { # put <source file> <target path>
  if [ "$check" = 1 ]; then
    if ! cmp -s "$1" "$2"; then echo "agent-marks: stale: ${2#"$here/"}" >&2; stale=1; fi
  else
    mkdir -p "$(dirname "$2")"
    cmp -s "$1" "$2" || { cp "$1" "$2"; echo "wrote ${2#"$here/"}"; }
  fi
}

tmp=$(mktemp -d)
printf '{\n  "info": {\n    "author": "xcode",\n    "version": 1\n  }\n}\n' > "$tmp/root.json"
put "$tmp/root.json" "$catalog/Contents.json"

while read -r agent light dark; do
  set="$catalog/agent-$agent.imageset"
  put "$icons/$light" "$set/$light"
  {
    printf '{\n  "images": [\n    {\n      "filename": "%s",\n      "idiom": "universal"\n    }' "$light"
    if [ -n "${dark:-}" ]; then
      printf ',\n    {\n      "filename": "%s",\n      "idiom": "universal",\n      "appearances": [\n        {\n          "appearance": "luminosity",\n          "value": "dark"\n        }\n      ]\n    }' "$dark"
    fi
    printf '\n  ],\n  "info": {\n    "author": "xcode",\n    "version": 1\n  },\n  "properties": {\n    "preserves-vector-representation": true\n  }\n}\n'
  } > "$tmp/$agent.json"
  put "$tmp/$agent.json" "$set/Contents.json"
  if [ -n "${dark:-}" ]; then put "$icons/$dark" "$set/$dark"; fi
done <<EOF
$marks
EOF

if [ "$stale" = 1 ]; then
  echo "agent-marks: run bash apps/mobile/ios/agent-marks.sh and commit the catalog." >&2
  exit 1
fi
[ "$check" = 1 ] && echo "agent-marks: up to date" || true
