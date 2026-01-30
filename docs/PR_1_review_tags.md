# PR: Structured Review Tags for AI Feedback

## Summary

Adds a methodology-based tagging system for annotations that helps AI agents better understand the intent and priority of feedback.

## Changes

- **New `ReviewTag` enum** in `packages/core/types.ts` with 12 tags across 3 categories
- **Tag dropdown** in `AnnotationToolbar.tsx` for selecting tags when annotating
- **Export integration** in `parser.ts` - tags appear in feedback format (e.g., `## 1. @FIX Feedback on:`)

## Tag Categories

| Category | Tags | Purpose |
|----------|------|---------|
| **Modification** | `@TODO`, `@FIX`, `@CLARIFY`, `@MISSING`, `@ADD-EXAMPLE` | Action required from AI |
| **Verification** | `@VERIFY`, `@VERIFY-SOURCES`, `@CHECK-FORMULA`, `@CHECK-LINK` | Fact-checking requests |
| **Validation** | `@OK`, `@APPROVED`, `@LOCKED` | Section sign-off |

## Motivation

When reviewing AI-generated plans, generic "comment" annotations don't communicate the type of action needed. These tags provide:

1. **Clear intent** - AI knows if it should fix, verify, or just acknowledge
2. **Priority signals** - `@FIX` vs `@TODO` vs `@CLARIFY` have different urgency
3. **Audit trail** - `@OK` and `@APPROVED` tags create section sign-off records
4. **Structured workflow** - Matches documentation review methodologies

## Example Output

```markdown
## 1. @FIX Feedback on: "Initialize database connection"

**Original:** "Connect to PostgreSQL using default credentials"
**Suggestion:** Use environment variables for credentials, never hardcode

## 2. @VERIFY Feedback on: "API rate limit is 1000 req/min"

Please verify this limit against the current API documentation.

## 3. @OK Feedback on: "Error handling strategy"

Approved as-is.
```

## Screenshots

[Tag dropdown in toolbar]
[Annotation with tag badge]

## Test Plan

- [ ] Create annotation with each tag type
- [ ] Verify tag appears in annotation panel
- [ ] Verify tag exports correctly in feedback
- [ ] Test tag persistence across page refresh (sharing)
