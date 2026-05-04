# Path Detection Manual Test

Tests code-file path detection, smart resolution, existence validation,
baseDir threading, and the ambiguous-match picker.

## Quick start

```bash
cd tests/manual/path-detection
chmod +x *.sh

# Plan mode (primary in-repo)
./run-plan.sh --keep

# Annotate mode (primary in-repo)
./run-annotate-in-tree.sh --keep

# Annotate mode (primary outside repo — key baseDir test)
./run-annotate-out-of-tree.sh --keep
```

`--keep` prevents sandbox cleanup on exit so you can inspect files.
Without it, the temp directory is removed when the script exits.

Each script: builds hook, creates a temp sandbox with a fake repo +
external fixtures, launches the appropriate server, opens the browser.

## What the sandbox contains

```
$SANDBOX/
├── repo/                               ← fake project root (git init'd)
│   ├── packages/editor/App.tsx         ← ambiguous basename (1/2)
│   ├── packages/review-editor/App.tsx  ← ambiguous basename (2/2)
│   ├── packages/ui/components/Button.tsx ← unique basename
│   ├── packages/ui/index.ts
│   ├── src/utils/helper.ts             ← abbreviated path target
│   ├── src/config.json                 ← non-.ts code file
│   ├── app/[slug]/page.tsx             ← Next.js bracket-route
│   ├── node_modules/junk/App.tsx       ← must be ignored
│   └── test-plan.md                    ← fixture plan
└── external/                           ← outside the repo
    ├── notes.md                        ← annotate-out-of-tree primary
    ├── script.ts, config.yaml, bar.ts, parent.ts
    ├── design.md                       ← linked doc target
    └── sub/subdoc.md, sub/nested.ts    ← nested linked doc
```

## Checklist

### Plan mode (`run-plan.sh`)

| § | Case | Expected |
|---|------|----------|
| 1A | `packages/editor/App.tsx` (backtick, full) | Link → opens file |
| 1B | `packages/ui/components/Button.tsx` (prose, full) | Link → opens file |
| 1C | `src/config.json` (backtick, JSON ext) | Link → opens file |
| 2A | `editor/App.tsx` (abbreviated) | Link → opens packages/editor/App.tsx |
| 2B | `utils/helper.ts` (abbreviated, prose) | Link → opens src/utils/helper.ts |
| 2C | `./editor/App.tsx` (leading ./) | Link → opens packages/editor/App.tsx |
| 3A | `Button.tsx` (unique basename) | Link → opens packages/ui/components/Button.tsx |
| 3B | `App.tsx` (ambiguous basename) | Link with badge → picker → two entries |
| 3C | `helper.ts` (unique basename) | Link → opens src/utils/helper.ts |
| 4A | `packages/ui/shortcuts/core.ts` (missing, backtick) | Plain `<code>`, not clickable |
| 4B | `packages/ui/shortcuts/runtime.ts` (missing, prose) | Plain text, not a link |
| 5A | `packages/ui/{core,runtime}.ts` (braces) | Plain `<code>`, not a link |
| 5B | `packages/ui/*.tsx` (glob) | Plain `<code>`, not a link |
| 5C | `some path/with spaces/file.ts` (spaces) | Plain `<code>`, not a link |
| 6A | `app/[slug]/page.tsx` (bracket route) | Link → opens file |
| 6B | `[slug]/page.tsx` (abbreviated bracket) | Link → opens app/[slug]/page.tsx |
| 7A | `junk/App.tsx` (node_modules) | Plain text or only real App.tsx matches |
| 8A | URL with .ts extension | URL link only, no path leak |
| 8B | URL + real path on same line | Two separate links |
| 8C | Wikipedia-style parens URL | Single URL link |
| 9 | Paths inside fenced code block | No links inside the block |
| 10 | Paths inside HTML comment | Invisible, no links |
| 11A | `../script.ts` (no baseDir in plan) | Plain text (demoted) |
| 12 | Click linked doc → external/notes.md | Overlay opens; verify paths inside |

### Annotate out-of-tree (`run-annotate-out-of-tree.sh`)

| Case | Expected |
|------|----------|
| notes.md `script.ts` | Link → opens external/script.ts |
| notes.md `config.yaml` | Link → opens external/config.yaml |
| notes.md `editor/App.tsx` (cross-context) | Link → opens repo's packages/editor/App.tsx via cwd walk |
| notes.md `packages/ui/shortcuts/core.ts` | Plain text (missing everywhere) |
| Click [Open design doc] | Overlay; `bar.ts` → external/bar.ts |
| Click [Open subdoc] → subdoc.md | Overlay; `../parent.ts` → external/parent.ts |
| subdoc.md `nested.ts` | Link → opens external/sub/nested.ts |
| subdoc.md `../missing.ts` | Plain text (doesn't exist) |

### Network tab checks

- On plan/annotate load: exactly **one** `POST /api/doc/exists`
- When a linked doc overlay opens: **one** additional POST
- Plan mode POST body: `{ paths: [...] }` (no `base` field)
- Annotate out-of-tree POST body: `{ paths: [...], base: "<external dir>" }`
- Linked doc POST body: `{ paths: [...], base: "<linked doc's parent>" }`
