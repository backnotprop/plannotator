#!/bin/bash
# Sandbox script for testing Plannotator Pi extension locally
#
# Usage:
#   ./sandbox-pi.sh [--keep] [--no-git]
#
# Options:
#   --keep    Don't clean up sandbox on exit (for debugging)
#   --no-git  Don't initialize git repo
#
# What it does:
#   1. Builds the Pi extension (copies HTML from hook/review)
#   2. Creates a temp directory with sample files
#   3. Installs the local extension via `pi install`
#   4. Launches Pi in the sandbox
#
# To test:
#   - Plan mode: Ask the agent to plan something
#   - Code review: Run /plannotator-review
#   - Annotate file: Run /plannotator-annotate README.md
#   - Annotate last: Run /plannotator-last

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PI_EXT_DIR="$PROJECT_ROOT/apps/pi-extension"

# Parse CLI flags
KEEP_SANDBOX=false
NO_GIT=false
for arg in "$@"; do
  case $arg in
    --keep)
      KEEP_SANDBOX=true
      shift
      ;;
    --no-git)
      NO_GIT=true
      shift
      ;;
  esac
done

echo "=== Plannotator Pi Sandbox ==="
echo ""

# Build the extension
echo "Building Pi extension..."
cd "$PROJECT_ROOT"
bun run build:hook > /dev/null 2>&1
bun run build:review > /dev/null 2>&1

cd "$PI_EXT_DIR"
bun run build
echo "Build complete."
echo ""

# Create temp directory
SANDBOX_DIR=$(mktemp -d)
echo "Created sandbox: $SANDBOX_DIR"

# Cleanup on exit (unless --keep)
cleanup() {
  echo ""
  if [ "$KEEP_SANDBOX" = true ]; then
    echo "Keeping sandbox at: $SANDBOX_DIR"
    echo "To clean up manually: rm -rf $SANDBOX_DIR"
  else
    echo "Cleaning up sandbox..."
    rm -rf "$SANDBOX_DIR"
    echo "Done."
  fi
}
trap cleanup EXIT

# Initialize git repo (unless --no-git)
cd "$SANDBOX_DIR"
if [ "$NO_GIT" = false ]; then
  git init -q
  git config user.email "test@example.com"
  git config user.name "Test User"
fi

# Create sample project (base files — committed history lives on `main`)
cat > README.md << 'EOF'
# Sample Project

This is a sandbox for testing the Plannotator Pi extension.

## Features
- Plan review with annotations
- Code review for git diffs
- File annotation
- Last message annotation
EOF

cat > package.json << 'EOF'
{
  "name": "sandbox",
  "version": "1.0.0",
  "type": "module"
}
EOF

mkdir -p src
cat > src/index.ts << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet("World"));
EOF

cat > src/utils.ts << 'EOF'
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
EOF

cat > src/legacy.ts << 'EOF'
// Deprecated helper kept only for backwards compatibility.
export function oldGreet(name: string): string {
  return "Hi " + name;
}
EOF

# Build rich git state so /plannotator-review can exercise every diff mode:
# uncommitted, staged, unstaged, last-commit, branch, and merge-base.
if [ "$NO_GIT" = false ]; then
  # ── main: two commits of history ──
  git add -A
  git commit -q -m "Initial commit"
  git branch -M main

  cat > src/math.ts << 'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
  printf '\n## Status\nActive.\n' >> README.md
  git add -A
  git commit -q -m "Add math utilities"

  # ── feature branch: diverges from main (powers branch / merge-base diff) ──
  git checkout -q -b feature/widgets

  cat > src/widget.ts << 'EOF'
export interface Widget {
  id: string;
  label: string;
}

export function renderWidget(w: Widget): string {
  return `[${w.id}] ${w.label}`;
}
EOF
  printf '\nexport const VERSION = "1.0";\n' >> src/index.ts
  git add -A
  git commit -q -m "Add widget module"

  # last commit: a rename + a delete + a modify (rich single-commit diff)
  git mv src/utils.ts src/helpers.ts
  git rm -q src/legacy.ts
  printf '\nexport const PI = 3.14159;\n' >> src/math.ts
  git add -A
  git commit -q -m "Refactor: rename utils -> helpers, drop legacy, extend math"

  # ── working tree: staged + unstaged + untracked, all at once ──
  # staged (modify + brand-new file, both git-added)
  printf '\nexport const WIDGET_LIMIT = 100;\n' >> src/widget.ts
  cat > src/staged-feature.ts << 'EOF'
export function staged(): string {
  return "this change is staged";
}
EOF
  git add src/widget.ts src/staged-feature.ts

  # unstaged (modify tracked files, NOT added)
  printf '\n// FIXME: handle empty input\n' >> src/index.ts
  printf '\n## Notes\nWork in progress.\n' >> README.md

  # untracked (new files, never added)
  cat > src/scratch.ts << 'EOF'
// Scratch experiment, not yet tracked.
export const scratch = true;
EOF
  cat > notes.md << 'EOF'
# Scratch notes

Untracked working-tree file.
EOF
fi

echo ""
echo "=== Sandbox Ready ==="
echo ""
echo "Directory: $SANDBOX_DIR"
if [ "$NO_GIT" = true ]; then
  echo "Git: DISABLED"
else
  echo "Git: branch 'feature/widgets' off 'main' (2 commits each)"
  echo "     staged:    src/widget.ts (mod), src/staged-feature.ts (new)"
  echo "     unstaged:  src/index.ts, README.md"
  echo "     untracked: src/scratch.ts, notes.md"
  echo "     last commit: rename utils->helpers, delete legacy, modify math"
  echo "     vs main: widget add + index/math changes (branch / merge-base)"
fi
echo ""
echo "To test:"
echo "  1. Plan mode: Ask the agent to plan something"
if [ "$NO_GIT" = false ]; then
  echo "  2. Code review: Run /plannotator-review"
  echo "     Switch diff mode in the UI to exercise uncommitted / staged /"
  echo "     unstaged / last-commit / branch / merge-base."
fi
echo "  3. Annotate file: Run /plannotator-annotate README.md"
echo "  4. Annotate last: Run /plannotator-last"
echo ""
echo "Launching Pi..."
echo ""

# Launch Pi with only the local extension (no globally installed extensions)
cd "$SANDBOX_DIR"
pi --no-extensions -e "$PI_EXT_DIR"
