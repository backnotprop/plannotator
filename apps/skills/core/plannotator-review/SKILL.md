---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree or a pull request URL, then act on the feedback that comes back.
disable-model-invocation: true
---

# Plannotator Review

Use this skill when the user wants to review current code changes in Plannotator instead of reading a diff inline.

Run:

```bash
plannotator review [optional-pr-url]
```

Behavior:

1. Launch the command with Bash.
2. Wait for it to finish.
3. If it returns feedback or annotations, address them in the same conversation.
4. If it returns an approval/LGTM-style message, acknowledge that review passed and continue.

Do not ask the user to copy shell commands into chat. Run the command yourself.

## Tripwires (slop-free zones)

Tripwires flag diffs that touch protected regions of the codebase. Two extra
flags drive them non-interactively (no review UI opens). Forward the user's
flags and wording verbatim:

```bash
plannotator review --tripwires        # or -t
plannotator review --add-tripwire <description of what to protect>
```

- `--tripwires` / `-t` prints a scan report for the current diff: which
  configured tripwires (slop-free zones) the changes trip, plus the global and
  repo rule tables. Use it to check changes against protected regions without
  opening the browser. Read the report and address any tripped zones.
- `--add-tripwire` takes the user's natural-language description of what to
  protect (e.g. `--add-tripwire the billing module and chargeCustomer`). It
  prints instructions for YOU: explore the repo, turn the description into
  concrete globs/symbols, write the rule into the indicated config file, then
  run `plannotator tripwires validate` and show the user the final rule. It
  does NOT write anything itself.

Related CLI (also available to the user directly): `plannotator tripwires
list|add|validate|path`.

Tripwire rules live in two layers, merged additively:

- A private, auto-created global file at
  `~/.plannotator/tripwires/<project-key>.json` (a directory of per-project
  files — never the flat `~/.plannotator/tripwires.json`). It is never committed
  and follows you across checkouts of the same repo. The base directory honors
  the `<data-dir>` override.
- An optional committed `.plannotator/tripwires.json` at the repo root (team
  opt-in), appended on top of the global rules.
