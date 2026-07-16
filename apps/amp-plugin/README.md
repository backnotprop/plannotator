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
