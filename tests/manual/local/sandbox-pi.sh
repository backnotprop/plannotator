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

# Create sample project
cat > README.md << 'EOF'
# Sample Project

This is a sandbox for testing the Plannotator Pi extension.

## Features
- Plan review with annotations
- Code review for git diffs
- File annotation
- Last message annotation
EOF

mkdir -p src
cat > src/index.ts << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// TODO: Add more features
console.log(greet("World"));
EOF

# Commit initial files
if [ "$NO_GIT" = false ]; then
  git add -A
  git commit -q -m "Initial commit"

  # Add uncommitted changes (for /plannotator-review)
  cat >> src/index.ts << 'EOF'

export function farewell(name: string): string {
  return `Goodbye, ${name}!`;
}
EOF
fi

echo ""
echo "=== Sandbox Ready ==="
echo ""
echo "Directory: $SANDBOX_DIR"
if [ "$NO_GIT" = true ]; then
  echo "Git: DISABLED"
else
  echo "Git: enabled (with uncommitted changes)"
fi
echo ""
echo "To test:"
echo "  1. Plan mode: Ask the agent to plan something"
if [ "$NO_GIT" = false ]; then
  echo "  2. Code review: Run /plannotator-review"
fi
echo "  3. Annotate file: Run /plannotator-annotate README.md"
echo "  4. Annotate last: Run /plannotator-last"
echo ""
echo "Launching Pi..."
echo ""

# Launch Pi with only the local extension (no globally installed extensions)
cd "$SANDBOX_DIR"
pi --no-extensions -e "$PI_EXT_DIR"
