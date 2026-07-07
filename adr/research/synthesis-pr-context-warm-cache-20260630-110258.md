# Synthesis: PR Context Warm Cache

Date: 2026-06-30

## Summary

The simplest correct change is server-only. The client already asks for PR context through one hook, and it already resets by PR URL. The missing piece is that the server waits until that request arrives before starting the slow provider call.

The change should add a small promise cache in both review servers. The cache should be keyed by PR URL and store the in-flight or completed `fetchPRContext` promise. Startup and PR switch should warm the cache without awaiting it. The `/api/pr-context` handler should await the cached promise, creating it only if no preload exists.

## Decision Pressure

Preloading must reduce the Overview loading flash without delaying server readiness. That means the startup call must be detached but owned. A promise stored in a map is enough ownership here because the endpoint can await the same work and the rejection path can evict the failed promise.

Failure handling matters. GitHub can fail the whole context fetch when `gh pr view` fails. If that failed promise remains cached, the retry button in the UI would keep getting the same failure. Evicting on rejection preserves current retry behavior.

The cache should not move into shared code yet. The two server implementations are similar, but their surrounding state is local and runtime-specific. A tiny helper in each file keeps the change narrow and avoids a new abstraction with no broader reuse.

## Recommended Shape

Use this local pattern in both files:

```ts
const prContextCache = new Map<string, Promise<PRContext>>();

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

Use the server-local PR ref type that is already available from the wrapper imports. If importing `PRRef` would add friction in Pi, use the generated type import from `../generated/pr-types.js`.

Call it without awaiting at startup:

```ts
void getCachedPRContext(prMetadata.url, prRef).catch(() => {});
```

Call it without awaiting after PR switch updates `prRef`:

```ts
void getCachedPRContext(pr.metadata.url, prRef).catch(() => {});
```

Call it with await in `/api/pr-context`:

```ts
const context = await getCachedPRContext(prMetadata.url, prRef);
```

## What Not To Change

Do not change the client hook or Overview panel.

Do not change the `/api/pr-context` response shape.

Do not add persistence across server sessions.

Do not introduce TTL unless the user decides freshness is more important than session consistency.

Do not refactor the stack-tree cache in the same change.
