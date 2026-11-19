#!/usr/bin/env bash
# What .github/workflows/mobile-ios.yml runs for the native iPhone app.
#
#   bash apps/mobile/ios/ci.sh pr        build and `swift test` (no simulator)
#   bash apps/mobile/ios/ci.sh nightly   the same; the simulator UI suite joins it when it exists
#
# Until the app's Swift package exists there is nothing to build but the
# contract's Wire.swift: it says so and exits 0.
set -euo pipefail

mode=${1:-pr}
case "$mode" in
  pr|nightly) ;;
  *) echo "usage: bash apps/mobile/ios/ci.sh pr|nightly" >&2; exit 2 ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The contract's generated Swift (scripts/mobile/swift.ts, words.ts) must compile on its own.
generated="$here/../contract/generated/swift"
if [ -f "$generated/Wire.swift" ]; then
  echo "apps/mobile/contract: typecheck the generated Swift"
  xcrun swiftc -typecheck -swift-version 6 "$generated/Wire.swift" "$generated/Words.swift"
fi

if [ ! -f "$here/InboxCore/Package.swift" ]; then
  echo "apps/mobile/ios: no Swift package yet, nothing to build ($mode)."
  exit 0
fi

swift --version
swift test --package-path "$here/InboxCore"
