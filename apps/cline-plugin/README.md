# @plannotator/cline

Plannotator for [Cline](https://github.com/cline/cline). It connects each Cline session to the [Plannotator Inbox](https://plannotator.ai/docs/reference/inbox/): the agent gets a `plannotator_inbox` tool to send you messages and questions, the session shows up when you write a new message in the Inbox, and your replies arrive in the session as a new turn.

## Install

```bash
cline plugin install npm:@plannotator/cline
```

It works in the Cline CLI, Kanban, the desktop app and the new version of the VS Code extension. The extension's Legacy version loads no plugins: there, add the Inbox's MCP server in Cline's MCP settings instead.

It needs the `plannotator` CLI:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## Turn it on

The Inbox tool is off by default, because Cline sends every tool's definition with each request. Turn it on for Cline in the Inbox's **Settings → Agents**, or add `{ "inboxTool": { "cline": true } }` to `~/.plannotator/config.json`, keeping its other keys. The tool appears only once the Inbox has run on this computer; if it never has, start it once with `plannotator inbox --background`. It applies to Cline sessions started after that.

## Good to know

- Your reply waits until the session is idle, then starts a turn. It never goes into a running turn.
- Cline stops a plugin after 30 minutes with nothing to do. The session then leaves the Inbox's list until you next type in it; a reply sent meanwhile arrives after that turn. To keep sessions reachable longer, set `CLINE_PLUGIN_IDLE_TIMEOUT_MS` (in milliseconds) in the environment Cline starts in.
- The plugin only connects out to the Inbox on `127.0.0.1`.
