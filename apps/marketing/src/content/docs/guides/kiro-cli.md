---
title: "Kiro CLI"
description: "Plannotator skills and a custom-agent example for Kiro CLI."
sidebar:
  order: 16
section: "Guides"
---

Plannotator supports Kiro CLI through installable skills plus an example custom agent. Skills are
invoked on demand — there are no background hooks, matching how Plannotator integrates with Droid
and Copilot CLI.

## Setup

Kiro is auto-detected. If `~/.kiro` exists (or `kiro-cli` is on your PATH) when you run the
installer, the Kiro skills install automatically — the same convention used for Codex and Gemini.
No extra flags or steps. Auto-detection works on every platform; use the installer for your OS:

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

**Windows CMD:**

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

This installs the Kiro skills to `~/.kiro/skills` and the Plannotator agent to
`~/.kiro/agents/plannotator.json`. If you install Kiro *after* Plannotator, just re-run the installer.
See [Use the Plannotator agent](#use-the-plannotator-agent) below.

## Installed Kiro skills

Kiro-specific skills (run with `PLANNOTATOR_ORIGIN=kiro-cli`):

- `plannotator-review`
- `plannotator-annotate`

Shared extra skills (installed from Plannotator's canonical `apps/skills/extra/` set, not duplicated):

- `plannotator-setup-goal`
- `plannotator-visual-explainer`

The shared skills show the default agent badge rather than "Kiro CLI" — origin is cosmetic for
Kiro and has no functional effect.

## Use the Plannotator agent

The installer writes the agent to `~/.kiro/agents/plannotator.json`. It wires every Plannotator skill
through the `resources` field (`skill://` URIs), grants the `shell` tool scoped to `plannotator`
commands, and its prompt spells out which skill to use for which task:

| Skill | Use it to |
|-------|-----------|
| `plannotator-review` | Review the current code changes or a pull request |
| `plannotator-annotate` | Annotate a markdown/HTML file, folder, or URL |
| `plannotator-setup-goal` | Turn an idea into a structured goal package |
| `plannotator-visual-explainer` | Generate a polished visual HTML explainer |

Launch it:

```bash
kiro-cli chat --agent plannotator
```

Prefer your own agent? Add the same `skill://~/.kiro/skills/plannotator-*/SKILL.md` resources to any
custom agent's `resources` list.

## Assumptions

The custom-agent JSON is intentionally conservative because Kiro's schema can evolve. If your Kiro
version expects different field names for resources or tool permissions, edit
`~/.kiro/agents/plannotator.json` for your runtime.
