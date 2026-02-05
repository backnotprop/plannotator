# Tests

This directory contains manual testing scripts for Plannotator.

## UI Tests (`manual/local/`)

These scripts test the UI components and require a browser.

**Plan review UI:**

```bash
./tests/manual/local/test-hook.sh          # Claude Code simulation
./tests/manual/local/test-hook-2.sh        # OpenCode origin badge test
```

**Code review UI:**

```bash
./tests/manual/local/test-opencode-review.sh  # Code review UI test
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
