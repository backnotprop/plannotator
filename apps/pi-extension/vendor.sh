#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Single source of truth — used by both `npm run build` and CI test workflow.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf generated
mkdir -p generated

for f in prompts review-core vcs-core jj-core review-args checklist reference-common code-file resolve-file config html-to-markdown url-to-markdown annotate-args at-reference pfm-reminder improvement-hooks plugin-binary plugin-protocol plugin-client agents; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done
