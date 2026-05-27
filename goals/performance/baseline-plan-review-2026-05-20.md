# Plan Review Profiler Baseline — 2026-05-20

Captured via React DevTools Profiler on the plan review surface.

## Summary

- **24 commits**, **325ms** total render time
- Much lighter than code review (8,815ms) — fewer components, no dockview panels

## Expensive Commits

| Commit | Duration | Notes |
|--------|----------|-------|
| 20 | 46.9ms | |
| 22 | 45.8ms | |
| 23 | 43.6ms | |
| 11 | 42.5ms | |
| 16 | 37.5ms | |
| 17 | 35.5ms | |
| 7 | 27.4ms | |
| 10 | 23.3ms | |

## Component Render Tree (hotspot)

```
App
└─ OverlayScrollArea
   └─ Viewer key="plan"
      ├─ DocBadges
      ├─ AttachmentsButton
      ├─ BlockRenderer x ~80
      ├─ TableBlock x 5
      ├─ InlineMarkdown x many
      └─ CodeFileLink x many
```

## Top Components by Inclusive Time

| Component | Inclusive ms | Renders |
|-----------|-------------|---------|
| Viewer / Anonymous key=plan | 226.3 | 6 |
| BlockRenderer (aggregate) | 184.2 | 778 |
| App | 131.9 | 3 |
| TableBlock (aggregate) | 103.1 | 45 |
| InlineMarkdown (aggregate) | 103.1 | 888 |
| AppSidebar | 37.0 | 2 |
| CodeFileLink (aggregate) | 24.7 | 164 |

## Top Components by Self-Time

| Component | Self ms |
|-----------|---------|
| Viewer / Anonymous key=plan | 39.2 |
| App | 18.5 |
| TableBlock block-15 | 15.4 |
| TableBlock block-7 | 12.5 |
| AppSidebar | 8.6 |
| AppSettingsDialog | 8.2 |

## Root Cause

The entire document viewer re-renders repeatedly — every markdown block, table, inline markdown cell, and code-file link. Re-renders cascade from parent state changes in App / Viewer, not from individual component state.

## Likely Causes

1. **App.tsx passes unstable props/callbacks to Viewer** — inline arrow functions (`onPlanDiffToggle={() => ...}`), inline objects (`linkedDocInfo={{ ... }}`), arrays that create new references on every render
2. **Viewer re-render cascades to all BlockRenderers** — 778 renders of BlockRenderer, 888 renders of InlineMarkdown, no memo boundaries
3. **Tables are a local hotspot** — TableBlock block-15: 43.4ms, block-7: 24.2ms, block-47: 14.1ms
4. **CodeFileLink renders are noisy** — 164 renders total

## Update Sources

- Viewer / Anonymous key=plan
- App
- TableToolbar
- AnnotationToolbar
- CodeFileLink
- AppSidebar / LayoutContent / Layout

## Key Files

- `packages/plannotator-plan-review/App.tsx`
- `packages/ui/components/Viewer.tsx`
- `packages/ui/components/TableBlock.tsx`
- `packages/ui/components/InlineMarkdown.tsx`
- `packages/ui/components/CodeFileLink.tsx`

## Recommended Fixes

- `React.memo` on BlockRenderer, TableBlock, InlineMarkdown, CodeFileLink
- Stabilize Viewer props in App.tsx with useMemo / useCallback
- Avoid inline object/function props to Viewer
- Split volatile annotation/selection state from static markdown rendering
