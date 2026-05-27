#!/usr/bin/env bash
# Vendor shared modules into generated/ for Pi extension.
# Pi is published to npm as a Node package and cannot depend on workspace
# packages at runtime. This script copies the minimal set of shared code
# needed for binary communication, planning mode, and prompt rendering.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf generated
mkdir -p generated

for f in prompts checklist agents config improvement-hooks pfm-reminder \
         annotate-args review-args plugin-binary plugin-protocol plugin-client; do
  src="../../packages/shared/$f.ts"
  printf '// @generated — DO NOT EDIT. Source: packages/shared/%s.ts\n' "$f" | cat - "$src" > "generated/$f.ts"
done

# annotate-args and review-args import small helpers from at-reference,
# resolve-file, and vcs-core. Instead of vendoring those large files with
# deep transitive deps, patch the imports to use local stubs.
cat > generated/at-reference.ts << 'STUB'
// @generated — stub. Only the functions annotate-args.ts needs.
export function stripAtPrefix(input: string): string {
  const unquoted = stripWrappingQuotes(input);
  return unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
}
function stripWrappingQuotes(input: string): string {
  if (input.length < 2) return input;
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return input.slice(1, -1);
  }
  return input;
}
STUB

cat > generated/resolve-file.ts << 'STUB'
// @generated — stub. Only the functions annotate-args.ts needs.
export function stripWrappingQuotes(input: string): string {
  if (input.length < 2) return input;
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return input.slice(1, -1);
  }
  return input;
}
STUB

cat > generated/vcs-core.ts << 'STUB'
// @generated — stub. Only the types review-args.ts needs.
export type VcsSelection = "auto" | "git" | "jj" | "p4";
STUB
