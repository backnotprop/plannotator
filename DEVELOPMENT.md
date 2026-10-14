# Developing Plannotator

## Requirements

- Bun runtime
- Claude Code with plugin/hooks support, or OpenCode
- Cross-platform: macOS (`open`), Linux (`xdg-open`), Windows (`start`)

## Development

```bash
bun install

# Run any app
bun run dev:hook       # Hook server (plan review)
bun run dev:review     # Review editor (code review)
bun run dev:portal     # Portal editor
bun run dev:marketing  # Marketing site
bun run dev:vscode     # VS Code extension (watch mode)
```

**Local `plannotator` command:** run `bun link` once in the checkout to make the global `plannotator` command use this repo's source (`apps/hook/server/index.ts`) instead of an installed release binary. Commands like `plannotator review` then reflect local changes immediately. Rebuild the bundled HTML when changing UI code (see Build below).

## Testing Rules

A test must guard a behavior that can actually regress. Before writing one, name the failure it catches; if you can't, don't write it.

- **Pin copy only on purpose, never as a snapshot.** Locking a short user-facing string is legitimate when it is a deliberate decision — an action label ("Approve"), a command name, a legally/UX-critical phrase the maintainer wants frozen so agents can't drift it. Mark it as such in a comment. What is banned is incidentally snapshotting explanatory prose (intro dialogs, setting descriptions, empty-state copy) with `toBe` just because it was on screen when the test was written — that couples wording edits to test churn while guarding nothing. If such a string carries data that must stay truthful (a server-computed size, a language list, a version), assert those facts with `toContain` on the data, not the sentence around them.
- **No round-trip prop tests.** Asserting that a hardcoded string passed as a prop appears in the DOM verifies nothing — any string round-trips. If the only thing worth checking is "this prop renders somewhere," use a sentinel string and one assertion, and say so in a comment.
- **Assert behavior, not implementation echo.** A test that restates what the code obviously does (calls X with Y, sets state to Z) without exercising an observable outcome is noise; it breaks on refactors and catches nothing.
- **Bun runs every test file in one process.** Never mutate `process.env`, `~/.plannotator`, or any global at module scope; mutate inside tests with restore in `finally`/`afterEach`, and sandbox all server/data-dir interaction under a temp `PLANNOTATOR_DATA_DIR`. Never read or write the real user config.
- **Tests and dev scripts never reach the real Inbox or data dir.** Bun reads only the `bunfig.toml` of the folder `bun test` runs from, so the preload sandbox is mirrored into every folder people run tests from (`tests/package-bunfig.test.ts`), and the Inbox test helpers sandbox on import as well (`tests/setup/sandbox-data-dir.ts` does what the preload does: `PLANNOTATOR_DATA_DIR` becomes a fresh temp folder unless it already is a scratch folder, inside the OS temp dir or `/tmp` or the `PLANNOTATOR_TEST_SANDBOX` the preload marks). Only scratch folders count because a relocated data dir (`PLANNOTATOR_DATA_DIR=/custom` in the person's shell) is just as real as `~/.plannotator`; `tests/helpers/real-data-dir.ts` also works out the default like the product does, for both `$HOME` and the account's own home, `$XDG_DATA_HOME` included. Dev scripts that start an Inbox (`scripts/dast/target.ts`, `scripts/inbox-sim.ts`, `tests/helpers/inbox-dom-server.ts`) accept only a scratch data dir, and point `PLANNOTATOR_DATA_DIR` at it (the Inbox reads `config.json` through the env even when given `dataDir`). Signal an Inbox only through `tests/helpers/inbox-process.ts` (or `signalInbox` / `stopInbox` in `tests/helpers/inbox-world.ts`, `stopScratchInbox` in the e2e specs), never `process.kill` on a pid read from a registry; write `apps/hook/dist` stubs only with `tests/helpers/hook-dist-stub.ts`, which removes exactly the stubs it wrote and never the folder. `tests/never-touch-the-real-inbox.test.ts` scans every test and script (`tests/helpers/real-inbox-scan.ts`, comments stripped) for a signal in Inbox code (`process.kill`, a `kill`/`pkill` spawn or shell string, `kill` taken off `process`; a test's own non-Inbox child may carry an `inbox-guard: own child` comment), a path from the home dir to `.plannotator` (any line, a multi-line `join`, a variable from `homedir()`, the literal `~/.plannotator` used as a path), and a `startInboxServer` call without `dataDir` (or, in a script, without pointing `PLANNOTATOR_DATA_DIR` at it). The proof (`provenInbox`) also requires the test's folder to be a scratch folder and the Inbox's working directory inside it whenever it can be read.

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
