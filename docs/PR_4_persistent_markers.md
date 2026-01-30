# PR: Persistent Validation Markers

## Summary

Save validation annotations (`@OK`, `@APPROVED`, `@LOCKED`) directly to source files as HTML comments, creating a persistent audit trail of reviewed sections.

## Changes

### New Files
- `packages/core/markers.ts` - Core marker injection/extraction logic (284 lines)
- `packages/core/markers.test.ts` - Comprehensive test suite

### Modified Files
- `packages/server/annotate.ts` - `/api/save-markers` endpoint
- `packages/ui/components/Toolbar.tsx` - "Save Markers" button (annotate mode only)

## Marker Format

Validation tags are saved as HTML comments immediately before the annotated section:

```markdown
<!-- @APPROVED by="alice" date="2026-01-30" -->
## Database Schema

The schema uses normalized tables...

<!-- @OK -->
### User Table

Standard user fields with UUID primary key.
```

## API

### `POST /api/save-markers`

```typescript
// Request
{
  annotations: Annotation[],  // Only @OK, @APPROVED, @LOCKED are processed
  filePath: string
}

// Response
{
  success: boolean,
  markersWritten: number,
  filePath: string
}
```

## Core Functions

```typescript
// Extract existing markers from file
extractValidationMarkers(content: string): ValidationMarker[]

// Inject new markers into content
injectValidationMarkers(content: string, markers: ValidationMarker[]): string

// Types
interface ValidationMarker {
  tag: '@OK' | '@APPROVED' | '@LOCKED';
  author?: string;
  date?: string;
  targetText: string;  // Text that follows the marker
  position: number;    // Character position in file
}
```

## Motivation

1. **Audit trail** - Know which sections were reviewed and when
2. **Incremental review** - Resume review without re-checking approved sections
3. **Team collaboration** - See who approved what
4. **Persistent state** - Markers survive file edits (if section unchanged)

## Behavior Notes

- Only validation tags are saved (modification/verification tags are transient)
- Existing markers are preserved and merged with new ones
- Duplicate markers for same section are deduplicated
- Markers are invisible in rendered markdown (HTML comments)

## Test Plan

- [ ] Add @OK annotation, click "Save Markers"
- [ ] Verify HTML comment appears in source file
- [ ] Re-open file in annotate mode, verify marker loads
- [ ] Test with multiple markers
- [ ] Test marker deduplication
- [ ] Verify non-validation tags are NOT saved
