#!/bin/bash
# Build a self-contained temp sandbox for testing code-file path detection.
#
# Usage:
#   source ./setup.sh          # sets $SANDBOX in your shell
#   source ./setup.sh --keep   # don't auto-clean on shell exit
#
# What it creates (everything under a single mktemp -d):
#
#   $SANDBOX/
#   ├── repo/                           ← fake project root (git init'd)
#   │   ├── packages/
#   │   │   ├── editor/App.tsx          ← ambiguous basename (1 of 2)
#   │   │   ├── review-editor/App.tsx   ← ambiguous basename (2 of 2)
#   │   │   └── ui/
#   │   │       ├── components/Button.tsx  ← unique basename
#   │   │       └── index.ts
#   │   ├── src/
#   │   │   ├── utils/helper.ts         ← abbreviated path target
#   │   │   └── config.json             ← non-.ts code file
#   │   ├── app/
#   │   │   └── [slug]/page.tsx         ← Next.js bracket-route
#   │   ├── node_modules/
#   │   │   └── junk/App.tsx            ← should be ignored by walker
#   │   └── test-plan.md                ← the primary fixture plan
#   │
#   └── external/                       ← out-of-tree (simulates ~/notes/)
#       ├── notes.md                    ← annotate primary (out-of-tree)
#       ├── script.ts                   ← sibling reference from notes.md
#       ├── config.yaml                 ← sibling, different extension
#       ├── design.md                   ← linked doc opened from notes.md
#       ├── bar.ts                      ← sibling reference from design.md
#       ├── parent.ts                   ← target for ../parent.ts from sub/
#       └── sub/
#           ├── subdoc.md              ← references ../parent.ts
#           └── nested.ts             ← local sibling of subdoc.md

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

KEEP=false
for arg in "$@"; do
  case $arg in
    --keep) KEEP=true ;;
  esac
done

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/plannotator-pathtest-XXXXXX")
echo "Sandbox: $SANDBOX"

if [ "$KEEP" = false ]; then
  trap 'echo "Cleaning up $SANDBOX"; rm -rf "$SANDBOX"' EXIT
else
  echo "(--keep: won't auto-clean)"
fi

# ───────────────────────────────────────────────────
# 1. Fake repo with known file tree
# ───────────────────────────────────────────────────
REPO="$SANDBOX/repo"
mkdir -p "$REPO"
cd "$REPO"
git init -q
git config user.email "test@test.com"
git config user.name "Test"

# Ambiguous pair (both named App.tsx)
mkdir -p packages/editor
mkdir -p packages/review-editor
cat > packages/editor/App.tsx << 'TSEOF'
export default function EditorApp() { return <div>Editor</div>; }
TSEOF
cat > packages/review-editor/App.tsx << 'TSEOF'
export default function ReviewApp() { return <div>Review</div>; }
TSEOF

# Unique basenames
mkdir -p packages/ui/components
cat > packages/ui/components/Button.tsx << 'TSEOF'
export const Button = () => <button>Click</button>;
TSEOF
cat > packages/ui/index.ts << 'TSEOF'
export * from './components/Button';
TSEOF

# Abbreviated path targets (src/utils/helper.ts → match "utils/helper.ts")
mkdir -p src/utils
cat > src/utils/helper.ts << 'TSEOF'
export function helper() { return 42; }
TSEOF

# Non-.ts code file to verify resolver handles other extensions
cat > src/config.json << 'JSONEOF'
{ "key": "value" }
JSONEOF

# Next.js bracket-route (shape filter must allow [ and ])
mkdir -p "app/[slug]"
cat > "app/[slug]/page.tsx" << 'TSEOF'
export default function SlugPage() { return <div>Slug</div>; }
TSEOF

# node_modules — walker must skip this
mkdir -p node_modules/junk
cat > node_modules/junk/App.tsx << 'TSEOF'
// should never resolve
TSEOF

# Commit so git is happy
git add -A
git commit -q -m "initial"

