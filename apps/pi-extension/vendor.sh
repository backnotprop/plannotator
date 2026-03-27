#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Single source of truth — used by both `npm run build` and CI test workflow.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p generated generated/ai/providers

for f in feedback-templates review-core storage draft project pr-provider pr-github pr-gitlab checklist integrations-common repo reference-common favicon resolve-file config external-annotation; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

for f in index types provider session-manager endpoints context base-session; do
  src="../../packages/ai/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/%s.ts\n' "$f" | cat - "$src" > "generated/ai/$f.ts"
done

for f in claude-agent-sdk codex-sdk opencode-sdk pi-sdk pi-sdk-node pi-events; do
  src="../../packages/ai/providers/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/providers/%s.ts\n' "$f" | cat - "$src" > "generated/ai/providers/$f.ts"
done
