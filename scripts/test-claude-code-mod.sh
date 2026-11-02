#!/bin/sh
# Run the Claude Code mod's engine-harness tests (`claude plugin test`, Claude
# Code >= 2.1.287 with hooks modules on) against the plugin as it ships.
#
# `claude plugin test <dir>` loads every *.test.ts in the plugin directory, and
# apps/hook also holds the CLI and its bun tests, which the harness cannot load.
# So this stages a copy of just the plugin parts: the manifest, hooks.json, the
# mod's sources (not its bun tests) and apps/hook/tests/.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
plugin="$root/apps/hook"
stage=$(mktemp -d "${TMPDIR:-/tmp}/plannotator-mod-test.XXXXXX")
trap 'rm -rf "$stage"' EXIT INT TERM

mkdir -p "$stage/hooks"
cp -R "$plugin/.claude-plugin" "$stage/"
cp "$plugin/hooks/hooks.json" "$stage/hooks/"
cp -R "$plugin/hooks/mod" "$stage/hooks/mod"
rm -rf "$stage/hooks/mod/testing"
find "$stage/hooks/mod" -name '*.test.ts' -delete
cp -R "$plugin/tests" "$stage/tests"

claude plugin test "$stage"
