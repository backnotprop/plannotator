---
description: Open interactive code review for current changes or a PR URL; pass --git to force Git in JJ workspaces, --tripwires to print a non-interactive slop-free-zone scan instead of opening the UI, or --add-tripwire <description> to get instructions for adding a rule
---

Pass `--tripwires` (or `-t`) to skip the review UI and instead get a tripwires scan report for the current diff (which slop-free zones the changes touch). Tripwires are configured in a private, auto-created global file at `~/.plannotator/tripwires/<project-key>.json` plus an optional committed `.plannotator/tripwires.json` in the repo; the two are merged. Pass `--add-tripwire <description of what to protect>` to get agent instructions for turning that description into a concrete rule and writing it (the command itself never writes files).
