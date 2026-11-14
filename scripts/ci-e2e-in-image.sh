#!/usr/bin/env bash
# Runs a command in the official Playwright image of the version a checkout
# pins, on a GitHub Ubuntu runner:
#
#   bash scripts/ci-e2e-in-image.sh <checkout> <command...>
#
# For the PR smoke (browser-smoke.yml) and the blame job of the main runs
# (inbox-e2e.yml, scripts/ci-e2e-main.ts). Both build the apps and the binary
# on the runner itself, as the e2e build job does, then run the specs here, in
# the same image, user and flags as the e2e shards' container:
#  - the image of `<checkout>/package.json`'s @playwright/test, which holds
#    Chromium, WebKit and their system libraries (no apt install);
#  - uid 1001 (the runner's own user, the image's pwuser), so the checkout
#    stays the runner's;
#  - `--init`, so an Inbox started with `--background` is reaped when stopped;
#  - `--ipc=host`, as Docker's 64 MB /dev/shm is too small for Chromium.
# The checkout is mounted at its own path; the runner's bun (and rg, when it is
# on PATH) go first on the container's PATH. CI is set, so the quarantined tests
# are left out as on the shards. E2E_*, PLAYWRIGHT_* and PLANNOTATOR_E2E_*
# variables pass through.
set -euo pipefail

checkout="$(cd "${1:?usage: ci-e2e-in-image.sh <checkout> <command...>}" && pwd)"
shift
[ $# -gt 0 ] || { echo "ci-e2e-in-image.sh: no command" >&2; exit 2; }

version="$(jq -r '.devDependencies["@playwright/test"]' "${checkout}/package.json")"
image="mcr.microsoft.com/playwright:v${version}-noble"

tools="${RUNNER_TEMP:-/tmp}/e2e-image-tools"
mkdir -p "${tools}"
cp -f "$(readlink -f "$(command -v bun)")" "${tools}/bun"
ln -sf bun "${tools}/bunx"
if command -v rg > /dev/null; then cp -f "$(readlink -f "$(command -v rg)")" "${tools}/rg"; fi

pass=()
while IFS= read -r name; do pass+=(-e "${name}"); done < <(compgen -e | grep -E '^(E2E_|PLAYWRIGHT_|PLANNOTATOR_E2E_)' || true)

exec docker run --rm --init --ipc=host --user 1001 \
  -v "${checkout}:${checkout}" -w "${checkout}" \
  -v "${tools}:/opt/e2e-image-tools:ro" \
  -e CI=true -e HOME=/home/pwuser "${pass[@]}" \
  "${image}" \
  bash -c 'export PATH="/opt/e2e-image-tools:${PATH}"; exec "$@"' bash "$@"
