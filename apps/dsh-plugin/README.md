# @plannotator/dsh

Plannotator for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). When the agent leaves plan mode, `exit_plan_mode` opens the plan in Plannotator instead of DSH's own review card. Annotate it, then approve, approve with notes, or send feedback to keep planning. `/plannotator-review`, `/plannotator-annotate` and `/plannotator-last` open code review and annotation without blocking the session. With the inbox tool on, the agent can also reach you through the Plannotator Inbox, and your replies wake its session.

## Requirements

- DeepSeek Harness 0.2.1-rc.2 or newer, below 0.3.0.
- The `plannotator` CLI:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## Install

From the Plugins page in DSH Web or Desktop, add `@plannotator/dsh`. Or from a terminal:

```bash
dsh plugin --profile <profile> add @plannotator/dsh
```

For the Desktop app's profile, open Desktop once, quit it, then run `dsh plugin --profile desktop add @plannotator/dsh`. A new install loads without a restart; after updating the package, restart DSH.

## How it works

- **Plan review.** DSH asks for the review through its user-questions waterfall. The plugin answers plan reviews only: it runs `plannotator dsh-plan`, waits for your decision, and answers DSH with Approve, or Keep planning with your feedback. Approve with notes approves the plan and then sends the notes to the agent as a message. Every other question goes to DSH as usual.
- **Fallback.** If the CLI is missing, fails, or prints something unexpected, the plugin hands the review back to DSH's own card. Cancelling the turn closes the review.
- **Plannotator Inbox.** With the inbox tool on, the agent gets a `plannotator_inbox` tool. It uses the tool to send you messages and questions in the [Plannotator Inbox](https://plannotator.ai/docs/reference/inbox/#deepseek-harness). When the session is idle, your reply arrives as a new turn. **Send now** steers it into the running turn. The tool is off by default, because DSH sends every tool's definition with each request. To turn it on for DeepSeek Harness alone, use the Inbox's **Settings → Agents**, or add `{ "inboxTool": { "dsh": true } }` to `~/.plannotator/config.json`, keeping its other keys. (`plannotator inbox` also turns it on when it finds this plugin, but it connects every other agent it finds too.) The tool appears only once the Plannotator Inbox has run on this computer, so if it never has, start it once with `plannotator inbox --background`. It applies when DeepSeek Harness next starts, so restart DSH. (`PLANNOTATOR_INBOX_TOOL=1` would turn the tool on for every agent and lock the switches in Settings, and DSH Desktop does not see it unless started from that shell.) Nothing is registered and nothing polls when the tool is off, before you have run the Inbox once, or in the `headless`, `sdk`, `sdk-minimal` and `acp` profiles. The plugin only connects out to the Inbox on `127.0.0.1`, and reads the Inbox's key from `~/.plannotator/inbox/inbox.json` for each request. It keeps no copy of the key, and never puts it in its config, a log, a tool result or a message.
- **Review, annotate, last.** The plugin adds the commands `/plannotator-review [directory | PR URL] [--base <ref>]`, `/plannotator-annotate <file | folder | URL> [--gate] [--markdown]` and `/plannotator-last`. Each one opens Plannotator and returns at once. The agent is not busy while you review. When you send your feedback, it arrives in the session as a new turn.
- **The `plannotator` tool.** With the tool on, the agent can open the same reviews itself, for example when you ask it to "open notes.md in Plannotator". The call returns once the page is open, and your feedback arrives later as a new turn. The tool is off by default, because DSH sends every tool's definition with each request. To turn it on, set `PLANNOTATOR_AGENT_TOOL=1` or add `{ "agentTool": true }` to `~/.plannotator/config.json` (this turns it on for every agent that has the tool), then restart DSH.
- **Not in every profile.** The tool and the commands are not added in the `headless`, `sdk`, `sdk-minimal` and `acp` profiles. There, and from a DSH shell, Plannotator's skills in `~/.agents/skills` run the CLI as before. The CLI recognizes DSH shells (`DSH_SHELL`), labels the session DeepSeek Harness, and `plannotator last` reads the calling session's log under `$DSH_HOME/sessions`.

## Configuration

Both keys are optional. Set them by overriding the plugin's row in your profile's `cordis.patch.yml`:

```yaml
- id: plannotator
  config:
    binary: /Users/me/.local/bin/plannotator
    planReview: true
```

| Key | Default | Meaning |
|---|---|---|
| `binary` | `PLANNOTATOR_BIN`, then `plannotator` on `PATH`, then `~/.local/bin/plannotator` (`%LOCALAPPDATA%\plannotator\plannotator.exe` on Windows) | The Plannotator CLI to run. Set it when DSH cannot find the CLI, for example when DSH Desktop starts with a `PATH` that lacks the install folder. |
| `planReview` | `true` | `false` leaves `exit_plan_mode` to DSH's own review card. |

Plan prompts follow your Plannotator config: `prompts.plan` in `~/.plannotator/config.json`, with `runtimes.dsh` for DSH-only wording.

## Development

```bash
bun run build:dsh            # from the repo root; writes apps/dsh-plugin/dist/index.js
bun test apps/dsh-plugin
dsh plugin --profile <profile> add link:/absolute/path/to/apps/dsh-plugin
```
