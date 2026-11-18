#!/usr/bin/env bash
# What .github/workflows/mobile-ios.yml runs for the native iPhone app.
#
#   bash apps/mobile/ios/ci.sh pr        `swift test` of InboxCore (no simulator), then the app built for the simulator
#   bash apps/mobile/ios/ci.sh nightly   the same; the simulator UI suite (UITests/) joins it once the runner has iOS 26
#
# The app needs the iOS 26 SDK. On a runner whose Xcode is older the app build is
# skipped and the job says so; InboxCore's tests still run.
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

sdk=$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null || echo 0)
if [ "${sdk%%.*}" -lt 26 ]; then
  echo "apps/mobile/ios: the app build is SKIPPED: it needs the iOS 26 SDK and this runner has iOS $sdk."
  exit 0
fi
echo "apps/mobile/ios: build the app for the simulator (no signing)"
xcodebuild -project "$here/PlannotatorInbox.xcodeproj" -scheme PlannotatorInbox \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$here/build/DerivedData" \
  CODE_SIGNING_ALLOWED=NO build | tail -n 20
