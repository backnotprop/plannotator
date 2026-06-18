# Spec: Source Edit Reliability Fixes

Date: 2026-06-18

## Goal

Fix the remaining source-edit reliability issues in PR #936 without expanding the feature into a larger editor rewrite.

The implementation should be small, direct, and consistent with the existing source-edit architecture:

- source files live in `useEditableDocuments`
- the active source document drives `displayedMarkdown`
- source disk changes come through the existing file-watch SSE stream
- annotation remapping uses `applyEditedDocument`

## Non-Goals

Do not implement:

- a new deleted/renamed-file recovery workflow
- a background overwrite system outside edit mode
- a new file creation flow
- a new annotation infrastructure
- a broader rewrite of `useEditableDocuments`

## Changes

### 1. Keep the source file watch stream stable

Problem:

The source file watch `EventSource` can be torn down and recreated on ordinary renders because the effect depends on `reconcileOpenSourceDocuments`, which depends on the fresh `editableDocuments` object returned each render.

Decision:

Keep the `EventSource` effect dependent only on `sourceWatchDirsKey`. Store the latest reconcile function in a ref.

Implementation shape in `packages/editor/App.tsx`:

```ts
const reconcileOpenSourceDocumentsRef = useRef(reconcileOpenSourceDocuments);

useEffect(() => {
  reconcileOpenSourceDocumentsRef.current = reconcileOpenSourceDocuments;
}, [reconcileOpenSourceDocuments]);

useEffect(() => {
  if (!sourceWatchDirsKey || typeof EventSource === 'undefined') return;

  // create EventSource and timers
  // ...
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void reconcileOpenSourceDocumentsRef.current(dir);
  }, 120));

  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    source.close();
  };
}, [sourceWatchDirsKey]);
```

Notes:

- This is a standard "stable subscription, fresh callback" pattern.
- Do not memoize the entire editable-documents API just for this.
- The stream should reconnect when the watched directory set changes, not when unrelated UI state changes.

Verification:

- Typecheck.
- Manual/targeted check: open a source-backed annotate folder file, cause normal UI renders, confirm only one active source-watch stream is created until the watched directory set changes.

### 2. Register empty single-file annotate files as editable

Problem:

An empty local file returns `plan: ""`. The client uses `else if (data.plan)`, so it skips source-edit setup.

Decision:

Use a string check instead of a truthiness check for non-folder markdown documents.

Implementation shape in `packages/editor/App.tsx`:

```ts
} else if (typeof data.plan === 'string') {
  const normalizedPlan = data.plan.replace(/\r\n?/g, '\n');
  setMarkdown(normalizedPlan);
  originalMarkdownRef.current = normalizedPlan;
  if (data.mode === 'annotate' && data.sourceSave?.enabled) {
    const key = editableDocumentKey(data.sourceSave, `file:${data.sourceSave.path}`);
    editableDocuments.openDocument({ key, text: normalizedPlan, sourceSave: data.sourceSave });
  }
}
```

Keep this after the `annotate-folder` branch so folder mode still starts blank and waits for file selection.

Verification:

- Add or update a focused test if practical around API init behavior.
- Manual check: `touch empty.md`, run `plannotator annotate empty.md`, confirm the edit control appears and saving works after typing content.

### 3. Remap annotations when reloading disk conflict content

Problem:

`handleReloadDiskConflict` swaps markdown directly. That bypasses the shared annotation remap behavior.

Decision:

Run reload through the same helper used by other document text changes.

Implementation shape in `packages/editor/App.tsx`:

```ts
const reloaded = editableDocuments.reloadDiskConflict(activeDocument.key);
if (!reloaded) return;

const remapped = applyEditedDocument(reloaded.currentText);
repaintHighlights(remapped);
editSessionBaseRef.current = reloaded.currentText;
setEditorDirty(false);
setEditorDiffersFromBaseline(false);
setEditStats(null);
scheduleDraftSave();
```

Notes:

- If the original selected text is gone, the annotation stays in the sidebar and loses its highlight.
- If edit mode is still open, `applyEditedDocument` bumps `editGeneration`, which remounts the editor with the reloaded disk text.
- Do not delete annotations just because their text cannot be highlighted.

Verification:

- Existing hook-level reload tests should still pass.
- Add an App-level test only if there is already a lightweight harness; otherwise rely on typecheck plus manual UI verification.
- Manual check: create an annotation, create a disk conflict, reload disk, confirm stale highlight disappears and the sidebar annotation remains.

### 4. Make the conflict banner honest outside edit mode

Problem:

The conflict banner can show "Overwrite disk" even when `isEditingMarkdown` is false. That action cannot run because source save requires the live editor buffer.

Decision:

Do not build a separate background overwrite flow. Only show "Overwrite disk" while editing. Keep "Reload from disk" available.

Implementation shape in `packages/editor/App.tsx`:

```tsx
{isEditingMarkdown && (
  <button type="button" onClick={handleOverwriteDiskConflict}>
    Overwrite disk
  </button>
)}
<button type="button" onClick={handleReloadDiskConflict}>
  Reload from disk
</button>
```

Optional copy adjustment:

- If editing: "`filename` changed on disk while you were editing."
- If not editing: "`filename` changed on disk."

Notes:

- This matches the product model: source-file edits are either saved, discarded, or still being edited.
- If the user is not editing, overwrite is not a coherent action.

Verification:

- Manual check conflict banner in edit mode: both buttons appear.
- Manual check conflict banner outside edit mode if reachable: only reload appears.

## Test Plan

Run:

```bash
bun run typecheck
bun test packages/editor/editableDocuments.test.ts packages/editor/editableDocumentsHook.test.tsx packages/editor/savedFileChangeValidation.test.ts
```

If source-watch test coverage is added, also run the relevant DOM test command.

Before merge, manually test:

```bash
touch /tmp/plannotator-empty.md
plannotator annotate /tmp/plannotator-empty.md
```

Then type content, save, and confirm the file writes to disk.

Also manually test a source file conflict:

1. Open a folder file in Plannotator.
2. Start editing.
3. Change the same file externally.
4. Confirm conflict banner appears.
5. Confirm reload uses disk text and does not leave wrong highlights.
6. Confirm overwrite only appears while the editor is open.
