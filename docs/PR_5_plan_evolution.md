# PR: Plan Evolution Tracking with Visual Diff

## Summary

Track plan versions over time and compare them with a git-diff style split view, enabling users to see how AI plans evolve across review iterations.

## Changes

### New Files
- `packages/core/planDiff.ts` - LCS-based block diffing algorithm (320 lines)
- `packages/server/planHistory.ts` - Version storage and retrieval (219 lines)
- `packages/ui/components/PlanEvolutionPanel.tsx` - Split-view diff UI (428 lines)

### Modified Files
- `packages/server/index.ts` - Auto-save versions on plan load
- `packages/ui/components/Toolbar.tsx` - "Evolution" button to open panel
- `packages/core/types.ts` - `Block`, `BlockDiff`, `DiffType` types

## Features

### Version Storage
- Plans auto-save on each review session
- Stored in `~/.plannotator/history/{slug}/v{n}.md`
- Content-hash deduplication (same content = same version)

### Diff Algorithm
- Block-level comparison using Longest Common Subsequence (LCS)
- Levenshtein distance for fuzzy matching modified blocks
- Handles: headings, paragraphs, code blocks, lists, tables

### Split View UI
- Side-by-side comparison (old ← → new)
- Color coding:
  - 🟢 Green: Added blocks
  - 🔴 Red: Removed blocks
  - 🟡 Yellow: Modified blocks
  - ⚪ Grey: Unchanged blocks
- Version selector dropdowns
- Summary badges (X added, Y removed, Z modified)

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan/versions` | GET | List all versions for current plan |
| `/api/plan/diff` | GET | Compute diff between two versions |
| `/api/plan/version` | GET | Get specific version content |

### Example Response

```typescript
// GET /api/plan/versions?slug=my-plan
{
  versions: [
    { version: 1, timestamp: "2026-01-28T10:00:00Z", hash: "abc123", slug: "my-plan" },
    { version: 2, timestamp: "2026-01-29T14:30:00Z", hash: "def456", slug: "my-plan" },
    { version: 3, timestamp: "2026-01-30T09:15:00Z", hash: "ghi789", slug: "my-plan" }
  ]
}

// GET /api/plan/diff?v1=1&v2=3&slug=my-plan
{
  diff: [
    { type: "unchanged", oldBlock: {...}, newBlock: {...} },
    { type: "modified", oldBlock: {...}, newBlock: {...} },
    { type: "added", newBlock: {...} },
    { type: "removed", oldBlock: {...} }
  ],
  summary: { unchanged: 5, added: 2, removed: 1, modified: 3 }
}
```

## Motivation

1. **Track AI iteration** - See how Claude refines plans based on feedback
2. **Review history** - Understand what changed between review sessions
3. **Regression detection** - Catch if AI accidentally reverts improvements
4. **Learning** - Study how effective feedback shapes AI output

## Screenshots

[Split view showing version comparison]
[Version selector with timestamps]
[Summary badges]

## Test Plan

- [ ] Review plan → verify version saved
- [ ] Review same plan again → verify new version created
- [ ] Open Evolution panel → verify versions listed
- [ ] Select two versions → verify diff displays
- [ ] Verify color coding matches diff types
- [ ] Test with identical versions → shows "no changes"
- [ ] Test with single version → shows appropriate message
