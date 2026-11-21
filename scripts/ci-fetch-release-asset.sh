#!/usr/bin/env bash
# Downloads one GitHub release asset for a CI job:
#
#   bash scripts/ci-fetch-release-asset.sh <url> <output>
#
# <url> is the asset's https://github.com/OWNER/REPO/releases/download/TAG/NAME
# address. With GH_TOKEN set (the job's own token), the asset comes through the
# REST API as an authenticated request: anonymous release downloads are the
# first to time out (HTTP 504) when github.com sheds load. If that path fails,
# or GH_TOKEN is unset, the plain URL is tried. curl retries transient errors
# with an exponential backoff (no --retry-delay, which would make it fixed).
# The token goes to curl on stdin, never in argv or the log, and curl drops it
# when the API redirects to the storage host.
#
# This only downloads: the caller checks the file's SHA-256.
set -euo pipefail

usage="usage: ci-fetch-release-asset.sh <release asset url> <output>"
url="${1:?$usage}"
output="${2:?$usage}"

pattern='^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/download/([^/]+)/([^/]+)$'
if [[ ! "$url" =~ $pattern ]]; then
  echo "ci-fetch-release-asset.sh: not a GitHub release asset URL: $url" >&2
  exit 2
fi
repo="${BASH_REMATCH[1]}"
tag="${BASH_REMATCH[2]}"
name="${BASH_REMATCH[3]}"

fetch=(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2
  --connect-timeout 20 --retry 7 --retry-all-errors --retry-max-time 300)

with_token() {
  printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" | "${fetch[@]}" --config - "$@"
}

authenticated() {
  local release id
  release="$(with_token \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${repo}/releases/tags/${tag}")" || return 1
  id="$(printf '%s' "$release" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const asset = (JSON.parse(s).assets || []).find((a) => a.name === process.argv[1]);
      if (asset) process.stdout.write(String(asset.id));
    });' "$name")" || return 1
  if [[ ! "$id" =~ ^[0-9]+$ ]]; then
    echo "ci-fetch-release-asset.sh: ${repo}@${tag} has no asset named ${name}" >&2
    return 3
  fi
  with_token --header 'Accept: application/octet-stream' --output "$output" \
    "https://api.github.com/repos/${repo}/releases/assets/${id}"
}

if [[ -n "${GH_TOKEN:-}" ]]; then
  status=0
  authenticated || status=$?
  if [[ "$status" -eq 0 ]]; then
    exit 0
  fi
  # The release answered and the name is not in it: the plain URL would 404.
  if [[ "$status" -eq 3 ]]; then
    exit 1
  fi
  echo "ci-fetch-release-asset.sh: the authenticated download failed; trying ${url}" >&2
else
  echo "ci-fetch-release-asset.sh: GH_TOKEN is unset; downloading ${url} without a token" >&2
fi
"${fetch[@]}" --output "$output" "$url"
