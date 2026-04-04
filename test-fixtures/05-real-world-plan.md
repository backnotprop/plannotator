# Implementation Plan

## Overview

This plan adds support for markdown hard line breaks and list continuation
lines in the Plannotator renderer.

## Changes

### 1. Parser Updates

- **Merge continuation lines** into the preceding list item when the line is
  indented and no blank line separates them. This handles the common case
  where Claude wraps long list content across multiple lines.
- **Add `lastLineWasBlank` tracking** to prevent merging after blank lines,
  which should start a new paragraph per CommonMark spec
- **Preserve existing behavior** for all other block types — headings,
  code fences, tables, blockquotes, and horizontal rules are unaffected

### 2. InlineMarkdown Updates

- Add hard line break pattern matching for:
  - Two trailing spaces followed by newline (`  \n`) — standard markdown
  - Backslash followed by newline (`\\\n`) — alternative syntax
- Update fallback character scanner to stop at `\n` and `\\` so the hard
  break pattern gets a chance to match
- Soft wraps (plain `\n` without trailing spaces) continue to collapse
  to spaces via normal HTML whitespace handling

### 3. Sync to Diff View

- The `PlanCleanDiffView` has its own `InlineMarkdown` implementation that
  needs the same hard break pattern added for consistency

### 4. Test Coverage

- Add 6 parser tests covering:
  - Simple continuation merge
  - Multiple continuation lines
  - Non-indented lines (should NOT merge)
  - Blank line separation (should NOT merge)
  - Nested list items not swallowed by continuation logic
  - Block-level elements after list items not swallowed

## Files Modified

| File | Change |
|------|--------|
| `packages/ui/utils/parser.ts` | Continuation merge logic |
| `packages/ui/components/Viewer.tsx` | Hard break in InlineMarkdown |
| `packages/ui/components/plan-diff/PlanCleanDiffView.tsx` | Hard break sync |
| `packages/ui/utils/parser.test.ts` | New test suite |

## Risk Assessment

Both changes are additive and narrowly scoped. The annotation system uses
text-based matching (`findTextInDOM`) as its primary restoration mechanism,
making it resilient to block structure changes.

> Note: This plan itself is a good test case — it contains list items with
> continuation lines, inline code, tables, blockquotes, and mixed content.
