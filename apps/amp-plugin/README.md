# Plannotator for Amp

This is a native Amp plugin for the manual Plannotator workflows:

- `Plannotator: Review changes`
- `Plannotator: Review changes or PR` (leave blank for local changes)
- `Plannotator: Annotate file`
- `Plannotator: Annotate last answer`

Amp commands live in the command palette, not as slash commands. This plugin does
not intercept Amp's planning flow.

## Install

Install the `plannotator` CLI first:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then install the Amp plugin:

```bash
mkdir -p ~/.config/amp/plugins
curl -fsSL https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/amp-plugin/plannotator.ts \
  -o ~/.config/amp/plugins/plannotator.ts
```

Restart Amp or run `plugins: reload` from the command palette.

For project-local installation, copy the plugin to:

```text
.amp/plugins/plannotator.ts
```

## CLI compatibility and feedback recovery

The review commands require a CLI that supports `plannotator review --json` and
returns a structured `{ decision, message }` result. The plugin uses the decision
to distinguish a dismissal from feedback or approval, never words in the
reviewer's text. Review feedback and approval instructions are appended to the
Amp thread; a dismissed review only shows a notification. Running
`plannotator review` directly still produces plaintext by default.

Annotation commands use the CLI's `{ decision, feedback? }` JSON result. Feedback
and approval notes are appended using your configured annotation prompts; an
approval without notes only shows an approval notification.

If an older CLI returns plaintext, or a command succeeds with malformed or
missing structured output, the plugin shows an **invalid structured output**
notification instead of guessing a decision. The notice includes the captured
stdout and stderr so you can recover any feedback manually. Update the CLI with
the install command above, then reload the Amp plugin. If you use
`PLANNOTATOR_BIN` or a source-entry override, update that selected CLI as well.

## Local Development

From a Plannotator checkout:

```bash
mkdir -p .amp/plugins
ln -sf ../../apps/amp-plugin/plannotator.ts .amp/plugins/plannotator.ts
export PLANNOTATOR_AMP_USE_SOURCE=1
export PLANNOTATOR_CWD="$PWD"
```

Run `plugins: reload` in Amp. When the plugin is loaded from this repository, it
runs the checkout's source entrypoint instead of a global `plannotator` binary.
You can also point directly at a source entry:

```bash
export PLANNOTATOR_AMP_SOURCE_ENTRY=/path/to/plannotator/apps/hook/server/index.ts
```
