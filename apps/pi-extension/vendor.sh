#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Single source of truth — used by both `npm run build` and CI test workflow.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf generated
mkdir -p generated generated/ai/providers

# Modules that MOVED to @plannotator/core — vendor the real impl from core.
for f in feedback-templates project favicon code-file annotatable external-annotation agent-jobs agent-terminal source-save open-in-apps; do
  src="../../packages/core/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/core/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# Node-bound shared modules that now import types from @plannotator/core/*-types —
# vendor from shared, rewrite the bare core specifier to the flat relative path.
for f in config storage workspace-status; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" \
    | sed "s|from ['\"]@plannotator/core/\\([^'\"]*\\)-types['\"]|from './\\1-types.js'|g" \
    > "generated/$f.ts"
done

# Extracted type files those node-bound modules now depend on — vendor from core.
for f in config-types storage-types workspace-status-types; do
  src="../../packages/core/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/core/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# Everything else in the original flat list stays sourced from packages/shared.
for f in prompts review-core diff-paths cli-pagination jj-core gitbutler-core vcs-core review-args draft pr-types pr-context-live pr-artifact-document pr-provider pr-stack pr-github pr-gitlab checklist integrations-common repo reference-common resolve-file annotate-reference-roots-node worktree worktree-pool html-to-markdown html-diff html-assets html-assets-node url-to-markdown tour annotate-args at-reference review-workspace-node review-workspace pfm-reminder improvement-hooks code-nav data-dir semantic-diff-types semantic-diff single-flight source-save-node review-profiles guide commit-avatars commit-history port-range; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# Vendor review agent modules from packages/server/ — rewrite imports for generated/ layout
for f in agent-review-message codex-review claude-review review-findings marker-review path-utils review-skill-loader; do
  src="../../packages/server/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/server/%s.ts\n' "$f" | cat - "$src" \
    | sed 's|from "./vcs"|from "./review-core.js"|' \
    | sed 's|from "./pr"|from "./pr-provider.js"|' \
    | sed 's|from "./path-utils"|from "./path-utils.js"|' \
    | sed 's|from "./review-skill-loader"|from "./review-skill-loader.js"|' \
    | sed 's|from "@plannotator/shared/review-workspace"|from "./review-workspace.js"|' \
    | sed 's|from "@plannotator/shared/review-profiles"|from "./review-profiles.js"|' \
    | sed 's|from "@plannotator/shared/external-annotation"|from "./external-annotation.js"|' \
    | sed 's|from "@plannotator/shared/data-dir"|from "./data-dir"|' \
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
    | sed 's|from "@plannotator/shared/data-dir"|from "./data-dir"|' \
    > "generated/$f.ts"
done

# guide-review lives in packages/server/guide/ — same parent-relative and
# shared-package import rewrites as tour-review above, plus its own
# marker-review import (guide's marker-engine support reuses marker-review.ts's
# nonce/extraction primitives, same as review.ts does).
for f in guide-review; do
  src="../../packages/server/guide/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/server/guide/%s.ts\n' "$f" | cat - "$src" \
    | sed 's|from "\.\./vcs"|from "./review-core.js"|' \
    | sed 's|from "\.\./pr"|from "./pr-provider.js"|' \
    | sed 's|from "\.\./agent-review-message"|from "./agent-review-message.js"|' \
    | sed 's|from "\.\./marker-review"|from "./marker-review.js"|' \
    | sed 's|from "\.\./config"|from "./config.js"|' \
    | sed 's|from "@plannotator/shared/guide"|from "./guide.js"|' \
    | sed 's|from "@plannotator/shared/data-dir"|from "./data-dir"|' \
    > "generated/$f.ts"
done

# Vendor the moved AI context types from core into generated/ai/.
printf '// @generated — DO NOT EDIT. Source: packages/core/ai-context.ts\n' \
  | cat - "../../packages/core/ai-context.ts" > "generated/ai/ai-context.ts"

for f in index types provider session-manager endpoints context base-session; do
  src="../../packages/ai/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/%s.ts\n' "$f" | cat - "$src" \
    | sed "s|from ['\"]@plannotator/core/ai-context['\"]|from './ai-context.js'|g" \
    > "generated/ai/$f.ts"
done

for f in claude-agent-sdk codex-app-server opencode-sdk command-path pi-sdk pi-sdk-node pi-events; do
  src="../../packages/ai/providers/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/ai/providers/%s.ts\n' "$f" | cat - "$src" > "generated/ai/providers/$f.ts"
done
