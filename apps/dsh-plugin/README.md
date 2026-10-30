# @plannotator/dsh

Plannotator for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). When the agent leaves plan mode, `exit_plan_mode` opens the plan in Plannotator instead of DSH's own review card. Annotate it, then approve, approve with notes, or send feedback to keep planning.

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
- **Review, annotate, last.** These need no plugin. The installer puts Plannotator's skills in `~/.agents/skills`, which DSH reads, so `/plannotator-review`, `/plannotator-annotate` and `/plannotator-last` work in DSH. The CLI recognizes DSH shells (`DSH_SHELL`), labels the session DeepSeek Harness, and `plannotator last` reads the calling session's log under `$DSH_HOME/sessions`.

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