# ───────────────────────────────────────────────────
# 2. Out-of-tree fixtures (simulates external docs)
# ───────────────────────────────────────────────────
EXT="$SANDBOX/external"
mkdir -p "$EXT/sub"

cat > "$EXT/script.ts" << 'TSEOF'
export function externalScript() { return "external"; }
TSEOF

cat > "$EXT/config.yaml" << 'YAMLEOF'
key: value
YAMLEOF

cat > "$EXT/bar.ts" << 'TSEOF'
export function bar() { return "bar"; }
TSEOF

cat > "$EXT/parent.ts" << 'TSEOF'
export function parent() { return "parent"; }
TSEOF

cat > "$EXT/sub/nested.ts" << 'TSEOF'
export function nested() { return "nested"; }
TSEOF

# ───────────────────────────────────────────────────
# 3. Test markdown: plan-fixture.md (used by run-plan.sh)
# ───────────────────────────────────────────────────
cat > "$REPO/test-plan.md" << 'MDEOF'
# Path Detection Test Plan

Use this plan to manually verify code-file path detection, smart
resolution, and existence validation. Each section tests a different
scenario. The line below each path says what should happen.

---

## §1 — Full repo paths (should all be clickable links)

A. Backtick, full path: `packages/editor/App.tsx`
   → clickable, opens packages/editor/App.tsx

B. Bare prose, full path: see packages/ui/components/Button.tsx for the button
   → clickable, opens Button.tsx

C. JSON extension: `src/config.json`
   → clickable, opens config.json

## §2 — Abbreviated paths (suffix-walk resolution)

A. Backtick abbreviated: `editor/App.tsx`
   → clickable, opens packages/editor/App.tsx

B. Bare prose abbreviated: see utils/helper.ts for the implementation
   → clickable, opens src/utils/helper.ts

C. Backtick with leading dot-slash: `./editor/App.tsx`
   → clickable, opens packages/editor/App.tsx

## §3 — Bare basename (single match → link, multiple → picker)

A. Unique basename: `Button.tsx`
   → clickable, opens packages/ui/components/Button.tsx

B. Ambiguous basename: `App.tsx`
   → clickable with superscript count badge, click opens picker
     listing packages/editor/App.tsx and packages/review-editor/App.tsx

C. Unique non-component: `helper.ts`
   → clickable, opens src/utils/helper.ts

## §4 — Non-existent paths (should demote to plain text)

A. Backtick, missing file: `packages/ui/shortcuts/core.ts`
   → rendered as plain code (not clickable), no shimmer

B. Bare prose, missing file: see packages/ui/shortcuts/runtime.ts for details
   → rendered as plain text (not a link at all)

## §5 — Shape filter (should never be detected as paths)

A. Brace expansion: `packages/ui/{core,runtime}.ts`
   → rendered as plain code, NOT a link

B. Glob wildcard: `packages/ui/*.tsx`
   → rendered as plain code, NOT a link

C. Path with spaces: `some path/with spaces/file.ts`
   → rendered as plain code, NOT a link

## §6 — Bracket routes (shape filter must allow [ and ])

A. Next.js dynamic route: `app/[slug]/page.tsx`
   → clickable, opens app/[slug]/page.tsx

B. Abbreviated bracket route: `[slug]/page.tsx`
   → clickable via suffix walk

## §7 — node_modules exclusion

A. Path inside node_modules: `junk/App.tsx`
   → should be not_found (walker skips node_modules), demoted to plain text
     or rendered as ambiguous with only the two real App.tsx files

## §8 — URLs (should not produce path-shaped leaks)

A. URL with .ts extension: see https://github.com/example/bar.ts in the docs
   → URL is a link, no stray "bar.ts" path link appears

B. URL on same line as real path: https://github.com/example.com and editor/App.tsx
   → URL is a URL link, editor/App.tsx is a separate code-file link

C. Wikipedia-style parens: see https://en.wikipedia.org/wiki/Foo_(bar).ts
   → entire URL is one link, no path extracted

## §9 — Fenced code blocks (should NOT detect paths inside)

