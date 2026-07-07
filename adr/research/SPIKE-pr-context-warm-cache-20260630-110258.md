# SPIKE: PR Context Warm Cache

Date: 2026-06-30

## Question

How should Plannotator preload PR Overview context so the Overview panel does not wait on a fresh `/api/pr-context` fetch after it opens?

## Findings

The main review server keeps PR-mode session state and caches in `packages/server/review.ts`. It already has a 30 second PR list cache, a per-URL PR switch cache, and a per-URL stack tree cache near `packages/server/review.ts:219`.

The Pi review server mirrors that shape in `apps/pi-extension/server/serverReview.ts`. Its PR list cache, switch cache, and stack tree cache live near `apps/pi-extension/server/serverReview.ts:257`.

Both runtimes currently fetch stack tree data during startup and store the resolved result by PR URL. In the main server this is at `packages/server/review.ts:813`; in Pi this is at `apps/pi-extension/server/serverReview.ts:279`. The current code awaits this startup fetch. The desired PR-context behavior should still use a promise-valued cache so the UI can share an in-flight preload.

Both runtimes currently fetch PR context lazily. The main `/api/pr-context` handler calls `fetchPRContext(prRef!)` directly at `packages/server/review.ts:1349`. The Pi handler does the same at `apps/pi-extension/server/serverReview.ts:1245`.

PR switching updates the active PR metadata and `prRef`, invalidates the PR list cache, recomputes stack info, fetches or reuses stack tree data, and returns the new diff payload. The main switch path starts at `packages/server/review.ts:1233`; the Pi path starts at `apps/pi-extension/server/serverReview.ts:1138`. This is the right place to warm PR context for the newly active PR.

The client already has one PR-context fetch path. `packages/review-editor/hooks/usePRContext.ts:23` fetches `/api/pr-context`, tracks one request per PR URL, and resets when `prMetadata.url` changes. The Overview panel triggers that fetch on mount in `packages/review-editor/dock/panels/ReviewPROverviewPanel.tsx:94`. No client change is required for this server-side preload.

`fetchPRContext` is a runtime wrapper in both servers. The main wrapper is `packages/server/pr.ts:96`; the Pi wrapper is `apps/pi-extension/server/pr.ts:79`.

GitHub PR context can throw if `gh pr view` fails, at `packages/shared/pr-github.ts:338`. GitHub review threads degrade to an empty list if GraphQL fails. GitLab context starts several read-only calls in parallel at `packages/shared/pr-gitlab.ts:244` and mostly degrades partial failures into empty slices.

The root test scripts are `bun test` and `bun run typecheck`, defined in `package.json:35`.

## Constraints

The endpoint response shape must not change. The UI expects the raw `PRContext` JSON on success and `{ error }` on failure.

The preload must not block server startup or PR switch responses.

The cache key should be the PR URL, matching the existing `prSwitchCache` and `prStackTreeCache` keys.

Rejected warmup promises should be evicted so a later explicit UI request can retry instead of reusing a stale failure.

Both server implementations must be updated together.

## Proposed Direction

Add a per-session `Map<string, Promise<PRContext>>` to each server implementation.

Add a local `getPRContextForUrl(url, ref)` helper that:

1. Returns an existing promise when present.
2. Creates `fetchPRContext(ref)` when absent.
3. Stores the promise immediately.
4. Deletes the map entry if the promise rejects.
5. Returns the promise.

At startup, if `prRef` and metadata exist, call the helper without awaiting it.

In `/api/pr-context`, await the helper using the active PR URL and active `prRef`.

In `/api/pr-switch`, after the active PR URL and `prRef` are updated, call the helper for the new PR without awaiting it.

## Open Questions

Should successful context be cached for the full review session, or should there be a TTL? Existing switch and stack-tree caches are session caches, and the current request is to mirror that behavior. A session cache is the smallest change.

Should startup also make stack-tree fetch promise-based? That would align the actual code with the described pattern, but it is not necessary for this PR-context fix and would broaden the change.
