#!/usr/bin/env bash
# Docs-only gate for the fast CI tier (Test, Browser smoke, Semgrep).
#
# A PR that changes only files on the allowlist below cannot break a unit, DOM,
# browser or package test: no test, build or scanner reads them
# (scripts/ci-docs-only.test.ts holds that). The gated jobs still start and
# report SUCCESS under their usual names, since the merge script requires each
# fast check by name and a skipped matrix job loses its name; their steps after
# this one skip.
#
# It is an allowlist on purpose. Everything else runs the whole tier, among it
# AGENTS.md / CLAUDE.md and docs/agent-guides/ (tests/agents-md-size.test.ts and
# others read them), .github/pull_request_template.md (scripts/e2e-slice.test.ts
# reads it), every README under apps/ or packages/ (shipped in npm packages),
# SKILL.md files and apps/marketing.
#
#   bash scripts/ci-docs-only.sh             in a job: writes skip=true|false to
#                                            $GITHUB_OUTPUT (stdout without it)
#   bash scripts/ci-docs-only.sh classify    reads paths on stdin, prints
#                                            `docs` or `code`
#
# Fail safe: skip=true only on a pull_request whose checkout is the PR merge
# commit (HEAD^1 the base tip, HEAD^2 the head) and whose diff, computed
# without rename detection (a rename lists both its old and its new path),
# is non-empty and all on the allowlist. A push, a manual or scheduled run, a
# merge queue, a shallow or odd checkout, an empty diff or any git error gives
# skip=false. The workflows also read anything but an explicit `true` (this
# step failing, its output missing) as "run".
set -u

DOCS_ONLY='^(README\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE-MIT|LICENSE-APACHE|\.github/assets/.+|adr/.+|docs/[^/]+\.md|docs/releases/.+)$'

# All of stdin on the allowlist, and at least one line: `docs`. Otherwise `code`.
classify() {
  local changed
  changed=$(cat)
  if [ -n "$changed" ] && ! grep -Evq "$DOCS_ONLY" <<< "$changed"; then
    echo docs
  else
    echo code
  fi
}

if [ "${1:-}" = classify ]; then
  classify
  exit 0
fi

skip=false
why='not a pull_request run'
if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
  why='the checkout is not the PR merge commit'
  if base=$(git rev-parse --verify --quiet 'HEAD^1') \
     && git rev-parse --verify --quiet 'HEAD^2' > /dev/null; then
    why='git diff failed'
    if changed=$(git diff --no-renames --name-only "$base" HEAD); then
      if [ "$(classify <<< "$changed")" = docs ]; then
        skip=true
        why='every changed path is docs-only'
      elif [ -z "$changed" ]; then
        why='the diff is empty'
      else
        why='a changed path is not docs-only'
      fi
    fi
  fi
fi

echo "Docs-only gate: skip=$skip ($why)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "skip=$skip" >> "$GITHUB_OUTPUT"
else
  echo "skip=$skip"
fi
