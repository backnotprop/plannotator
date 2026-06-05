---
description: Open interactive code review for current changes or a PR URL
allowed-tools: shell(plannotator:*)
---

## Code Review Feedback

!`plannotator review $ARGUMENTS`

## Your task

If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.

## Tripwires (slop-free zones)

Two extra flags drive tripwires non-interactively (no review UI opens), with their output captured above:

- `plannotator review --tripwires` (or `-t`) prints a scan report for the current diff — which configured slop-free zones the changes trip, plus the global and repo rule tables. Read it and address any tripped zones.
- `plannotator review --add-tripwire <glob>` returns an instruction and a JSON rule snippet to apply. It does NOT write the file — apply the returned snippet yourself.

Rules merge two layers: a private, auto-created global file at `~/.plannotator/tripwires/<project-key>.json` (never committed) plus an optional committed `.plannotator/tripwires.json` at the repo root.
