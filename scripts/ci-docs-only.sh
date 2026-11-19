#!/usr/bin/env bash
# Docs-only rule for the fast CI tier. scripts/ci-affected.ts (the plan and
# gate jobs) reads its verdict: a docs-only PR runs no test, build or scan but
# Gitleaks.
#
# A PR that changes only files on the allowlist below cannot break a unit, DOM,
# browser or package test, nor give Semgrep anything to scan: no test, build or
# scanner reads them (scripts/ci-docs-only.test.ts holds that).
#
# It is an allowlist on purpose, of named root files and of document and image
# types in a few folders. Only types: `bun test` discovers *.test.ts anywhere,
# tests/helpers/published-packages.ts walks the tree for package.json, and
# Semgrep scans every JS/TS and shell file, all without naming a path. SVG is
# allowed: it can carry script, but only a browser opening the file runs it;
# no gated job reads, bundles or scans an SVG in these folders, and Gitleaks
# still runs. Everything else runs the whole tier, among it AGENTS.md /
# CLAUDE.md and docs/agent-guides/ (tests/agents-md-size.test.ts and others
# read them), .github/pull_request_template.md (scripts/e2e-slice.test.ts reads
# it), every README under apps/ or packages/ (shipped in npm packages), SKILL.md
# files and apps/marketing.
#
# The native iPhone app's own kinds under apps/mobile/ios (Swift, Xcode project
# and asset files) count too: only .github/workflows/mobile-ios.yml builds
# them, and no Bun test, build or scanner reads them. Its shell, JS/TS and
# package.json files do not: Semgrep and the test sweep read those. Nor does
# a Swift lockfile (Package.resolved): the dependency scans read it.
#
# Only plain files count: a symlink, a gitlink (submodule) or an executable
# file on either side of the change runs everything, whatever its path.
#
#   bash scripts/ci-docs-only.sh             in a job: writes skip=true|false to
#                                            $GITHUB_OUTPUT (stdout without it)
#   bash scripts/ci-docs-only.sh classify    reads `git diff --raw` lines on
#                                            stdin, prints `docs` or `code`
#
# Fail safe: skip=true only on a pull_request whose checkout is the PR merge
# commit (HEAD^1 the base tip, HEAD^2 the head) and whose diff, computed
# without rename detection (a rename lists both its old and its new path),
# is non-empty and all on the allowlist. A push, a manual or scheduled run, a
# merge queue, a shallow or odd checkout, an empty diff, a line this cannot
# parse or any error gives skip=false. The workflows also read anything but an
# explicit `true` (this step failing, its output missing) as "run".
set -euo pipefail

DOCS_ONLY='^(README\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE-MIT|LICENSE-APACHE|docs/[^/]+\.md|(adr|docs/releases|\.github/assets)/([^/]+/)*[^/]+\.(md|png|jpe?g|gif|webp|avif|svg)|apps/mobile/ios/([^/]+/)*[^/]+\.(swift|pbxproj|plist|xcconfig|entitlements|xcstrings|strings|storyboard|xib|xcscheme|xcworkspacedata|xcsettings|xctestplan|md|png|jpe?g|pdf|svg)|apps/mobile/ios/([^/]+/)*[^/]+\.xcassets/([^/]+/)*Contents\.json|apps/mobile/ios/([^/]+/)*\.gitignore)$'

# Every stdin line a plain-file change on the allowlist, and at least one line:
# `docs`. Otherwise `code`. A raw line is `:<old mode> <new mode> <old sha>
# <new sha> <status><TAB><path>`; 000000 is the missing side of an add or a
# delete, 100644 a plain file.
classify() {
  local line meta file old new rest any=false
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      :*$'\t'*) ;;
      *) echo code; return 0 ;;
    esac
    meta=${line%%$'\t'*}
    file=${line#*$'\t'}
    read -r old new rest <<< "${meta#:}"
    case "$old" in 000000|100644) ;; *) echo code; return 0 ;; esac
    case "$new" in 000000|100644) ;; *) echo code; return 0 ;; esac
    # `[[ =~ ]]` is false on no match and on a bad pattern alike: both run.
    if ! [[ $file =~ $DOCS_ONLY ]]; then
      echo code
      return 0
    fi
    any=true
  done
  if [ "$any" = true ]; then echo docs; else echo code; fi
}

if [ "${1:-}" = classify ]; then
  classify
  exit 0
fi

written=false
emit() {
  echo "Docs-only gate: skip=$1 ($2)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "skip=$1" >> "$GITHUB_OUTPUT"
  else
    echo "skip=$1"
  fi
  written=true
}
# Any error that ends the script early still says "run".
on_exit() {
  local rc=$?
  if [ "$written" != true ]; then emit false "the gate failed (exit $rc)"; fi
}
trap on_exit EXIT

if [ "${GITHUB_EVENT_NAME:-}" != pull_request ]; then
  emit false 'not a pull_request run'
  exit 0
fi
if ! base=$(git rev-parse --verify --quiet 'HEAD^1') \
   || ! git rev-parse --verify --quiet 'HEAD^2' > /dev/null; then
  emit false 'the checkout is not the PR merge commit'
  exit 0
fi
if ! changed=$(git diff --no-renames --no-ext-diff --raw "$base" HEAD); then
  emit false 'git diff failed'
  exit 0
fi
if [ -z "$changed" ]; then
  emit false 'the diff is empty'
  exit 0
fi
verdict=$(classify <<< "$changed")
if [ "$verdict" = docs ]; then
  emit true 'every change is a plain docs-only file'
else
  emit false 'a change is not a plain docs-only file'
fi
