# PR: Annotate Mode for Any Markdown File

## Summary

Extends Plannotator beyond plan review to annotate any markdown file, enabling general document review workflows.

## Changes

### New Files
- `packages/server/annotate.ts` - Dedicated server for annotate mode
- `apps/hook/commands/plannotator-annotate.md` - Slash command definition

### Modified Files
- `apps/hook/server/index.ts` - Added `annotate` subcommand routing
- `packages/ui/components/Viewer.tsx` - Shows file path in header for annotate mode
- `packages/ui/components/Toolbar.tsx` - Hides Approve button in annotate mode

## Usage

```bash
# CLI
plannotator annotate README.md
plannotator annotate docs/architecture.md

# Slash command in Claude Code
/plannotator-annotate CLAUDE.md
```

## Server API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns `{ plan, mode: "annotate", filePath }` |
| `/api/save-markers` | POST | Write validation markers to source file |
| `/api/feedback` | POST | Submit feedback (stdout) |

## UI Differences from Plan Mode

| Feature | Plan Mode | Annotate Mode |
|---------|-----------|---------------|
| Header | "Plan Review" | File path (e.g., "README.md") |
| Approve button | Visible | Hidden |
| Deny button | "Request Changes" | "Send Feedback" |
| Save Markers | N/A | Available for @OK/@APPROVED/@LOCKED |

## Motivation

1. **Documentation review** - Review READMEs, guides, specs with annotations
2. **Code review prep** - Annotate markdown files before discussing changes
3. **Iterative editing** - Send feedback on any document, not just AI plans
4. **Validation workflow** - Mark sections as reviewed with persistent markers

## Test Plan

- [ ] Run `plannotator annotate <file>` with existing file
- [ ] Verify file content loads in UI
- [ ] Verify file path shows in header
- [ ] Verify Approve button is hidden
- [ ] Add annotations and send feedback
- [ ] Verify feedback appears in stdout
