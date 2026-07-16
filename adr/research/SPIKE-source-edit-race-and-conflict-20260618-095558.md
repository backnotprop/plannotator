# Spike: Source Edit Race and Conflict Recovery

Date: 2026-06-18

## Question

Review the latest PR #936 findings and decide what should actually be fixed before merge.

Main concerns:

- async file-watch reconciliation can apply stale disk snapshots
- save conflicts can enter a conflict state without enough data to recover
- restored drafts for missing files may be invisible
- unverified saved edits block feedback submission
- Bun/Pi duplicate a source-save eligibility predicate

## Scope

Code inspected:

- `packages/editor/App.tsx`
- `packages/editor/editableDocuments.ts`
- `packages/editor/editableDocuments.test.ts`
- `packages/editor/editableDocumentsHook.test.tsx`
- `packages/shared/source-save.ts`
- `packages/shared/source-save-node.ts`
- `packages/shared/source-save-node.test.ts`
- `packages/server/annotate.ts`
- `apps/pi-extension/server/serverAnnotate.ts`
- `packages/server/reference-handlers.ts`
- `apps/pi-extension/server/reference.ts`

No product code was changed during this spike.

## Findings

### 1. Out-of-order disk snapshots can overwrite newer state

This finding is valid and important.

Current flow:

1. An SSE file-watch event calls `reconcileOpenSourceDocuments`.
2. For each open source document, it fetches `/api/doc`.
3. When the fetch returns, it applies the returned text and `sourceSave` snapshot to `editableDocuments.reconcileDiskSnapshot`.

The current guards only skip while a document is actively marked `saving`.

That is not enough. A fetch can start before a save, then finish after the save has already completed. At that point the document is no longer `saving`; it is `saved`. The stale fetch can then be applied as if it were the latest disk truth.

Bad result:

- the active document can revert to older disk text
- the saved Edits card can be cleared
- feedback can lose the saved edit context
- the next save can hit a fake conflict because the client has been moved back to an old base hash

The same class of bug exists for two fast external writes: if requests finish out of order, the older snapshot can win.

Why one guard is not enough:

- A sequence number alone prevents older requests from winning over newer reconcile requests, but it does not stop a single old request from applying after the user saves.
- A start-hash check alone prevents applying after the document has advanced, but it can drop the newer of two overlapping external snapshots if an older one applies first.

Best fix:

- use both a per-file latest-request sequence and a per-request expected known disk hash
- only apply a snapshot if it is still the newest request for that file and the document's known disk hash is still the hash that was current when the request started

This is small and directly addresses the race.

### 2. Save conflict recovery depends on a second `/api/doc` request

This finding is valid.

Current flow:

1. Save sends `/api/source/save`.
2. Server calls `saveSourceFileAtomic`.
3. If the current disk hash does not match `baseHash`, server returns `409 conflict` with current hash metadata.
4. Client then calls `reconcileOpenSourceDocuments(..., { includeSavingKey })`.
5. That calls `/api/doc` to fetch the current disk text so the UI can populate `diskConflict`.

If the follow-up `/api/doc` request fails, the client currently calls `markConflict`, which sets `saveStatus: "conflict"` but does not populate `diskConflict`.

That is a bad state:

- the banner depends on `diskConflict`, so actions do not appear
- the save button sees conflict state
- retry keeps using the stale base hash

Best fix:

Do not rely on a second request. The server already has the current file snapshot inside `saveSourceFileAtomic` when it detects the conflict. Return that conflict snapshot in the `409` response.

Then the client can build the conflict state directly from the save response:

- current text
- current hash
- current mtime
- current size
- current EOL

If the response somehow lacks that snapshot, mark the document as an error, not as a recoverable disk conflict. A recoverable conflict requires disk text.

This is cleaner than trying to make the follow-up fetch more reliable.

### 3. Restored drafts can be invisible when the source file is missing

This finding is valid but out of scope for this pass.

The draft restore path can rehydrate `editableDocuments` records even when the source file no longer opens normally. If there is no active editable document, those restored edits may not be shown immediately.

This overlaps with deleted/unreadable-file recovery, which we explicitly decided not to build right now.

Why not fix now:

- it is not the same as stale snapshot corruption
- it needs product decisions: should Plannotator show orphaned source edits, allow saving as recreate, or only let the user copy/discard?
- adding a quick auto-open behavior could create confusing states around deleted files

Recommendation:

Leave it for a separate deleted/unreadable-source UX pass.

### 4. Unverified saved edits block feedback submission

This finding is valid but intentional.

If a saved file edit exists and `/api/doc` cannot verify whether it is still current, the submit path blocks and asks the user to retry.

This is annoying during a transient failure, but it is safer than sending stale or false edit context to the agent.

Recommendation:

Keep the fail-closed behavior for now.

### 5. Bun/Pi duplicate a source-save eligibility predicate

This finding is valid but a nit.

The predicate for whether a single-file annotate session can expose source-save behavior appears in both Bun and Pi server code.

It is currently consistent. Extracting it to `packages/shared/source-save.ts` would reduce drift risk, but it is not related to the race or save-conflict corruption.

Recommendation:

Optional cleanup, not a blocker for this fix pass.

## Recommendation

Fix before merge:

1. Add monotonic guards to source-document reconciliation.
2. Return conflict snapshots from `/api/source/save` and apply them directly.
3. If a save conflict response cannot provide current disk text, mark error instead of conflict.

Do not fix in this pass:

- deleted/unreadable restored draft rescue
- unverified-submit fail-closed behavior
- Bun/Pi predicate cleanup, unless it falls out with almost no cost
