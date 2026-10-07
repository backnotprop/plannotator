#!/bin/bash
# Build "Plannotator Shots.app" (universal) and dist/PlannotatorShots.zip.
#
#   apps/shots-macos/build.sh [version]
#
# Signing, from the environment (both optional):
#   SHOTS_SIGN_IDENTITY   a "Developer ID Application: …" identity in the keychain.
#                         Without it the app is ad-hoc signed: fine for development,
#                         but macOS forgets its Screen Recording / Accessibility
#                         grants on every rebuild.
#   SHOTS_NOTARY_PROFILE  a notarytool keychain profile (xcrun notarytool
#                         store-credentials). With it (and an identity) the app
#                         is notarized and stapled.
#   SHOTS_NOTARY_KEY / SHOTS_NOTARY_KEY_ID / SHOTS_NOTARY_ISSUER
#                         an App Store Connect API key (path, key id, issuer id)
#                         instead of a profile, as CI uses.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
version="${1:-${SHOTS_VERSION:-0.0.0-dev}}"
build="${SHOTS_BUILD:-$(date -u +%Y%m%d%H%M%S)}"
dist="$here/dist"
app="$dist/Plannotator Shots.app"

cd "$here"
rm -rf "$dist"
mkdir -p "$dist"

archs=(--arch arm64 --arch x86_64)
if [ "${SHOTS_NATIVE_ONLY:-}" = "1" ]; then archs=(); fi
swift build -c release ${archs[@]+"${archs[@]}"} >&2
bin="$(swift build -c release ${archs[@]+"${archs[@]}"} --show-bin-path)/PlannotatorShots"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/PlannotatorShots"
sed -e "s/__VERSION__/${version#v}/" -e "s/__BUILD__/$build/" Resources/Info.plist > "$app/Contents/Info.plist"
# Icon slots (the owner's artwork drops in here): Resources/AppIcon.icns, and
# Resources/MenuBarIcon.png (+ MenuBarIcon@2x.png), a template image. Without
# them the app shows the generic icon and a system symbol in the menu bar.
if [ -f Resources/AppIcon.icns ]; then
  cp Resources/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$app/Contents/Info.plist"
fi
for icon in Resources/MenuBarIcon.png Resources/MenuBarIcon@2x.png; do
  if [ -f "$icon" ]; then cp "$icon" "$app/Contents/Resources/"; fi
done
printf 'APPL????' > "$app/Contents/PkgInfo"

if [ -n "${SHOTS_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SHOTS_SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app"
fi
codesign --verify --strict "$app"

zip="$dist/PlannotatorShots.zip"
if [ -n "${SHOTS_SIGN_IDENTITY:-}" ] && { [ -n "${SHOTS_NOTARY_PROFILE:-}" ] || [ -n "${SHOTS_NOTARY_KEY:-}" ]; }; then
  ditto -c -k --keepParent "$app" "$zip"
  if [ -n "${SHOTS_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$zip" --keychain-profile "$SHOTS_NOTARY_PROFILE" --wait --timeout 20m
  else
    xcrun notarytool submit "$zip" --key "$SHOTS_NOTARY_KEY" --key-id "$SHOTS_NOTARY_KEY_ID" --issuer "$SHOTS_NOTARY_ISSUER" --wait --timeout 20m
  fi
  xcrun stapler staple "$app"
  rm -f "$zip"
fi
ditto -c -k --keepParent "$app" "$zip"
printf '%s\n' "$build" > "$dist/build.txt"
echo "$app"
