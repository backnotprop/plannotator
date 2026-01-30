# PR: [MACRO] Flag for Cross-Document Impact

## Summary

Adds a toggle to mark annotations that have impact beyond the current document, signaling to the AI that related files should also be updated.

## Changes

- **`isMacro` field** added to `Annotation` interface in `packages/core/types.ts`
- **Toggle button** in `AnnotationToolbar.tsx` with visual indicator
- **Badge display** in annotation panel showing `[MACRO]` when enabled
- **Export integration** - feedback includes `[MACRO]` prefix when flag is set

## Motivation

In complex codebases, a change to one document often affects others:
- Changing an API endpoint requires updating all consumers
- Renaming a function affects imports across files
- Modifying a data structure impacts serialization/deserialization

The `[MACRO]` flag tells the AI: "Don't just fix this here - check for related impacts elsewhere."

## Example Output

```markdown
## 1. @FIX [MACRO] Feedback on: "UserService.authenticate()"

**Original:** "Returns user object on success"
**Replacement:** "Returns { user, token } on success"

Note: This change affects all callers of authenticate() - check AuthController, SessionMiddleware, and tests.
```

## UI Behavior

1. Select text → Toolbar appears
2. Click `[M]` toggle → Button highlights, tooltip shows "Cross-document impact"
3. Complete annotation → `[MACRO]` badge visible in annotation list
4. Export → Feedback includes `[MACRO]` flag

## Test Plan

- [ ] Toggle MACRO flag on annotation
- [ ] Verify badge appears in annotation panel
- [ ] Verify flag persists in shared URLs
- [ ] Verify `[MACRO]` appears in exported feedback
- [ ] Test combining with review tags (e.g., `@FIX [MACRO]`)
