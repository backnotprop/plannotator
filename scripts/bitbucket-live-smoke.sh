#!/usr/bin/env bash
# Live smoke test for Bitbucket Cloud PR review against a REAL Bitbucket
# workspace. NOT run in CI. It creates a throwaway private repository, opens a
# PR, runs this checkout's `plannotator review <PR URL>` headlessly, posts
# inline + general comments with Approve and then Request changes, verifies
# each through the Bitbucket API, and deletes the repository.
#
# Required env (the Plannotator names; the BITBUCKET_* names used by the
# Workspaces test-credential files are mapped onto them when unset):
#   PLANNOTATOR_BITBUCKET_EMAIL   (or BITBUCKET_EMAIL)      Atlassian account email
#   PLANNOTATOR_BITBUCKET_TOKEN   (or BITBUCKET_API_TOKEN)  API token with scopes:
#       read:user:bitbucket read:repository:bitbucket read:pullrequest:bitbucket
#       write:pullrequest:bitbucket   — plus, for this script only (it creates
#       and deletes the test repo): write:repository:bitbucket
#       admin:repository:bitbucket delete:repository:bitbucket
#   BITBUCKET_SMOKE_WORKSPACE     (or BITBUCKET_WORKSPACE)  workspace slug
# Optional:
#   BITBUCKET_SMOKE_PROJECT_KEY   project to create the repo in (e.g. PROJ);
#                                 needed when the workspace has no default project
#   BITBUCKET_SMOKE_LOCAL=1       also wait for the --local git checkout (git over
#                                 HTTPS as x-bitbucket-api-token-auth, via an env
#                                 credential helper — the token never hits argv)
#   BITBUCKET_SMOKE_GUIDE=1       also run a Guided Review (needs the claude CLI,
#                                 or BITBUCKET_SMOKE_GUIDE_ENGINE=codex)
#   BITBUCKET_SMOKE_KEEP=1        keep the repo afterwards
#
# Usage:
#   set -a; . ~/path/to/bitbucket-credentials.env; set +a
#   BITBUCKET_SMOKE_PROJECT_KEY=PROJ scripts/bitbucket-live-smoke.sh
#
# The token is never printed: the driver redacts it from everything it writes.

set -euo pipefail
cd "$(dirname "$0")/.."

export PLANNOTATOR_BITBUCKET_EMAIL="${PLANNOTATOR_BITBUCKET_EMAIL:-${BITBUCKET_EMAIL:-}}"
export PLANNOTATOR_BITBUCKET_TOKEN="${PLANNOTATOR_BITBUCKET_TOKEN:-${BITBUCKET_API_TOKEN:-}}"
export BITBUCKET_SMOKE_WORKSPACE="${BITBUCKET_SMOKE_WORKSPACE:-${BITBUCKET_WORKSPACE:-}}"

missing=()
[[ -n "$PLANNOTATOR_BITBUCKET_TOKEN" ]] || missing+=(PLANNOTATOR_BITBUCKET_TOKEN)
[[ -n "$BITBUCKET_SMOKE_WORKSPACE" ]] || missing+=(BITBUCKET_SMOKE_WORKSPACE)
if (( ${#missing[@]} )); then
  echo "Missing env: ${missing[*]} (see the header of $0)" >&2
  exit 2
fi

exec bun scripts/bitbucket-live-smoke.ts
