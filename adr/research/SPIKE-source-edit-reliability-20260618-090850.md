# Spike: Source Edit Reliability Follow-up

Date: 2026-06-18

## Question

Validate the remaining review findings for PR #936 before implementation:

- source file watcher reconnecting too often
- empty annotate files not being editable
- reload-from-disk leaving stale annotation anchors
- conflict banner showing an overwrite action when overwrite cannot run

## Scope

This spike only reads the current branch code. It does not change product code.

Files inspected:

- `packages/editor/App.tsx`
- `packages/editor/editableDocuments.ts`
- `packages/editor/editableDocuments.test.ts`
- `packages/editor/editableDocumentsHook.test.tsx`
- `packages/ui/components/MarkdownEditor.tsx`
- `packages/ui/hooks/useLinkedDoc.ts`
- `packages/server/annotate.ts`
- `apps/pi-extension/server/serverAnnotate.ts`

## Findings

### 1. Source file watch stream reconnects too often

The source document watcher in `App.tsx` opens an `EventSource` for the directories that contain open editable source files.

The watch effect depends on `reconcileOpenSourceDocuments`.

`reconcileOpenSourceDocuments` depends on `editableDocuments`.

`useEditableDocuments()` returns a fresh object literal each render. Its methods are mostly stable callbacks, but the object wrapper is not stable.

That means ordinary React renders can recreate `reconcileOpenSourceDocuments`, which reruns the watch effect. The cleanup closes the current `EventSource` and clears any pending 120ms reconcile timer.

Impact:

- repeated `/api/reference/files/stream` reconnects while source docs are open
- pending disk-change reconcile work can be canceled by unrelated renders
- disk change awareness becomes less reliable than intended

Best small fix:

- keep the actual stream keyed only by `sourceWatchDirsKey`
- store the latest `reconcileOpenSourceDocuments` callback in a ref
- when an SSE message arrives, call `reconcileOpenSourceDocumentsRef.current(dir)`

This keeps the connection stable while still calling fresh logic.

Rejected larger fix:

- Memoizing the whole `useEditableDocuments()` return object is broader and does not fully solve this. The object includes state like `version`, `activeDocument`, and `fileEditStatuses`, so it still changes for real editable-document updates. The stream should not depend on that.

### 2. Empty single-file annotate targets do not become editable

The Bun and Pi annotate servers both return `plan: snapshot.text` for a local single-file annotate target. If the file is empty, the server correctly returns `plan: ""` plus an enabled `sourceSave`.

The client init path in `App.tsx` only initializes normal document state inside:

```ts
} else if (data.plan) {
```

An empty string fails that check. The client therefore does not:

- set `markdown` to the empty source text
- set `originalMarkdownRef`
- call `editableDocuments.openDocument(...)`

The edit gate already supports empty source-backed files:

```ts
activeEditableDocument?.sourceSave?.enabled || displayedMarkdown !== '' || editStats !== null
```

So the server and edit gate are ready; the init condition is the bug.

Impact:

- `plannotator annotate empty.md` opens a valid editable source file but the client never registers it as editable
- a future "new empty file" flow would hit the same issue

Best small fix:

- replace truthiness with `typeof data.plan === 'string'`
- keep the existing `annotate-folder` branch separate, because folder mode intentionally starts with no selected file

### 3. Reload from disk bypasses annotation remapping

Normal document edits use `applyEditedDocument(next)` and `repaintHighlights(remapped)`.

That path reparses markdown and remaps annotations by their original selected text. If the text no longer exists, the annotation remains in the sidebar but loses its block anchor and does not highlight random text.

`handleReloadDiskConflict` currently does this instead:

```ts
setMarkdown(reloaded.currentText);
setEditGeneration((g) => g + 1);
```

That swaps the text but skips the shared annotation remap/repaint path.

Impact:

- after a conflict reload, annotation metadata can still point at old blocks
- exported feedback can carry stale line/block context
- highlights can be wrong or fail inconsistently

Best small fix:

- after `editableDocuments.reloadDiskConflict(...)`, call `applyEditedDocument(reloaded.currentText)`
- then call `repaintHighlights(remapped)`
- keep the existing dirty/stat reset and draft save behavior

Important editor detail:

`MarkdownEditor` reads `markdown` only at mount. Its `documentId` includes `editGeneration`, so `applyEditedDocument` bumping `editGeneration` is enough to remount the editor with the reloaded disk text if edit mode is still open.

### 4. Conflict banner can show overwrite when overwrite cannot run

`handleOverwriteDiskConflict` calls `handleSaveEditedSourceFile({ overwriteDiskConflict: true })`.

`handleSaveEditedSourceFile` immediately returns `false` if `isEditingMarkdown` is false.

The normal intended source-file flow does not leave unsaved dirty edits after pressing Done. For source files, the edit-exit control is save, discard, or keep editing. So the reviewer's "Done but unsaved" path is not the intended product path.

However, the code can still produce a conflict record while not editing through narrower paths, such as:

- discarding local edits after a conflict while the conflict object remains
- restoring or reconciling odd draft/conflict state

In that state, showing "Overwrite disk" is misleading because overwrite depends on the live editor buffer.

Impact:

- not a major data-loss path
- still a UI honesty issue

Best small fix:

- only show "Overwrite disk" while `isEditingMarkdown` is true
- keep "Reload from disk" available
- do not build a separate background overwrite path right now

This matches the product rule: overwrite means "keep the version I am actively editing."

## Non-Findings

### Blocking send when saved edits cannot be verified

This is conservative but intentional. If Plannotator cannot verify saved edit context, it blocks sending instead of sending stale or false context to the agent.

No change recommended in this pass.

### Reopening a restored folder draft file

This was raised by review but is outside this requested fix set. It is confusing but not data loss: the draft document records are restored and visible through the file tree state, but the first restored file is not automatically opened.

No change recommended unless a tiny solution falls out naturally later.
