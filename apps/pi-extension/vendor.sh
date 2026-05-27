#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Pi is published to npm as a Node package and cannot depend on workspace
# packages at runtime. This script copies the minimal set of shared code
# needed for binary communication and planning mode.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf generated
mkdir -p generated

# Core modules Pi imports directly
for f in prompts checklist config improvement-hooks pfm-reminder \
         plugin-binary plugin-protocol plugin-client; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# agents.ts — only the Origin type is needed (transitive dep of plugin-protocol)
cat > generated/agents.ts << 'STUB'
// @generated — stub. Only the Origin type is needed by plugin-protocol.ts.
export type Origin = "claude-code" | "opencode" | "copilot-cli" | "pi" | "codex" | "gemini-cli";
STUB
