#!/usr/bin/env bash
# make-repo.sh
#
# Create a temp git repo with a single committed file, then mutate it so that
# `git diff` produces a known patch. Used as a fixture for the e2e tests that
# exercise `plannotator review`.
#
# Usage:
#   make-repo.sh                  # creates a fresh mktemp directory
#   make-repo.sh /path/to/dest    # uses the supplied directory (created if needed)
#
# Prints the absolute path of the repo to stdout on success.

set -euo pipefail

DEST="${1:-}"
if [[ -z "${DEST}" ]]; then
  DEST="$(mktemp -d -t plannotator-e2e-repo.XXXXXX)"
else
  mkdir -p "${DEST}"
fi

cd "${DEST}"

git init -q -b main
git config user.email "e2e@plannotator.test"
git config user.name "Plannotator E2E"

cat > greet.ts <<'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF

cat > README.md <<'EOF'
# Demo Repo

This repo exists for the plannotator review end-to-end tests.
EOF

git add greet.ts README.md
git commit -q -m "initial commit"

# Mutate greet.ts so `git diff` shows a known unstaged change.
cat > greet.ts <<'EOF'
export function greet(name: string, exclaim: boolean = true): string {
  const punctuation = exclaim ? "!" : ".";
  return `Hello, ${name}${punctuation}`;
}
EOF

# Add an untracked file so review fixtures can also exercise that path.
cat > NOTES.md <<'EOF'
Untracked notes used by the review fixture.
EOF

echo "${DEST}"
