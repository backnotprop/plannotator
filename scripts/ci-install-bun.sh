#!/usr/bin/env bash
# Installs Bun for a CI job from an authenticated, checksummed download:
#
#   bash scripts/ci-install-bun.sh <version>
#
# For the jobs that run oven-sh/setup-bun with `no-cache: true` (the release
# workflows keep caches out): setup-bun would download the release zip on every
# run, without a token. This puts the same zip's binary where setup-bun looks
# first (~/.bun/bin), so the setup-bun step that follows finds the version
# installed and downloads nothing. A version or runner with no pinned SHA-256
# below is left to setup-bun, as before. test.yml runs it on a self-hosted
# machine too: setup-bun unpacks with `unzip`, which a stock Ubuntu lacks.
set -euo pipefail

version="${1:?usage: ci-install-bun.sh <version>}"

case "${RUNNER_OS:-}/${RUNNER_ARCH:-}" in
  Linux/X64) asset=bun-linux-x64 ;;
  Linux/ARM64) asset=bun-linux-aarch64 ;;
  macOS/ARM64) asset=bun-darwin-aarch64 ;;
  macOS/X64) asset=bun-darwin-x64 ;;
  Windows/X64) asset=bun-windows-x64 ;;
  *) asset="" ;;
esac

# SHA-256s from the release's SHASUMS256.txt.
case "${version}/${asset}" in
  1.4.4/bun-linux-x64) sha256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
  1.4.4/bun-linux-aarch64) sha256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
  1.4.4/bun-darwin-aarch64) sha256=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
  1.4.4/bun-darwin-x64) sha256=50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e ;;
  1.4.4/bun-windows-x64) sha256=cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5 ;;
  *)
    echo "::warning::scripts/ci-install-bun.sh has no SHA-256 for Bun ${version} on ${RUNNER_OS:-?}/${RUNNER_ARCH:-?}; setup-bun downloads it instead."
    exit 0
    ;;
esac

work="${RUNNER_TEMP:?}/ci-install-bun"
zip="${work}/${asset}.zip"
mkdir -p "${work}/unpacked"
bash "$(dirname "$0")/ci-fetch-release-asset.sh" \
  "https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}.zip" "$zip"

# From stdin: given a Windows path (backslashes), sha256sum escapes its output.
if command -v sha256sum > /dev/null; then
  actual="$(sha256sum < "$zip" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 < "$zip" | cut -d' ' -f1)"
fi
if [[ "$actual" != "$sha256" ]]; then
  echo "Bun ${version} ${asset}.zip: SHA-256 ${actual}, expected ${sha256}" >&2
  exit 1
fi

exe=bun
if [[ "$RUNNER_OS" == Windows ]]; then
  exe=bun.exe
  ZIP="$zip" DEST="${work}/unpacked" pwsh -NoProfile -NonInteractive -Command \
    'Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DEST -Force'
elif command -v unzip > /dev/null; then
  unzip -q -o "$zip" -d "${work}/unpacked"
else
  python3 -I -m zipfile -e "$zip" "${work}/unpacked"
fi

mkdir -p "${HOME}/.bun/bin"
cp "${work}/unpacked/${asset}/${exe}" "${HOME}/.bun/bin/${exe}"
chmod +x "${HOME}/.bun/bin/${exe}"
"${HOME}/.bun/bin/${exe}" --revision
