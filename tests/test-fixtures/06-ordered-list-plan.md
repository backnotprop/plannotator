# Plan: Slice 6 — API completion + release cleanup

## Context

Slices 1–5 landed deterministic cold start, all seven warm-start cases with
git awareness, the live watcher pipeline with single-writer discipline,
graceful shutdown, periodic reconciliation, SIGTERM/SIGINT integration, and
the same-cwd advisory lockfile with `ConcurrentAccessError` as the one
public error class. **226 tests passing, 10 `it.todo` placeholders
remaining.** Those 10 todos are the only gaps left between the library and
the spec:

- `tree.search()` — 3 todos in `test/unit/query-search.test.ts`; the
  implementation in `src/query/list.ts:52` still throws
  `NOT_IMPLEMENTED`.
- `tree.hash()` — 3 todos in `test/unit/query-hash.test.ts`; the
  implementation in `src/query/hash.ts:5` still throws
  `NOT_IMPLEMENTED`. `src/filetree.ts:hash()` also throws.
- `reconciliation diff` — 4 unit todos in
  `test/unit/reconcile-diff.test.ts` covering add/update/delete
  classification and the "no auto-hash" invariant.

Plus two coverage items carried over from earlier slices:

- An explicit empty-directory watcher integration test (deferred from
  slice 4 as backend-dependent; slice 6 adds it with per-platform
  skips).
- A cold subscribe-failure regression via `vi.mock` of
  `src/watcher/parcel.js` (deferred from slice 4; slice 5's
  `reconcile-warm-subscribe-failed.test.ts` established the pattern).

And one release-gating task: flip the Bun CI lane from **advisory** to
**gating** now that slice-4 live watcher + slice-5 hardening have proven
cross-runtime parity.

After slice 6 lands, `it.todo` should hit zero, every spec section has
live code behind it, and the Bun lane is required for merge.

## Locked design decisions (user sign-off)

### 1. `tree.hash()` — freshness-aware, invalidate on update, drop on delete

The contract is: **`tree.hash(path)` returns the SHA-256 of the
file's current on-disk contents, for a path the library's index
currently believes is a regular file.** The result is cached in
`files.hash`, invalidated whenever reconcile/watcher updates the
row, and dropped whenever the row is deleted.

### 2. `tree.search()` — AND-filter semantics, basename-substring-ci name, glob-on-cwd-rel-path

**Query shape**: `{ name?: string; glob?: string }` (already fixed in
`src/types.ts:86`).

## Verification

1. `npm run typecheck` clean.
2. `npm run lint` clean.
3. `npm test` — **expected ~251 active passing**, **0 todo**, **0 failing**.
4. `npm run build` produces `dist/` with updated artifacts.
5. `npm run test:pack` still green.
6. `npm run test:bun` green on macOS with the **`continue-on-error` removed**.
7. **Manual sanity — hash lifecycle**: write a file, hash it, verify cache hit on second call, mutate the file, wait for the watcher, re-hash and confirm the digest changes.
8. **Manual sanity — search semantics**: `name`-only, `glob`-only, both (AND), and empty query → `[]`.
9. **Manual sanity — cold subscribe failure**: confirm the cache dir is gone and the lockfile is released after the reject.
10. **Manual sanity — Bun gating**: push a trivial PR with a deliberate Bun-only failure and confirm CI now fails the Bun lane instead of skipping it. Revert before merge.
