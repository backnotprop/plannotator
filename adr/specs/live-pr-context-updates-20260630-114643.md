# Spec: Live PR Context Updates

Date: 2026-06-30

## Intent

Keep PR Overview context fresh automatically while a PR review is open, without manual refresh, duplicate provider reads, or unnecessary background work after the UI closes.

## Scope

Update both server implementations:

- `packages/server/review.ts`
- `apps/pi-extension/server/serverReview.ts`

Update the review client hook:

- `packages/review-editor/hooks/usePRContext.ts`

Add shared types/helpers where useful, but do not broaden this into a general review event system unless the local implementation becomes duplicated or hard to reason about.

## Behavior

When a PR review server starts, it warms PR context for the initial PR without blocking startup.

When the user switches PRs, it warms PR context for the new PR without blocking the switch response.

When a PR-mode browser tab is open, the client subscribes to live PR context updates. This should happen at the app level for PR mode, not only after the Overview panel mounts.

The server refreshes watched PR context every 30 seconds.

The server runs at most one refresh at a time per PR URL.

The server refreshes once per PR URL, not once per browser tab.

When no tabs are watching a PR URL, the server stops the recurring refresh timer for that URL.

When `/api/pr-action` successfully posts a review/comment, the server refreshes the target PR context immediately and broadcasts the updated context.

The UI updates automatically when new context arrives.

If the stream fails before a snapshot arrives, the client falls back to automatic polling. The user should not need to press refresh.

## API Contract

Keep `GET /api/pr-context` compatible:

- success: raw `PRContext`
- failure: `{ error: string }`
- non-PR mode: `{ error: "Not in PR mode" }`

Add a stream endpoint:

```text
GET /api/pr-context/stream
```

The stream emits JSON events. Suggested event shapes:

```ts
type PRContextStreamEvent =
  | { type: "snapshot"; url: string; version: number; context: PRContext | null; loading: boolean; error: string | null; stale: boolean }
  | { type: "updated"; url: string; version: number; context: PRContext; stale: false }
  | { type: "loading"; url: string; version: number }
  | { type: "error"; url: string; version: number; error: string; stale: boolean; retryAt?: number };
```

The exact TypeScript type can live in shared code if both client and server need it.

## Server Design

Replace the current promise-only PR context cache with a live cache entry:

```ts
type PRContextCacheEntry = {
  url: string;
  ref: PRRef;
  context: PRContext | null;
  error: string | null;
  version: number;
  inflight: Promise<PRContext> | null;
  watchers: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextAllowedRefreshAt: number;
};
```

Use `ensurePRContextEntry(url, ref)` to create or update entries.

Use `refreshPRContext(url, ref, reason)` to:

1. Return the existing in-flight promise if one exists.
2. Respect `nextAllowedRefreshAt`.
3. Set `inflight`.
4. Broadcast `loading`.
5. Call `fetchPRContext(ref)`.
6. Store `context`, clear `error`, increment `version`, broadcast `updated`.
7. On failure, store `error`, increment `version`, set cooldown if rate-limited, broadcast `error`.
8. Clear `inflight`.

Provider adapters must not turn a failed primary context read into a successful empty context. GitHub already throws when `gh pr view` fails. GitLab currently tolerates partial failures, but the primary MR details call must be treated as required for live refresh; otherwise a rate limit or auth failure could be broadcast as blank PR data.

Use `startWatchingPRContext(url, ref)` when an SSE connection opens:

1. Increment watchers.
2. Send a snapshot.
3. Start the recurring timer if needed.
4. Trigger an immediate refresh if there is no context and no in-flight refresh.

Use `stopWatchingPRContext(url)` when the SSE connection closes:

1. Decrement watchers.
2. Stop the timer when watchers reaches zero.

Use a 30 second interval for normal watched refreshes.

Use a short conservative cooldown, such as 60 seconds, when the provider appears rate-limited but no reset time is available.

If provider output exposes a retry time, use that instead of the default cooldown.

## Client Design

Change `usePRContext` so it opens `EventSource("/api/pr-context/stream")` when `prMetadata` is present.

The hook should keep returning:

```ts
{
  prContext,
  isLoading,
  error,
  fetchContext
}
```

`fetchContext` should remain for compatibility and explicit retry buttons, but normal operation should not depend on it.

When the PR URL changes, reset local state and reconnect.

If SSE fails before the first snapshot, start automatic polling against `/api/pr-context`. Polling should be server-cache-backed and should not cause duplicate provider fetches.

If SSE reconnects later, prefer streamed state.

## Rate Limit Behavior

Do not proactively poll rate-limit endpoints. That would spend more provider budget.

Use normal refresh cadence until provider commands fail.

If GitHub or GitLab returns a rate-limit error:

- keep the last successful context visible when possible.
- show a small stale/error state.
- stop refreshing until the retry time or cooldown passes.
- retry automatically.

Writes should stay user-triggered. The live refresh loop must not repost or retry write operations by itself.

## Bidirectional Commenting Path

This spec does not implement full bidirectional commenting.

It prepares for it by making the server the owner of fresh remote context and by refreshing immediately after writes.

Future write work should add provider-specific endpoints for:

- general PR/MR comments.
- inline thread replies.
- resolve/unresolve discussion threads where supported.
- edit/delete comments where supported.

Future client state should track pending local comments with local IDs, then reconcile them to provider IDs after the server refreshes context.

## Verification

Run:

```bash
bun run typecheck
bun test packages/server/review-workspace.test.ts apps/pi-extension/server.test.ts
```

Add focused tests where practical:

- multiple `/api/pr-context` requests share one in-flight refresh.
- multiple stream watchers on the same PR do not create duplicate provider refreshes.
- disconnecting all stream watchers stops the recurring timer.
- successful `/api/pr-action` triggers an immediate context refresh.
- provider refresh failure keeps retry possible and broadcasts an error.

Manual checks:

1. Open a PR review and confirm Overview context appears without manual action.
2. Leave the PR open and add a remote comment from GitHub/GitLab; confirm it appears automatically.
3. Post a Plannotator PR review; confirm the posted content appears automatically.
4. Open the same review in two tabs; confirm provider refreshes are not duplicated.
5. Switch PRs; confirm the new PR receives live context updates.