```ts
import { helper } from 'src/utils/helper.ts';
const x = require('packages/editor/App.tsx');
```

→ No clickable links inside the fenced block above

## §10 — HTML comments (should not detect)

<!-- packages/editor/App.tsx is a placeholder -->

→ Comment content is invisible; no links generated

## §11 — Leading ../ paths

A. Without baseDir context (plan mode, no linked doc):
   `../script.ts`
   → demoted to plain text (no baseDir to resolve against)

B. This scenario is tested by opening an out-of-tree linked doc (see §12).

## §12 — Linked doc overlay (baseDir transition)

Click this link to open the external notes. Once inside the overlay,
verify the paths listed in notes.md resolve correctly against their
own directory, not against this repo's cwd.

[Open external notes](EXTERNAL_NOTES_PLACEHOLDER)

After opening, check:
- `script.ts` in the notes should be clickable (resolves to external/script.ts)
- `../parent.ts` referenced from sub/subdoc.md should resolve
- `editor/App.tsx` in the notes should still resolve via cwd suffix-walk
MDEOF

# ───────────────────────────────────────────────────
# 4. Out-of-tree markdown fixtures
# ───────────────────────────────────────────────────
cat > "$EXT/notes.md" << 'MDEOF'
# External Notes

This file lives outside the project repo. References below should
resolve against THIS directory when opened in annotate mode or as
a linked-doc overlay.

## Sibling references (baseDir-literal should hit)

A. Backtick sibling: `script.ts`
   → clickable, opens external/script.ts

B. Bare prose sibling: see config.yaml for the config
   → clickable, opens external/config.yaml

## Relative escape (../ with baseDir)

These only work when baseDir is set (annotate or linked-doc mode):

A. From sub/subdoc.md: [Open subdoc](sub/subdoc.md)
   After opening, `../parent.ts` should resolve to external/parent.ts

## Cross-context fallback (baseDir miss → cwd suffix walk)

A. Repo path from outside: `editor/App.tsx`
   → IF opened as linked doc from the repo plan: clickable, resolves
     to repo's packages/editor/App.tsx via cwd suffix-walk fallback
   → IF opened standalone via annotate: may not find it (no cwd walk
     if repo is not cwd)

## Linked doc from out-of-tree

A. [Open design doc](design.md)
   After opening, `bar.ts` should resolve to external/bar.ts

## Missing from here

A. `packages/ui/shortcuts/core.ts`
   → demoted to plain text (doesn't exist anywhere near this file)
MDEOF

cat > "$EXT/design.md" << 'MDEOF'
# Design Doc

Opened as a linked doc from notes.md. baseDir should be external/.

## References

A. Sibling code file: `bar.ts`
   → clickable, opens external/bar.ts

B. Non-existent here: `baz.ts`
   → demoted to plain text

C. Repo file via suffix-walk: `Button.tsx`
   → If opened from repo plan → cwd walk finds packages/ui/components/Button.tsx
   → If opened standalone → demoted (no cwd context)
MDEOF

cat > "$EXT/sub/subdoc.md" << 'MDEOF'
# Sub-document

Opened from notes.md. baseDir should be external/sub/.

## Parent escape

A. `../parent.ts`
   → clickable, opens external/parent.ts (baseDir literal: external/sub/../parent.ts)

## Local sibling

A. `nested.ts`
   → clickable, opens external/sub/nested.ts

## Non-existent

A. `../missing.ts`
   → demoted to plain text (external/missing.ts doesn't exist)
MDEOF

# ───────────────────────────────────────────────────
# 5. Patch the placeholder link in plan-fixture.md
#    to point to the actual external notes path
# ───────────────────────────────────────────────────
sed -i '' "s|EXTERNAL_NOTES_PLACEHOLDER|$EXT/notes.md|" "$REPO/test-plan.md"

echo ""
echo "Sandbox ready."
echo "  Repo:     $REPO"
echo "  External: $EXT"
echo ""
echo "Export for launcher scripts:"
echo "  export SANDBOX=$SANDBOX"

export SANDBOX
