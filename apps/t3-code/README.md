# Ask this session in T3 Code

Claude keeps using ordinary Plannotator commands. An optional installer-managed Claude hook connects supported review launches to the originating T3 conversation automatically, after one-time authorization. **Ask this session** sends a question into that conversation and displays its answer in the review.

This is a Plannotator-only integration. It uses T3's existing external MCP API as a client. It requires no T3 code change, provider-side Plannotator MCP server, or change to the Plannotator skill. Inbox is outside this integration.

## Setup

T3 support is off by default and is not registered by the Claude plugin. In a release containing this integration, opt in through the Bash installer (macOS/Linux):

```sh
bash scripts/install.sh --with-t3
```

The flag installs one `PreToolUse` Bash hook into `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`. It preserves other hooks and settings, backs up existing settings before the first change, and pins the installed binary and selected Plannotator data directory in the hook command. Automatic updates replay the installation flag. An install without either T3 flag leaves any existing T3 hook alone. `--minimal` remains binary-only and skips both T3 flags.

The currently released installer does not include this experimental integration. To test this source checkout without downloading an older release, build the binary:

```sh
bun install --frozen-lockfile
bun run build:review
bun run build:hook
bun run build:t3
```

For local testing, the same settings helper can register the built binary directly. Use the Claude profile that T3 loads, or an isolated project's `.claude/settings.local.json`:

```sh
./apps/t3-code/dist/plannotator t3-hook install \
  --settings /absolute/path/to/claude/settings.json \
  --executable "$PWD/apps/t3-code/dist/plannotator"
```

`t3-hook` is an internal installer/helper command; agents do not invoke it. The commands below use `plannotator` for that build (`apps/t3-code/dist/plannotator`). A running Claude provider session needs to restart to load changed hooks. The normal Claude plugin is unchanged and is not needed to register the T3 hook; its plan-review integration remains separate. The live routing verification used an equivalent command hook in isolated project settings. Installer tests use isolated profiles rather than changing a person's installed configuration.

In T3 Settings → Connections, copy the environment's MCP URL. A person authorizes once:

```sh
plannotator t3 login --url http://127.0.0.1:3773/mcp
```

T3 opens its sign-in page. Pick a permission ceiling that covers the conversation; a supervised grant cannot send messages into a full-access conversation. Credentials are private files under the Plannotator data directory. The binary, hook and worker must share that directory and run on the T3 environment's machine, where its project files are accessible. Set `PLANNOTATOR_DATA_DIR` consistently when installing the hook and logging in to use isolated storage. A revoked or expired grant requires login again. The installer does not authorize T3 or open its sign-in page automatically.

To disable future routing, use `bash scripts/install.sh --without-t3` in the same Claude profile. This removes only the T3 hook and preserves credentials, other settings and hooks. Restart the Claude provider session to unload the hook. Already-open reviews and workers remain available; use the diagnostic stop/close commands below to manage them. For a source-build test, `plannotator t3-hook remove --settings /absolute/path/to/claude/settings.json` removes the test hook without running the download installer.

## Use ordinary commands

The existing skill and agent commands remain unchanged:

```sh
plannotator annotate notes.md --gate
plannotator review --base origin/main
plannotator last
```

The agent needs no T3 URL, thread ID or awareness of T3. Claude's `PreToolUse` hook supplies the native tool-call ID. Plannotator finds the exact running activity item through the authorized T3 API, checks its source conversation and actual working directory, then supplies the connection internally. It never chooses a conversation by title or folder. The updated command still passes through Claude/T3's normal permission checks.

The command returns after the review opens. Its detached worker keeps the connection after the shell command finishes. The command output tells Claude to end its turn and wait for review feedback. **Ask this session** questions then become ordinary turns in the same conversation. Answers are correlated by message and run ID, including queued runs and long answers. A busy conversation can delay a question. Questions and answers remain in T3 history; transient answers are unavailable.

Submitted feedback and approvals also arrive in that conversation, naming the review's `pn-` ID and full target. **Stop listening** stops displaying an answer while an already submitted T3 turn may continue. The integration never steers or interrupts existing work.

## Routing limits

Automatic routing currently targets Claude's simple Bash invocations of `review`, `annotate`, and `last`/`annotate-last`, using the command parser already shared with Plannotator's native Claude mod. Compound shell commands, unknown options, strict scripted gates (`--require-approval` or `--result-file`), and native subagent hooks retain their ordinary behavior. No saved connection or no exact live match also leaves the command unchanged. Discovery errors or ambiguous ownership report that the automatic connection is unavailable without attaching the review to another conversation.

This does not add automatic T3 routing to `ExitPlanMode`, another provider, or a human's direct terminal invocation. Existing plan hooks and other Plannotator commands continue to work. The native ID mapping was verified against T3 Code Nightly `0.0.46-nightly.20261008.2833`; a future incompatible mapping will prevent automatic binding and needs a compatibility check.

## Recovery and diagnostics

The worker adopts open reviews after restarting. Private result files retain decisions for delivery. Explicitly scoped commands remain available for diagnostics; agents do not need them in the ordinary flow:

```sh
plannotator t3 list --url <url> --thread <id>
plannotator t3 close <pn-id-or-all> --url <url> --thread <id>
plannotator t3 status --url <url> --thread <id>
plannotator t3 stop --url <url> --thread <id>
```

Closing preserves unsent comments as a draft and sends no decision. Stopping disconnects the worker while reviews stay open. Queued decisions use stable request IDs. A response lost after acceptance can be retried under the same OAuth grant. An uncertain delivery from an older grant is retained and refused after reauthorization because T3's idempotency namespace changed. Inspect the conversation before reconciling it.

Private credentials, hook launches, results, pending decisions and logs live under `<data dir>/t3-code/`. They contain feedback and conversation messages. Nothing prunes them; delete them when no longer needed. Worker errors are in `daemon.log`; review errors are in `cli.log`.

## Checks

`bun test scripts/install.test.ts packages/server/auto-update.test.ts packages/server/uninstall.test.ts` checks the opt-in installation, removal, settings preservation, binary/data-directory quoting, automatic-update flags and uninstall cleanup in isolated profiles. `bun test apps/t3-code` drives the native hook and compiled CLI against a scripted T3 MCP server and actual isolated Plannotator review servers. It checks exact tool-call ownership across pages and identical folders, ambiguous/inherited/settled call refusal, unchanged command input and permissions, Ask, decision delivery, worker recovery, thread isolation, and that no Inbox is created.

Live verification additionally opened a review from Claude's ordinary `plannotator annotate notes.md --gate` command and entered a question through its rendered **Ask this session · T3 Code** panel. The answer identified the originating conversation and review. No T3 source or Plannotator skill was changed.
