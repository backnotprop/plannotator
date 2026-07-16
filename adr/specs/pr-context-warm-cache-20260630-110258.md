# Spec: PR Context Warm Cache

Date: 2026-06-30

## Intent

Preload PR Overview context in the review server so the Overview panel usually receives already-fetched description, comments, review threads, checks, labels, merge state, and linked issue data.

## Scope

Update:

- `packages/server/review.ts`
- `apps/pi-extension/server/serverReview.ts`

Do not update the React client.

## Behavior

When a PR review server starts and an initial PR ref is available, the server starts fetching `fetchPRContext(prRef)` in the background.

The background fetch is cached by PR URL.

When `/api/pr-context` is requested, the handler returns the cached result. If the cached fetch is still running, the handler waits for that same promise.

If no cached fetch exists for the active PR, `/api/pr-context` starts one, stores it, waits for it, and returns it.

When the user switches PRs through `/api/pr-switch`, the server warms the PR context cache for the new PR URL after the new `prRef` is known. This warmup must not delay the switch response.

If a fetch fails, remove that PR URL from the cache before returning the error. A later request can retry.

## API Contract

`GET /api/pr-context` continues to return the existing `PRContext` JSON on success.

On failure it continues to return `{ error: string }` with status 500.

Non-PR mode continues to return `{ error: "Not in PR mode" }` with status 400.

## Implementation Notes

Add a session-local cache:

```ts
const prContextCache = new Map<string, Promise<PRContext>>();
```

Add a local helper:

```ts
const getCachedPRContext = (url: string, ref: PRRef): Promise<PRContext> => {
  const cached = prContextCache.get(url);
  if (cached) return cached;

  const promise = fetchPRContext(ref).catch((error: unknown) => {
    prContextCache.delete(url);
    throw error;
  });
  prContextCache.set(url, promise);
  return promise;
};
```

The exact type imports may differ between runtimes:

- Main server can import `PRContext` and `PRRef` from `./pr` if not already present.
- Pi server can import them from `../generated/pr-types.js`.

Startup warm:

```ts
if (prRef && prMetadata) {
  void getCachedPRContext(prMetadata.url, prRef).catch(() => {});
}
```

Switch warm:

```ts
void getCachedPRContext(pr.metadata.url, prRef).catch(() => {});
```

Endpoint:

```ts
if (!isPRMode || !prRef || !prMetadata) {
  return Response.json({ error: "Not in PR mode" }, { status: 400 });
}

const context = await getCachedPRContext(prMetadata.url, prRef);
return Response.json(context);
```

Use the Pi server's `json(res, ...)` helper in the Pi implementation.

## Verification

Run:

```bash
bun run typecheck
```

Optional focused manual check:

1. Start a PR review.
2. Open the PR Overview immediately.
3. Confirm `/api/pr-context` returns normally.
4. Switch to another PR.
5. Confirm the new PR Overview still loads and retry works if provider fetch fails.

## Risks

Session-cached context may become stale if PR comments or checks change while the review server is open. This matches the requested behavior and the existing session-cache style.

The preload still may not finish before the Overview mounts on slow provider calls. In that case the UI will still show loading, but it will wait on the already-running fetch instead of starting a second one.

The server will do one extra provider call for PR reviews where the user never opens Overview context. This is acceptable because PR Overview now opens by default and the call is read-only.
