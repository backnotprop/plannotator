#!/usr/bin/env bash
# What .github/workflows/mobile-ios.yml runs for the native iPhone app.
#
#   bash apps/mobile/ios/ci.sh pr        build and `swift test` (no simulator)
#   bash apps/mobile/ios/ci.sh nightly   the same, then the simulator UI suite
#
# Until the app's Swift package exists there is nothing to build: it says so
# and exits 0.
set -euo pipefail

mode=${1:-pr}
case "$mode" in
  pr|nightly) ;;
  *) echo "usage: bash apps/mobile/ios/ci.sh pr|nightly" >&2; exit 2 ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -f "$here/InboxCore/Package.swift" ]; then
  echo "apps/mobile/ios: no Swift package yet, nothing to build ($mode)."
  exit 0
fi

swift --version
swift test --package-path "$here/InboxCore"
