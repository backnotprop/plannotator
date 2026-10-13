#!/usr/bin/env bash
# Verify the OpenCode 2 native slash commands against a host that actually has
# the post-#44765 command API.
#
# CI now runs the same check against a pinned release (@opencode/cli, see the
# "OpenCode 2 installed package" job in .github/workflows/test.yml, which sets
# PLANNOTATOR_SMOKE_EXPECT_NATIVE=1). This script is for checking a moving
# dist-tag (`dev`, `beta`) before a release, ahead of bumping that pin.
# OpenCode 2 publishes as @opencode/cli since upstream moved to the opencode
# npm scope; the old @opencode-ai/cli dist-tags stopped moving in 2026-09.
#
# Usage:
#   scripts/opencode2-native-commands-smoke.sh [dist-tag]      # default: dev
#
# What it proves:
#   1. The plugin activates without status:"failed".
#   2. All three slash commands resolve.
#   3. They resolve to the PLUGIN's definitions, not the markdown stubs the
#      fixture installs into the sandbox config dir exactly as install.sh does.
#      (3) is the shadowing check and is fatal here because of
#      PLANNOTATOR_SMOKE_EXPECT_NATIVE=1.
#
# What it does NOT prove: that /plannotator-review opens the UI without a model
# turn. Run that by hand in the TUI against the same build.

set -euo pipefail

tag="${1:-dev}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> installing @opencode/cli@$tag into $work"
cd "$work"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "@opencode/cli@$tag" >/dev/null
# @opencode/cli publishes its binary as both `opencode` and `opencode2`; the
# older @opencode-ai/cli shipped only `opencode2`. Looking for the wrong one
# failed this script before it ever started a server, so try both and say which
# names were checked.
opencode_bin=""
for candidate in opencode2 opencode; do
  if [ -x "$work/node_modules/.bin/$candidate" ]; then
    opencode_bin="$work/node_modules/.bin/$candidate"
    break
  fi
done
if [ -z "$opencode_bin" ]; then
  echo "No OpenCode binary in $work/node_modules/.bin (looked for: opencode2, opencode)" >&2
  ls -1 "$work/node_modules/.bin" >&2 || true
  exit 1
fi
echo "==> using $opencode_bin"
"$opencode_bin" --version

echo "==> building and packing the plugin"
cd "$repo_root"
bun run build:opencode
cd "$repo_root/apps/opencode-plugin"
bun pm pack --filename "$work/plannotator-opencode.tgz" >/dev/null

echo "==> running the smoke with native commands required"
PLANNOTATOR_SMOKE_EXPECT_NATIVE=1 \
  bun run --cwd "$repo_root/apps/opencode-plugin" smoke:v2 -- \
  "$opencode_bin" \
  "$work/plannotator-opencode.tgz"
