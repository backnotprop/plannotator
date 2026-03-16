# Collaborative Review Sessions - Implementation Guide

## Overview

This PR adds collaborative review sessions to Plannotator, allowing multiple team members to review and annotate a plan using a single shared URL.

**Problem Solved:** Previously, to get feedback from N reviewers, you needed N separate share URLs (each reviewer creates their own annotated version and sends it back). Now, create one session URL and all reviewers add annotations to the same session.

## What Was Implemented

### Backend (Phase 1)

**Files Modified:**
- `packages/ui/types.ts` - Added `ReviewSession`, `CreateReviewSessionRequest`, `AddAnnotationsRequest` types
- `apps/paste-service/core/storage.ts` - Extended `PasteStore` interface with session methods
- `apps/paste-service/stores/fs.ts` - Implemented session storage for filesystem
- `apps/paste-service/stores/kv.ts` - Implemented session storage for Cloudflare KV
- `apps/paste-service/core/handler.ts` - Added 3 new API endpoints

**New API Endpoints:**
- `POST /api/review-session` - Create new session
- `GET /api/review-session/:id` - Fetch session state
- `PATCH /api/review-session/:id/annotations` - Add annotations (with optimistic locking)

**Storage:**
- Local: `~/.plannotator/pastes/session-<id>.json`
- Cloudflare KV: `session:<id>` key
- TTL: 7 days (same as paste service)

### Frontend (Phase 2-3)

**Files Created:**
- `packages/ui/hooks/useCollaborativeSession.ts` - React hook for session management
- `packages/ui/components/CollaborativeSessionButton.tsx` - UI component

**Files Modified:**
- `packages/editor/App.tsx` - Integrated collaborative session button in toolbar

**UI Features:**
- "Start Collaborative Review" button (creates session)
- Session status display (reviewer count, last update time)
- "Refresh" button (fetch new annotations from other reviewers)
- "Submit" button (upload local annotations to session)
- Auto-join when opening `/s/<id>` URL

### Documentation (Phase 4)

**Files Modified:**
- `CLAUDE.md` - Added Collaborative Review Flow section and updated Paste Service API docs

## How to Test Locally

### 1. Start the Paste Service

```bash
cd apps/paste-service
bun run dev
```

Expected output:
```
Plannotator paste service running on http://localhost:19433
Storage: /Users/yourname/.plannotator/pastes
TTL: 7 days
```

### 2. Test the API with cURL

**Create a session:**
```bash
curl -X POST http://localhost:19433/api/review-session \
  -H "Content-Type: application/json" \
  -d '{"plan":"# Test Plan\n\nThis is a test collaborative review."}'
```

Expected response:
```json
{
  "session": {
    "id": "abc12345",
    "plan": "# Test Plan\n\nThis is a test collaborative review.",
    "annotations": [],
    "globalAttachments": [],
    "diffContexts": [],
    "createdAt": 1234567890000,
    "lastUpdatedAt": 1234567890000,
    "expiresAt": 1235172690000,
    "reviewerCount": 0,
    "version": 1
  },
  "shareUrl": "http://localhost:19433/s/abc12345"
}
```

**Fetch the session:**
```bash
curl http://localhost:19433/api/review-session/abc12345
```

**Add annotations:**
```bash
curl -X PATCH http://localhost:19433/api/review-session/abc12345/annotations \
  -H "Content-Type: application/json" \
  -d '{
    "annotations": [
      {
        "id": "ann-001",
        "blockId": "block-1",
        "startOffset": 0,
        "endOffset": 10,
        "type": "COMMENT",
        "text": "Great plan!",
        "originalText": "Test Plan",
        "createdA": 1234567890000,
        "author": "Alice"
      }
    ],
    "expectedVersion": 1
  }'
```

Expected: Version increments to 2, `reviewerCount` becomes 1.

**Test version conflict:**
```bash
# Try to add with wrong version
curl -X PATCH http://localhost:19433/api/review-session/abc12345/annotations \
  -H "Content-Type: application/json" \
  -d '{
    "annotations": [],
    "expectedVersion": 1
  }'
```

Expected: `409 Conflict` error (version is now 2, not 1).

### 3. Test the UI (with Plan Editor)

**Option A: Use the hook server**
```bash
bun run dev:hook
```
Then open `http://localhost:5173` (or the port shown)

**Option B: Use the built app**
```bash
bun run build:hook
# Open dist/index.html in a browser
```

**Testing workflow:**
1. Click "Start Collaborative Review" button
2. Copy the generated share URL
3. Open the URL in 2-3 different browser tabs (simulate multiple reviewers)
4. In each tab:
   - Add different annotations
   - Click "Submit"
5. Go back to the first tab and click "Refresh"
6. Verify all annotations from all tabs appear

### 4. Verify Storage

**Filesystem mode:**
```bash
ls -la ~/.plannotator/pastes/
cat ~/.plannotator/pastes/session-abc12345.json
```

You should see the session file with all merged annotations.

