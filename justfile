repo_root := justfile_directory()
planning_justfile := env_var("HOME") / "gitclones/ai/planning/justfile"

derive-tags target="plans/features":
  @just --justfile {{planning_justfile}} derive-tags {{repo_root / target}}

check-schema target="plans/features":
  @just --justfile {{planning_justfile}} check-schema {{repo_root / target}} {{repo_root / ".nimbalyst/trackers"}}

dag target="plans/features" out="plans/plan-dag.md":
  @just --justfile {{planning_justfile}} dag {{repo_root / target}} {{repo_root / out}} {{repo_root / ".nimbalyst/trackers"}}

validate target="plans/features" schema_dir=".nimbalyst/trackers" out="plans/plan-dag.md":
  @just --justfile {{planning_justfile}} validate {{repo_root / target}} {{repo_root / schema_dir}} {{repo_root / out}}

install-planning-schemas dest=".nimbalyst/trackers":
  @just --justfile {{planning_justfile}} install-schemas {{repo_root / dest}}

# Build recipes
build-hook:
  bun run build:hook

build-opencode:
  bun run build:opencode

build-vscode:
  bun run build:vscode

build:
  bun run build

# Run each test file sequentially to prevent concurrent daemon/build explosions.
test:
  #!/usr/bin/env bash
  set -euo pipefail
  failed=0
  for f in \
    tests/nim-17.submit-wait-proof.test.ts \
    tests/nim-18.cli-contract-proof.test.ts \
    tests/nim-19.notification-proof.test.ts \
    tests/nim-20.agent-wrapper-proof.test.ts \
    tests/e2e/specs/01-binary.spec.ts \
    tests/e2e/specs/02-daemon-lifecycle.spec.ts \
    tests/e2e/specs/03-state-machine.spec.ts \
    tests/e2e/specs/04-submit-plan.spec.ts \
    tests/e2e/specs/05-review-mode.spec.ts \
    tests/e2e/specs/06-annotate-mode.spec.ts \
    tests/e2e/specs/07-wait-recovery.spec.ts \
    tests/e2e/specs/08-clear-contingency.spec.ts \
    tests/e2e/specs/09-history-storage.spec.ts \
    tests/e2e/specs/10-ui-actions.spec.ts \
    tests/e2e/specs/11-cancel-and-reset.spec.ts \
    tests/e2e/specs/12-json-output.spec.ts \
    tests/e2e/specs/13-claude-hook-shim.spec.ts \
    tests/e2e/specs/14-opencode-shim.spec.ts \
    tests/e2e/specs/99-deletions-and-doc.spec.ts \
  ; do
    echo "=== $f ==="
    bun test "$f" || failed=1
    pkill -9 -f "plannotator daemon" 2>/dev/null || true
  done
  exit $failed
