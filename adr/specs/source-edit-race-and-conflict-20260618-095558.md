# Spec: Source Edit Race and Conflict Recovery

Date: 2026-06-18

## Goal

Make source-file disk awareness reliable enough to merge PR #936.

Specifically:

- do not let stale async `/api/doc` responses overwrite newer source-file state
- do not lose saved edit context after a save because an older reconcile finishes late
- do not enter a recoverable conflict state unless Plannotator has the disk text needed to recover

## Non-Goals

Do not implement:

- deleted/renamed-file recovery UX
- orphaned draft rescue for files that no longer exist
- allowing feedback submission with unverified saved edit context
- a larger editor rewrite
- a background overwrite path outside edit mode

## Decisions

### 1. Guard watcher reconciliation with request order and start hash

Problem:

`reconcileOpenSourceDocuments` can start a `/api/doc` fetch, then apply it after newer state has already landed.

Decision:

Each source-file snapshot request must carry two pieces of local client state:

- a per-file request sequence number
- the document's known disk hash when the request started

When the request returns, apply it only if:

- it is still the latest request for that file
- the document still exists in `editableDocuments`
- the document is not currently saving
- the document's current known disk hash still equals the start hash

Known disk hash means:

1. `diskConflict.sourceSave.hash` if a conflict is already known
2. otherwise `sourceSave.hash` if source-save is enabled
3. otherwise `lastKnownHash`

Implementation shape in `packages/editor/App.tsx`:

```ts
const sourceReconcileSeqRef = useRef<Map<string, number>>(new Map());

function getKnownDiskHash(record: EditableDocumentRecord | null): string | undefined {
  return record?.diskConflict?.sourceSave.hash
    ?? (record?.sourceSave?.enabled ? record.sourceSave.hash : record?.lastKnownHash);
}

// inside reconcileOpenSourceDocuments loop
const startRecord = editableDocuments.getDocument(doc.key);
const expectedHash = getKnownDiskHash(startRecord);
const seq = (sourceReconcileSeqRef.current.get(doc.key) ?? 0) + 1;
sourceReconcileSeqRef.current.set(doc.key, seq);

const snapshot = await fetchSourceDocumentSnapshot(doc);
if (!snapshot) continue;
if (sourceReconcileSeqRef.current.get(doc.key) !== seq) continue;

const currentRecord = editableDocuments.getDocument(doc.key);
if (!currentRecord?.sourceSave?.enabled) continue;
if (currentRecord.saveStatus === 'saving') continue;
if (getKnownDiskHash(currentRecord) !== expectedHash) continue;

const result = editableDocuments.reconcileDiskSnapshot(...);
```

Notes:

- The sequence guard handles overlapping external-change fetches.
- The start-hash guard handles a save completing while an older fetch is in flight.
- Both are needed.
- The existing "skip while saving" guard stays.

### 2. Return conflict snapshots from `/api/source/save`

Problem:

The save endpoint detects conflicts by reading the current file snapshot, but the response only returns hash metadata. The client then performs a second `/api/doc` read to get the current text. If that read fails, the client cannot show a real conflict choice.

Decision:

Extend the conflict variant of `SourceSaveResponse` to include the current disk snapshot.

Implementation shape in `packages/shared/source-save.ts`:

```ts
| {
    ok: false;
    code: "conflict";
    message: string;
    currentText: string;
    currentHash: string;
    currentMtimeMs: number;
    currentSize: number;
    currentEol: SourceFileEol;
  }
```

Keep the other failure variants separate. They do not need snapshot fields.

Implementation shape in `packages/shared/source-save-node.ts`:

```ts
if (before.hash !== baseHash) {
  return {
    ok: false,
    code: "conflict",
    message: "The file changed on disk since Plannotator opened it.",
    currentText: before.text,
    currentHash: before.hash,
    currentMtimeMs: before.mtimeMs,
    currentSize: before.size,
    currentEol: before.eol,
  };
}
```

This automatically applies to both Bun and Pi because both servers call the shared `saveSourceFileAtomic`.

### 3. Apply save-conflict snapshots directly

Problem:

`handleSaveEditedSourceFile` currently handles save conflicts by calling `reconcileOpenSourceDocuments`, which creates the second `/api/doc` request.

Decision:

On a `409 conflict` save response, build an enabled `sourceSave` snapshot from the active document's source-save metadata plus the conflict payload, then call `editableDocuments.reconcileDiskSnapshot` directly.

Implementation shape in `packages/editor/App.tsx`:

```ts
if (!data.ok && data.code === 'conflict') {
  if (typeof data.currentText === 'string') {
    const conflictSourceSave = {
      ...activeSourceSave,
      hash: data.currentHash,
      mtimeMs: data.currentMtimeMs,
      size: data.currentSize,
      eol: data.currentEol,
    };

    const result = editableDocuments.reconcileDiskSnapshot({
      key: activeDocument.key,
      text: data.currentText,
      sourceSave: conflictSourceSave,
    });

    // update edit stats/toast like the current conflict path
  } else {
    editableDocuments.markError(activeDocument.key, message);
    toast.error('File changed on disk', {
      description: 'Plannotator could not load the latest disk version. Try saving again.',
    });
  }
  return true;
}
```

Notes:

- Do not call `reconcileOpenSourceDocuments` from the save-conflict branch anymore.
- Do not call `markConflict` unless there is a `diskConflict` snapshot.
- A recoverable conflict means we have both the user's text and the disk text.

### 4. Keep non-blocker findings out of this patch

Do not change:

- restored dirty drafts for missing/deleted source files
- fail-closed submit behavior when saved edit context is unverified

Optional:

- The Bun/Pi source-save eligibility predicate can be extracted later. It is not required for this patch.

## Tests

Add/update focused tests:

### Shared source save

In `packages/shared/source-save-node.test.ts`:

- conflict response includes `currentText`
- conflict response includes `currentHash`, `currentMtimeMs`, `currentSize`, `currentEol`
- file contents are still not clobbered

### Editable document reconciliation

In `packages/editor/editableDocuments.test.ts` or a small helper test:

- known disk hash prefers `diskConflict.sourceSave.hash`
- stale expected-hash snapshots are skipped, not applied

If the stale-snapshot guard stays entirely local to `App.tsx`, do not invent a large App harness just for this. Prefer extracting the tiny "known hash" helper only if it makes the guard testable without pulling in the whole app.

### Existing tests

Run:

```bash
bun test packages/shared/source-save-node.test.ts packages/editor/editableDocuments.test.ts packages/editor/editableDocumentsHook.test.tsx packages/editor/savedFileChangeValidation.test.ts
DOM_TESTS=1 bun test --preload ./packages/ui/test-setup/happy-dom.ts packages/editor/editableDocumentsHook.test.tsx
bun run typecheck
bun test
```

## Manual Verification

Save conflict:

1. Open a source-backed folder file.
2. Start editing it in Plannotator.
3. Change the same file externally.
4. Click Save.
5. Confirm conflict banner appears without relying on a second file fetch.
6. Confirm Reload uses disk text.
7. Confirm Overwrite while editing saves the Plannotator text and records the saved Edits card.

Stale watcher:

1. Open a source-backed file.
2. Trigger a disk reconcile and save around the same time.
3. Confirm the saved text and saved Edits card are not reverted by an older watcher response.

The second manual case is timing-sensitive; the automated guards are the primary protection.
