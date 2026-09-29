# Plannotator Codex plugin

Annotate a document in Plannotator and send the feedback straight back to Codex.

The plugin adds an MCP server (`plannotator mcp`) with one model-facing tool,
`annotate`, and a skill, `plannotator-annotate`, that tells Codex when to call it.
The tool opens a markdown file, a folder of documents, or a URL in the
Plannotator UI in your browser. It waits while you annotate. When you send
feedback, approve, or close the session, Codex receives the result as the tool
output and continues from it.

This works in the Codex CLI, the TUI, and the desktop app. Plan review
(`submit_plan`) is not part of this plugin yet.

## Requirements

- The `plannotator` binary on `PATH`, with the `mcp` subcommand. Install it with
  `curl -fsSL https://plannotator.ai/install.sh | bash`, then check it with
  `plannotator mcp --help`.
- Codex with plugin support.

## Install from a local checkout

```bash
codex plugin marketplace add /path/to/plannotator/apps/codex-plugin
codex plugin add plannotator@plannotator-local
```

Codex copies the plugin into its plugin cache. After you change files in this
directory, run `codex plugin remove plannotator@plannotator-local` and add it
again.

Restart Codex after you install the plugin. Then ask:

```text
Annotate docs/plan.md in Plannotator.
```

## How it works

- Codex starts `plannotator mcp` in the session's working directory. Relative
  targets resolve against that directory. The tool also accepts an explicit `cwd`.
- The tool call blocks until you decide. `.mcp.json` sets `tool_timeout_sec` to
  345600 (4 days), because the Codex default of 300 seconds is too short for a
  human review.
- If you interrupt the turn or the call times out, the Plannotator session closes.
- The result text is what `plannotator annotate` prints: your feedback, or
  `The user approved.`. If you close the session without feedback, the text
  says so. The structured result is the `plannotator annotate --json` record.
- The tool is marked read-only, so Codex does not ask for approval before it runs.
  It does not modify your files. Like the CLI, it keeps version history and
  feedback records under `~/.plannotator`.

## Environment variables

Codex starts MCP servers with a minimal environment (`HOME`, `PATH`, `SHELL`,
`USER`, `LANG`, `TERM`, `TMPDIR`, and a few others). `.mcp.json` lists the
Plannotator variables to pass through in `env_vars`. Without that list,
`PLANNOTATOR_REMOTE`, `SSH_CONNECTION`, and `PLANNOTATOR_PORT` would not reach
the server, and remote detection would silently fail.

## Remote and SSH sessions

In remote mode Plannotator does not open a browser. The session URL goes to:

- the MCP server's stderr, which Codex writes to its log;
- an MCP log notification and a progress notification;
- `plannotator sessions` on the remote host, which lists the live URL.

Codex only logs MCP notifications; it does not show them in the chat. Run
`plannotator sessions` on the remote host to get the URL, and forward the port
(default `19432`).

## Desktop app view (experimental)

The `annotate` tool declares an MCP Apps view, `ui://plannotator/annotate`. The
view is a small status card, not the Plannotator UI. It shows the session
state and URL and has an **Open Plannotator** button. The Codex desktop app
renders MCP Apps views only when OpenAI's `enable_mcp_apps` experiment is on for
your account. When it is off, nothing changes: the tool result still carries
the feedback.

The view does not post the feedback again when the host delivers the tool
result. It posts the feedback into the thread with `ui/message` only when the
session finished but the host never delivered the result to the view.

## Coexistence with the other Codex integrations

The installer (`scripts/install.sh`) does not install this plugin. It still
installs the Codex `Stop` hook for plan review and the core skills under
`~/.agents/skills` (`plannotator-annotate`, `plannotator-review`,
`plannotator-last`). Those skills run the `plannotator` CLI through the shell.
This plugin's skill calls the MCP tool instead. You can have both installed:
Codex namespaces plugin skills under the plugin name.

## Local development

Build a dev binary and put it first on `PATH` for Codex:

```bash
bun run --cwd apps/review build && bun run build:hook
bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  --define '__CLI_VERSION__="0.0.0-dev"' --outfile /tmp/plannotator-dev/plannotator
PATH=/tmp/plannotator-dev:$PATH codex
```

`PLANNOTATOR_SKIP_BROWSER_OPEN=1` keeps the browser closed, so you can drive
the session over HTTP (`POST <url>/api/feedback`). The live session URL is in
`plannotator sessions`.