## Testing with Cloudflare Workers (Optional)

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV Namespace

```bash
cd apps/paste-service
wrangler kv:namespace create "REVIEW_SESSIONS"
```

Note the namespace ID from the output.

### 3. Update wrangler.toml

Add to `apps/paste-service/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "PASTES"
id = "your-existing-kv-id"

[[kv_namespaces]]
binding = "REVIEW_SESSIONS"
id = "your-new-kv-id"  # From step 2
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Test the Deployed Worker

Use the same cURL commands but replace `localhost:19433` with your worker URL:
```bash
curl -X POST https://plannotator-paste-yourname.workers.dev/api/review-session \
  -H "Content-Type: application/json" \
  -d '{"plan":"# Test"}'
```

## Integration Test Scenarios

### Scenario 1: Basic Collaboration

1. User A creates a session
2. User B joins and adds 3 comments
3. User C joins and adds 2 deletions
4. User A refreshes → sees 5 total annotations
5. User A approves plan → all feedback sent to Claude

**Expected:** No errors, all annotations present, no duplicates.

### Scenario 2: Concurrent Edits (Version Conflict)

1. User A and User B both fetch session (version 1)
2. User A submits annotations → version becomes 2
3. User B tries to submit with `expectedVersion: 1`
4. User B gets 409 error
5. User B clicks Refresh → gets version 2
6. User B resubmits with `expectedVersion: 2` → success

**Expected:** Version conflict handled gracefully, no data loss.

### Scenario 3: Session Expiry

1. Create a session with modified TTL (1 minute for testing)
2. Wait 1 minute
3. Try to fetch or update the session

**Expected:** 404 Not Found errors.

### Scenario 4: Deduplication

1. User A adds comment "Looks good"
2. User B adds identical comment "Looks good" on same text
3. Server merges both

**Expected:** Only 1 annotation appears (deduplicated by `originalText + type + text`).

## Edge Cases to Test

- [ ] Empty session (no annotations)
- [ ] Large session (500+ annotations)
- [ ] Invalid session ID (404)
- [ ] Expired session (404)
- [ ] Version mismatch (409)
- [ ] Rapid concurrent submits (race condition)
- [ ] Session with global image attachments
- [ ] Session with diff context annotations

## Performance Benchmarks

**Target metrics:**
- Session creation: < 100ms
- Annotation fetch: < 50ms
- Annotation merge (100 annotations): < 200ms
- Storage size: ~10KB per session with 50 annotations

## Known Limitations

1. **No real-time sync** - Users must manually click "Refresh" to see others' annotations
2. **Cloudflare KV race conditions** - KV doesn't support atomic compare-and-swap; rare cases of concurrent writes may cause version conflicts
3. **No session ownership** - Anyone with the URL can add annotations (no authentication)
4. **No edit/delete** - Annotations can only be added, not modified or removed
5. **Fixed 7-day TTL** - Sessions expire automatically (same as paste service)

## Future Enhancements (Out of Scope)

- WebSocket/SSE for real-time updates
- Session owner controls (lock, extend TTL, delete)
- Annotation editing/deletion
- Reviewer presence indicators
- Activity timeline/history
- Email notifications for new annotations

## Rollback Plan

If issues are found in production:

1. **Disable feature flag** (if added):
   ```typescript
   sharingEnabled && COLLABORATIVE_SESSIONS_ENABLED && (
     <CollaborativeSessionButton ... />
   )
   ```

2. **Revert commits:**
   ```bash
   git revert <commit-hash>
   ```

3. **Database cleanup** (if needed):
   ```bash
   # Remove all session files
   rm ~/.plannotator/pastes/session-*.json

   # Or for Cloudflare KV
   wrangler kv:key delete --namespace-id=<id> "session:<id>"
   ```

## PR Checklist

- [x] Backend types defined (`ReviewSession`, etc.)
- [x] Storage implementations (filesystem, KV)
- [x] API endpoints (create, fetch, update)
- [x] React hook (`useCollaborativeSession`)
- [x] UI component (`CollaborativeSessionButton`)
- [x] Integration in plan editor
- [x] CLAUDE.md documentation
- [ ] Unit tests (optional, not implemented yet)
- [ ] E2E tests (optional, not implemented yet)
- [ ] User-facing documentation (marketing site)
- [ ] Migration guide (none needed - additive change)

## Questions for Code Review

1. **Storage strategy:** Should we separate session storage from paste storage (different directory/namespace)?
2. **TTL:** 7 days sufficient, or should sessions have longer TTL?
3. **Deduplication:** Current logic uses `originalText + type + text`. Is this robust enough?
4. **Version conflicts:** Auto-refresh on 409? Or show error message?
5. **UI placement:** Is the toolbar the right place for the button?
6. **Code review support:** Should we also add collaborative sessions for code review (different data model)?

## Contact

For questions or issues during testing:
- GitHub Issues: https://github.com/backnotprop/plannotator/issues
- Original author: @backnotprop
- This PR: @swpark
