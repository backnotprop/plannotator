# Plannotator Kiro CLI Integration

Source package for Plannotator's Kiro CLI support. These files are consumed by the main installer
(`scripts/install.sh`) — there is **no separate Kiro installer**. A Kiro user installs with the same
one-liner as everyone else.

## Contents

- `skills/` — Kiro-specific skill packages (`plannotator-review`, `plannotator-annotate`),
  each baking `PLANNOTATOR_ORIGIN=kiro-cli` into its command.
  <!-- NOTE: The canonical, single-sourced core skills live in `apps/skills/core/`. These Kiro
       copies are intentionally independent (they hardcode PLANNOTATOR_ORIGIN=kiro-cli) and are
       exempt from single-sourcing — do not replace them with the core copies. -->

- `agents/plannotator.json` — an example Kiro custom agent that exposes the Plannotator skills via
  `skill://` resources and a `plannotator`-scoped `shell` tool.

## How it installs

`scripts/install.sh` auto-detects Kiro (if `~/.kiro` exists or `kiro-cli` is on PATH — the same
convention used for Codex and Gemini) and installs:

- the 2 Kiro-specific skills above → `~/.kiro/skills`
- the 2 shared skills `plannotator-setup-goal` and `plannotator-visual-explainer` (pulled from
  `apps/skills/extra/`, not duplicated here) → `~/.kiro/skills`
- the example agent `agents/plannotator.json` → `~/.kiro/agents/plannotator.json` (an existing file
  is never overwritten)

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## Use the Plannotator agent

The installed agent wires all four skills via `skill://` resources and, in its prompt, documents
which skill to use for which task (review, annotate, setup-goal, visual-explainer). Launch
it:

```bash
kiro-cli chat --agent plannotator
```

Or add the same `skill://~/.kiro/skills/plannotator-*/SKILL.md` resources to one of your own agents.

## Schema note

`agents/plannotator.json` is a conservative example. If Kiro changes its custom-agent schema, adapt
the installed copy at `~/.kiro/agents/plannotator.json`.
