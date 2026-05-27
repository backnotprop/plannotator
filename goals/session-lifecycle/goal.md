# Session Lifecycle: Smart Opening, Persistence, and Legacy Mode

Make the daemon the decision-maker for how sessions are presented to users. Instead of the CLI always opening a new browser tab, the daemon checks whether a frontend is connected and visible, and chooses between opening a browser or sending an in-app notification. Session content persists to disk so completed sessions survive refresh and restart. A legacy config toggle preserves tab-per-session + auto-close for users who prefer it.

## Shared Understanding

See `facts.md` for the complete fact sheet (approved).

## Execution Plan

See `plan.md` for the implementation plan. Also available in the approved Plannotator plan at `~/.claude/plans/adaptive-questing-bee.md`.

## Done Condition

All verification items in the plan pass:
- Smart opening works across all four states (no frontend, visible idle, visible active, backgrounded)
- Completed sessions stay in sidebar with status badges
- Completed sessions survive page refresh and daemon restart via disk snapshots
- Legacy tab mode opens new tabs and fires auto-close overlay
- All five session modes follow the same flow
- Typecheck and tests pass
