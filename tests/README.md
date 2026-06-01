# Tests

This directory contains manual testing scripts for Plannotator.

## UI Tests (`manual/local/`)

These scripts test the UI components and require a browser.

**Plan review UI:**

```bash
./tests/manual/local/test-hook.sh          # Claude Code simulation
./tests/manual/local/test-hook-2.sh        # OpenCode origin badge test
./tests/manual/local/test-codex-plan-review-e2e.sh  # Real Codex Stop-hook flow in disposable HOME
```

**Code review UI:**

```bash
./tests/manual/local/test-opencode-review.sh  # Code review UI test
./tests/manual/local/test-worktree-review.sh  # Worktree support test (creates sandbox with 4 worktrees)
```

See [UI-TESTING.md](../docs/UI-TESTING.md) for detailed UI testing documentation.

## Integration & Utility Tests (`manual/local/`)

These scripts test integrations, releases, and provide utilities.

**Binary release testing:**

```bash
./tests/manual/local/test-binary.sh        # Test installed binary from ~/.local/bin/
```

Tests the installed `plannotator` binary to verify releases work correctly.

**Bulk plan testing (Obsidian integration):**

```bash
./tests/manual/local/test-bulk-plans.sh    # Iterate through ~/.claude/plans/
```

Opens each `.md` file from `~/.claude/plans/` in Plannotator. Great for testing Obsidian integration with multiple
plans.

**OpenCode integration sandbox:**

```bash
./tests/manual/local/sandbox-opencode.sh [--disable-sharing] [--keep] [--no-git]
```

Creates a temporary sandbox with a sample React/TypeScript project, initializes git with uncommitted changes, sets up
the local OpenCode plugin, and launches OpenCode for full integration testing.

Options:

- `--disable-sharing`: Creates `opencode.json` with sharing disabled
- `--keep`: Don't clean up sandbox on exit
- `--no-git`: Skip git initialization (tests non-git fallback)

**Codex Stop-hook end-to-end harness:**

```bash
./tests/manual/local/test-codex-plan-review-e2e.sh [--keep] [--skip-build]
```

Builds the hook and review apps, creates a disposable `HOME` plus sample git repo, copies your Codex `auth.json`,
enables `hooks`, and runs a real `codex exec` against the sample project. The script writes logs, rollout paths,
history indices, and session URLs into an artifact directory under the temp root.

Tips:

- Set `PLANNOTATOR_BROWSER=/usr/bin/true` when you want to drive the opened plan-review session with Playwright
  instead of auto-opening a browser.
- The validated workflow is: run the script in one terminal, then point Playwright at the printed session URL from a
  second terminal.

**Obsidian utility:**

```bash
./tests/manual/local/fix-vault-links.sh /path/to/vault/plannotator
```

Adds Obsidian backlinks (`[[Plannotator Plans]]`) to existing plan files in your vault.

## SSH Remote Testing (`manual/ssh/`)

Tests SSH session detection and port forwarding for remote development scenarios.

```bash
cd tests/manual/ssh/
docker-compose up -d
./test-ssh.sh
```

See [manual/ssh/DOCKER_SSH_TEST.md](manual/ssh/DOCKER_SSH_TEST.md) for detailed setup instructions.
