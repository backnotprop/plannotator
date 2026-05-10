#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Single source of truth — used by both `npm run build` and CI test workflow.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p generated generated/ai/providers

for f in feedback-templates prompts review-core jj-core vcs-core review-args storage draft project pr-provider pr-stack pr-github pr-gitlab checklist integrations-common repo reference-common favicon code-file resolve-file config external-annotation agent-jobs worktree worktree-pool html-to-markdown url-to-markdown tour annotate-args at-reference pfm-reminder improvement-hooks; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# Vendor review agent modules from packages/server/ — rewrite imports for generated/ layout
for f in agent-review-message codex-review claude-review path-utils; do
  src="../../packages/server/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/server/%s.ts\n' "$f" | cat - "$src" \
    | sed 's|from "./vcs"|from "./review-core.js"|' \
    | sed 's|from "./pr"|from "./pr-provider.js"|' \
    | sed 's|from "./path-utils"|from "./path-utils.js"|' \
    > "generated/$f.ts"
done

# tour-review lives in packages/server/tour/ — parent-relative imports and the
# shared tour types package each map to the flat generated/ layout.
for f in tour-review; do
  src="../../packages/server/tour/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/server/tour/%s.ts\n' "$f" | cat - "$src" \
    | sed 's|from "\.\./vcs"|from "./review-core.js"|' \
    | sed 's|from "\.\./pr"|from "./pr-provider.js"|' \
    | sed 's|from "\.\./agent-review-message"|from "./agent-review-message.js"|' \
    | sed 's|from "@plannotator/shared/tour"|from "./tour.js"|' \
    > "generated/$f.ts"
done

for f in index types provider session-manager endpoints context base-session; do
  src="../../packages/ai/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/%s.ts\n' "$f" | cat - "$src" > "generated/ai/$f.ts"
done

for f in claude-agent-sdk codex-sdk opencode-sdk pi-sdk pi-sdk-node pi-events; do
  src="../../packages/ai/providers/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/providers/%s.ts\n' "$f" | cat - "$src" > "generated/ai/providers/$f.ts"
done
