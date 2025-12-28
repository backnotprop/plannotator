<p align="center">
  <img src="plannotator_banner.webp" alt="Plannotator" width="100%" />
</p>

# Plannotator

Interactive Plan Review: Mark up and refine your plans using a UI, easily share for team collaboration, automatically integrates with Claude Code plan mode.

## Install

**macOS / Linux / WSL:**
```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://plannotator.ai/install.ps1 | iex
```

Then in Claude Code:
```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

See [apps/hook/README.md](apps/hook/README.md) for detailed installation instructions.

## Monorepo Structure

```
apps/
  hook/       # Claude Code plugin + binary server
  portal/     # Editor at share.plannotator.ai
  marketing/  # Landing page at plannotator.ai
packages/
  editor/     # Main App.tsx + styles
  ui/         # Shared components, utils, types
scripts/
  install.sh  # macOS/Linux install script
  install.ps1 # Windows PowerShell install script
  install.cmd # Windows CMD install script
```

## Development

```bash
bun install

# Run any app
bun run dev:hook       # Hook server
bun run dev:portal     # Portal editor
bun run dev:marketing  # Marketing site
```

## Build

```bash
bun run build:hook       # Single-file HTML for hook server
bun run build:portal     # Static build for share.plannotator.ai
bun run build:marketing  # Static build for plannotator.ai
```

---

## License

**Copyright (c) 2025 backnotprop.**

This project is licensed under the **Business Source License 1.1 (BSL)**.
