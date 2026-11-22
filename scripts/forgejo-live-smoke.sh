#!/usr/bin/env bash
# Live smoke test for Forgejo / Gitea PR review. NOT run in CI.
#
# READ-ONLY (writes nothing; no token needed for a public repository):
#   FORGEJO_SMOKE_READONLY_PR=https://forgejo.example.com/owner/repo/pulls/3 \
#     scripts/forgejo-live-smoke.sh
# runs this checkout's `plannotator review <PR URL>` headlessly and checks the
# diff, metadata, context (comments, reviews, inline threads) and file content.
#
# FULL (only with FORGEJO_SMOKE_WRITE=1): creates a throwaway PRIVATE repository (plannotator-smoke-<stamp>) in
# the token's account, opens a PR, runs the review headlessly, posts a comment
# review with inline comments (new side, old side, multi-line), checks that
# approving and requesting changes on your OWN PR are refused with Forgejo's
# reason, verifies each anchor through the Forgejo API, and deletes the repo.
# It only ever deletes the repository it created, by name.
#
# Required env for FULL (the Plannotator names; the plain FORGEJO_* names are
# mapped onto them when unset):
#   PLANNOTATOR_FORGEJO_URL    (or FORGEJO_URL)    the instance, e.g. https://forgejo.example.com
#   PLANNOTATOR_FORGEJO_TOKEN  (or FORGEJO_TOKEN)  an access token with the scopes
#       read:user  write:user  read:repository  write:repository  read:issue  write:issue
#       (write:user is what an instance asked for when creating the test repo in
#       the token's own account; write:repository covers the commits and PR)
# Optional:
#   PLANNOTATOR_FORGEJO_REVIEWER_TOKEN (or FORGEJO_REVIEWER_TOKEN)
#                              a SECOND account's token (read:user,
#                              read:repository, write:repository, read:issue).
#                              Forgejo refuses approving your own PR, so without
#                              it only the refusal is checked; with it the
#                              reviewer is added to the repo and approves, then
#                              requests changes, as itself.
#   FORGEJO_SMOKE_REPO=owner/name
#                              use a repository you created instead of creating
#                              one (no scope for creating repositories needed).
#                              It must be initialized with a README, named
#                              plannotator-smoke-<anything>, and PRIVATE unless
#                              FORGEJO_SMOKE_ALLOW_PUBLIC=1 (a public scratch repo
#                              on a server you control): the script
#                              commits to its default branch. It is never
#                              deleted; the script closes its PR and deletes its
#                              branch, and its files stay under smoke-<stamp>/.
#   FORGEJO_SMOKE_LOCAL=1      also wait for the --local git checkout (git over
#                              HTTPS with the token, via an env credential
#                              helper: the token never hits argv)
#   FORGEJO_SMOKE_KEEP=1       keep the repo afterwards
#   FORGEJO_SMOKE_ALLOW_HTTP=1 allow a plain-http instance (the token then
#                              travels in cleartext; refused otherwise)
#
# Usage:
#   set -a; . ~/path/to/forgejo-credentials.env; set +a
#   FORGEJO_SMOKE_WRITE=1 scripts/forgejo-live-smoke.sh
#
# Needs the built UI: `bun run --cwd apps/review build && bun run build:hook`.
# The tokens are never printed: the driver redacts them from everything it writes.

set -euo pipefail
cd "$(dirname "$0")/.."

export PLANNOTATOR_FORGEJO_URL="${PLANNOTATOR_FORGEJO_URL:-${FORGEJO_URL:-}}"
export PLANNOTATOR_FORGEJO_TOKEN="${PLANNOTATOR_FORGEJO_TOKEN:-${FORGEJO_TOKEN:-}}"
export PLANNOTATOR_FORGEJO_REVIEWER_TOKEN="${PLANNOTATOR_FORGEJO_REVIEWER_TOKEN:-${FORGEJO_REVIEWER_TOKEN:-}}"
export FORGEJO_SMOKE_READONLY_PR="${FORGEJO_SMOKE_READONLY_PR:-}"

if [[ ! -f apps/hook/dist/index.html ]]; then
  echo "The hook UI is not built. Run: bun run --cwd apps/review build && bun run build:hook" >&2
  exit 2
fi

if [[ -z "$FORGEJO_SMOKE_READONLY_PR" && "${FORGEJO_SMOKE_WRITE:-}" != "1" ]]; then
  echo "Nothing run: set FORGEJO_SMOKE_READONLY_PR=<PR URL> for the read-only checks, or FORGEJO_SMOKE_WRITE=1 for the FULL mode, which creates, writes and deletes on the instance (see the header of $0)." >&2
  exit 2
fi

if [[ -z "$FORGEJO_SMOKE_READONLY_PR" ]]; then
  missing=()
  [[ -n "$PLANNOTATOR_FORGEJO_URL" ]] || missing+=(PLANNOTATOR_FORGEJO_URL)
  [[ -n "$PLANNOTATOR_FORGEJO_TOKEN" ]] || missing+=(PLANNOTATOR_FORGEJO_TOKEN)
  if (( ${#missing[@]} )); then
    echo "Missing env: ${missing[*]} (see the header of $0)" >&2
    exit 2
  fi
  target="$PLANNOTATOR_FORGEJO_URL"
else
  target="$FORGEJO_SMOKE_READONLY_PR"
fi

# A token sent over plain http crosses the network in the clear.
if [[ "$target" == http://* && "${FORGEJO_SMOKE_ALLOW_HTTP:-}" != "1" && -n "$PLANNOTATOR_FORGEJO_TOKEN" ]]; then
  echo "Refusing to use a token over plain http ($target). Set FORGEJO_SMOKE_ALLOW_HTTP=1 if that is intended." >&2
  exit 2
fi

exec bun scripts/forgejo-live-smoke.ts
