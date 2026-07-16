# Plannotator for Droid

Plannotator's Droid plugin ships the manual slash-command workflow only:

- `/plannotator-review [PR_URL]` (no args reviews local changes)
- `/plannotator-annotate <file|folder|url>`
- `/plannotator-last`

It does not attempt plan-mode interception or host-level planning integration.

## Install

Install the `plannotator` CLI first:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then add the marketplace and install the plugin:

```bash
droid plugin marketplace add https://github.com/backnotprop/plannotator
droid plugin install plannotator@plannotator
```

For local development:

```bash
cd /path/to/plannotator
droid plugin marketplace add "$PWD"
droid plugin install plannotator@plannotator
```

## Notes

- The plugin expects `plannotator` on `PATH`.
- Review and annotate flows still open the Plannotator browser UI and return the result to the Droid session.
- The command wrappers set `PLANNOTATOR_ORIGIN=droid` so the UI can label the host correctly.
