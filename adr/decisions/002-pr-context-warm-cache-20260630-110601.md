# 002. Warm PR Context Cache

Date: 2026-06-30

## Status

Accepted

## Context

The PR Overview panel shows PR description, comments, review threads, checks, labels, merge state, and linked issues. Today the review UI opens the Overview and then asks the server for `/api/pr-context`. The server waits until that request arrives before calling `fetchPRContext(prRef)`, so the panel often flashes "Loading PR..." while the provider command runs.

The main Bun review server and the Pi review server already keep PR-mode session caches for related data such as PR lists, PR switch payloads, and stack trees. The client already has a single PR context fetch path keyed by PR URL, so this can be fixed on the server without changing the UI.

The fetch must not block server startup or PR switch responses. Provider failures also must not poison the cache, because the UI retry path should still be able to start a fresh request after a transient failure.

## Decision

Add a session-local PR context promise cache to both review server implementations:

- `packages/server/review.ts`
- `apps/pi-extension/server/serverReview.ts`

The cache will be keyed by PR URL and will store `Promise<PRContext>`.

At PR review startup, when an initial PR ref and URL are available, the server will start `fetchPRContext(prRef)` in the background and store the promise without awaiting it.

When `/api/pr-context` is requested, the handler will await the cached promise for the active PR URL. If the fetch is still in flight, the handler waits for that same promise. If no cached promise exists, the handler creates one, stores it, awaits it, and returns the result.

When `/api/pr-switch` changes the active PR, the server will warm the cache for the new PR URL after the new `prRef` is known. This warmup will not delay the switch response.

If a PR context fetch rejects, the cache entry for that PR URL will be removed before the error is returned. A later request can retry.

The `/api/pr-context` response contract will not change.

## Consequences

The PR Overview usually has its context data ready by the time the UI asks for it, so the "Loading PR..." flash should mostly disappear.

If the provider fetch is still running when the UI asks, the UI waits on already-started work instead of causing a duplicate provider call.

Successful PR context is cached for the lifetime of the review server session. It may become stale if comments or checks change while the server remains open; this is accepted for now and matches the requested session-cache behavior.

Failed fetches remain retryable because rejected promises are evicted from the cache.

Both review server implementations must stay in sync for this behavior.
