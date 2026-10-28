#!/usr/bin/env bash
# Smoke test for safe updates (step 1) against a COMPILED binary, run by
# release.yml's smoke-binaries job on the artifacts it built.
#
#   scripts/smoke-update-prepare.sh <path-to-plannotator-binary>
#
# 1. `<binary> update-prepare v999.0.0` against a loopback mirror prints
#    exactly one line, the staged plannotator-update-* dir, holding the script
#    and this machine's pin. Losing the dispatch in index.ts, or any stdout
#    before it, fails here.
# 2. When the binary has a release version: a full `plannotator update`, run
#    as the install-script-managed copy in a temp HOME, goes through the
#    detached-wrapper path: the wrapper calls the binary back for
#    `update-prepare` (compiled-binary detection: no script argument), then
#    runs the mirror's stand-in install script with PLANNOTATOR_EXPECTED_SHA256.
#
# Everything is loopback and temp dirs: a temp HOME, TMPDIR and data dir, a
# stand-in install script written here. Nothing reaches the network and the
# real install script never runs.
set -euo pipefail

BINARY="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -x "$BINARY" ] || { echo "FAIL: $BINARY is not executable" >&2; exit 1; }

case "$(uname -s)" in Darwin) os=darwin ;; *) os=linux ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; *) arch=arm64 ;; esac
native="plannotator-${os}-${arch}"
pin="$(printf 'e%.0s' $(seq 1 64))"

work="$(mktemp -d)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

served="$work/served"
mkdir -p "$served/dl/v999.0.0" "$served/api" "$work/home" "$work/tmp" "$work/data" "$work/bin"
cat > "$served/install.sh" <<'SCRIPT'
#!/bin/bash
REPO="backnotprop/plannotator"
# Stand-in for install.sh (it names PLANNOTATOR_EXPECTED_SHA256, as the real one does).
printf '%s\n' "$@" > "$HOME/installer-args"
printf '%s' "${PLANNOTATOR_EXPECTED_SHA256:-}" > "$HOME/installer-pins"
echo "stand-in installer ran"
SCRIPT
printf '%s  %s\n' "$pin" "$native" > "$served/dl/v999.0.0/${native}.sha256"
printf '{"tag_name":"v999.0.0","published_at":"2026-01-01T00:00:00Z","body":"## What'"'"'s New in v999.0.0\\n\\nSmoke."}' > "$served/api/latest"

cat > "$work/bin/serve.mjs" <<'NODE'
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
const [root, portFile] = process.argv.slice(2);
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    res.end(await readFile(join(root, path)));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
NODE
node "$work/bin/serve.mjs" "$served" "$work/port" &
server_pid=$!
for _ in $(seq 1 100); do [ -s "$work/port" ] && break; sleep 0.1; done
port="$(cat "$work/port")"
base="http://127.0.0.1:${port}"

smoke_env=(
  env -i
  PATH="/usr/bin:/bin"
  HOME="$work/home"
  TMPDIR="$work/tmp"
  PLANNOTATOR_DATA_DIR="$work/data"
  PLANNOTATOR_UPDATE_CHECK=0
  PLANNOTATOR_INSTALL_SCRIPT_URL="$base/install.sh"
  PLANNOTATOR_RELEASE_DOWNLOAD_URL="$base/dl"
  PLANNOTATOR_UPDATE_API_URL="$base/api/latest"
)

# 1. update-prepare prints exactly the staged dir.
out="$("${smoke_env[@]}" "$BINARY" update-prepare v999.0.0)"
lines="$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
case "$out" in
  "$work/tmp"/plannotator-update-*) ;;
  *) echo "FAIL: update-prepare printed '$out', expected one $work/tmp/plannotator-update-* path" >&2; exit 1 ;;
esac
[ "$lines" = "1" ] || { echo "FAIL: update-prepare printed $lines lines" >&2; exit 1; }
[ -f "$out/install.sh" ] || { echo "FAIL: no install.sh in $out" >&2; exit 1; }
grep -q "^${native}=${pin}" "$out/expected-sha256" || { echo "FAIL: expected-sha256 lacks ${native}" >&2; cat "$out/expected-sha256" >&2; exit 1; }
rm -rf "$out"
echo "OK: update-prepare staged the install script and the ${native} pin"

# 2. A full update through the wrapper, when this is a release build.
version="$("${smoke_env[@]}" "$BINARY" --version | awk '{print $2}')"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "SKIP: ${version} is not a release version, so plannotator update does not run"
  exit 0
fi
mkdir -p "$work/home/.local/bin"
cp "$BINARY" "$work/home/.local/bin/plannotator"
chmod +x "$work/home/.local/bin/plannotator"
status=0
"${smoke_env[@]}" "$work/home/.local/bin/plannotator" update > "$work/update.out" 2>&1 || status=$?
cat "$work/update.out"
[ "$status" = "0" ] || { echo "FAIL: plannotator update exited $status" >&2; exit 1; }
grep -q "Updated to 999.0.0" "$work/update.out" || { echo "FAIL: no 'Updated to 999.0.0'" >&2; exit 1; }
grep -qx -- "v999.0.0" "$work/home/installer-args" || { echo "FAIL: the stand-in installer did not get --version v999.0.0" >&2; exit 1; }
grep -q "${native}=${pin}" "$work/home/installer-pins" || { echo "FAIL: the installer did not get PLANNOTATOR_EXPECTED_SHA256 with ${native}" >&2; exit 1; }
if ls "$work/tmp" | grep -q '^plannotator-update-'; then echo "FAIL: the staged dir was left behind" >&2; exit 1; fi
[ ! -e "$work/data/update.lock" ] || { echo "FAIL: update.lock left behind" >&2; exit 1; }
echo "OK: plannotator update ran update-prepare from the compiled binary and passed the pin to the installer"
