import { useMemo, useRef, useState } from 'react';
import type React from 'react';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import { useStableCallback } from '@pierre/diffs/react';
import type { CodeViewHandle, CreateEditor } from '@pierre/diffs/react';
import type { CodeAnnotation, DiffAnnotationMetadata } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { isContentConsistentWithPatch } from '../utils/patchConsistency';
import { deriveSuggestionHunks, type SuggestionHunk } from './deriveSuggestions';
import { cloneFileDiff } from './cloneDiff';
import { mapEditedRangeToPristine, selectionToLineRange } from './selectionAnchor';
import { buildSelectionActionElement } from './selectionActionPopover';
import {
  createPierreEditor,
  loadPierreEdit,
  type PierreEditorInstance,
  type PierreEditorOptions,
  type PierreSelectionActionContext,
} from './pierreEditAdapter';

/**
 * Controller for the flag-gated "edit code to author a suggestion" session
 * (one file at a time, plain all-files view only).
 *
 * Lifecycle contract with Pierre's CodeView (v1.3.1):
 * - `item.edit = true` + version bump + updateItem starts a session (needs an
 *   EditProvider factory above the CodeView; startEdit awaits the lazy editor
 *   chunk BEFORE flipping edit on, because the React wrapper throws if the
 *   factory returns undefined).
 * - The editor MUTATES `item.fileDiff` in place per keystroke. We deep-clone
 *   the pristine metadata before starting and republish it when the session
 *   ends, so the diff view always returns to the exact pre-edit state.
 * - `onItemEditComplete` fires once per session WITH changes (never for a
 *   zero-change session, never on unmount teardown). Suggestion derivation
 *   happens there; the pristine restore is scheduled by whichever path ended
 *   the session so it also covers the zero-change case.
 * - `persistState` is deliberately unused (upstream bug, open PR #1048).
 *   Session state lives only while the editor is mounted.
 */
interface ActiveEditSession {
  itemId: string;
  filePath: string;
  /** Deep clone of the pre-session FileDiffMetadata (the restore target). */
  pristine: FileDiffMetadata;
  /** Full new-side content the editor started from (suggestion diff base). */
  preEditContent: string;
  /** The fileSetKey generation the session belongs to. */
  generation: string;
  dirty: boolean;
  /** The FileContents delivered with the most recent change event. Its
   * `contents` getter closes over the session's TextDocument (which stays
   * readable after Pierre's editor cleanup), so a dirty session torn down by
   * a CodeView remount can still recover its final text from here. */
  latestContents: { contents: string } | null;
  /** Set by Cancel: the completion callback must not create suggestions. */
  suppressSuggestions: boolean;
  /** Set by our explicit complete/cancel paths (restore already scheduled). */
  ending: boolean;
  /** Monotonic per-session counter for fresh restore cacheKeys. */
  seq: number;
  /** The attached editor instance (marker refresh target), set by onAttach. */
  editor: PierreEditorInstance | null;
}

/**
 * A "Make annotation" request emitted from the edit-session Selection Action
 * popover. Everything is snapshotted at click time: `lineStart`/`lineEnd` are
 * PRISTINE (pre-edit, new-side) line numbers — the coordinates the rendered
 * diff and the feedback export anchor to — mapped from the edited-buffer
 * selection via `mapEditedRangeToPristine` (see selectionAnchor.ts for the
 * anchoring rules). Pristine coordinates are session-invariant, so the anchor
 * stays correct whether the session later completes or is discarded.
 */
export interface EditSelectionAnnotationRequest {
  filePath: string;
  /** 1-based pristine new-side line range the annotation anchors to. */
  lineStart: number;
  lineEnd: number;
  /** False when the selection overlapped in-session edits (anchor maps to the
   * pristine lines those edits replace — approximate, and labeled as such). */
  exact: boolean;
  /** The exact text highlighted in the editor when the request was made. */
  selectedText: string;
  /** Viewport rect of the popover action, for anchoring the comment entry. */
  anchorRect: DOMRect;
}

/** The submitted comment for an EditSelectionAnnotationRequest: the request's
 * snapshotted anchor plus the reviewer's comment text. */
export interface EditSelectionComment {
  lineStart: number;
  lineEnd: number;
  exact: boolean;
  selectedText: string;
  text: string;
}

interface UseEditSessionParams {
  enabled: boolean;
  viewerRef: React.RefObject<CodeViewHandle<DiffAnnotationMetadata> | null>;
  itemIdToFileRef: React.RefObject<Map<string, DiffFile>>;
  fileSetKeyRef: React.RefObject<string>;
  reviewBaseRef: React.RefObject<string | undefined>;
  reviewSnapshotIdRef: React.RefObject<string | undefined>;
  annotationsRef: React.RefObject<CodeAnnotation[]>;
  onAddSuggestions?: (filePath: string, hunks: SuggestionHunk[]) => void;
  /** Sink for "Make annotation" requests from the editor's Selection Action
   * popover. When absent the popover renders no action (defensive; the wired
   * flow always provides it). */
  onSelectionAnnotation?: (request: EditSelectionAnnotationRequest) => void;
  /** Republish one item's slots (version bump + updateItem). */
  refreshItem: (itemId: string) => void;
}

/**
 * External store for the active session's net change count (suggestion hunks
 * the session would produce right now). The HUD lives inside Pierre's
 * memoized header slot portal, which only republishes on updateItem — never
 * on parent state changes — so the count is delivered as a subscribable the
 * HUD reads via useSyncExternalStore, letting it re-render itself while the
 * user types without touching the item.
 */
export interface EditSessionDirtyStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

export interface EditSessionApi {
  /** Item id currently in an edit session, or null. */
  editingItemId: string | null;
  /**
   * Mirror ref for stable callbacks and slot-portal renders. Pierre's header
   * slots republish synchronously inside updateItem — BEFORE React commits
   * the state update — so anything rendered into a slot must read this ref,
   * never the state value.
   */
  editingItemIdRef: React.RefObject<string | null>;
  /** filePath -> human-readable reason the edit button is disabled. Ref for
   * the same slot-portal ordering reason as editingItemIdRef. */
  editUnavailableRef: React.RefObject<Map<string, string>>;
  /** Enter edit mode on an item (ends any current session first, prompting if dirty). */
  startEdit: (itemId: string) => void;
  /** Finish the session; changes become suggestion annotations. */
  completeEdit: () => void;
  /** Discard the session; no annotations, pristine diff restored. */
  cancelEdit: () => void;
  /** If this item is being edited, finish the session first (collapse paths). */
  finishIfEditing: (itemId: string) => void;
  /** Net change count of the active session for the HUD (debounced). */
  dirtyStore: EditSessionDirtyStore;
  /** Called by the fileSetKey reset effect (post-commit, so prompting is
   * safe): the old items are gone. A dirty session prompts to keep its edits
   * as suggestions; a clean one is dropped silently. */
  handleFileSetChange: () => void;
  /** Re-project the file's current annotations into editor markers so a
   * comment created mid-session becomes visible inside the editor. No-op
   * outside a session; markers are best-effort chrome (never throws). */
  refreshMarkers: () => void;
  /** Collapse the editor selection to its end. Called after the app-side
   * comment entry submits: the editor keeps its selection while the entry is
   * open (useful context), but once the annotation exists the still-ranged
   * selection would re-open the Selection Action popover over it. */
  collapseSelection: () => void;
  /** CodeView prop: fires per document change while a session is active. */
  onItemEditChange: (
    item: CodeViewItem<DiffAnnotationMetadata>,
    file?: { contents: string },
  ) => void;
  /** CodeView prop: fires once when a session with changes ends. */
  onItemEditComplete: (
    item: CodeViewItem<DiffAnnotationMetadata>,
    file: { contents: string },
  ) => void;
  /** EditProvider factory. Returns undefined until the lazy editor chunk has
   * loaded — a defensive guard the wired flow never hits (startEdit awaits
   * the chunk before any item enters edit mode; the React wrapper would
   * throw on an undefined return). Upstream's React `CreateEditor` type does
   * not model the undefined return, hence the cast where this is produced. */
  createEditor: CreateEditor<DiffAnnotationMetadata>;
  /** Editor construction options (markers wired via onAttach). Structural
   * subset of Pierre's EditorOptions so the generic variance stays out of
   * app code. */
  editorOptions: EditSessionEditorOptions;
}

export interface EditSessionEditorOptions {
  enabledSelectionAction: boolean;
  renderSelectionAction: (context: PierreSelectionActionContext) => HTMLElement;
  onAttach: (editor: unknown) => void;
}

/**
 * Derive the suggestions a torn-down dirty session would have produced from
 * its last observed document contents. Pierre delivers a FileContents whose
 * `contents` getter closes over the session's TextDocument on every change
 * event; the document stays readable after editor cleanup, so the read is
 * deliberately lazy — one string build at recovery time instead of one per
 * keystroke. Returns [] when nothing was captured, the document can no
 * longer be read, or the edits net out to no change.
 */
export function recoverDirtySessionHunks(session: {
  preEditContent: string;
  latestContents: { contents: string } | null;
}): SuggestionHunk[] {
  const latest = session.latestContents;
  if (!latest) return [];
  let edited: string;
  try {
    edited = String(latest.contents);
  } catch {
    return [];
  }
  return deriveSuggestionHunks(session.preEditContent, edited);
}

export function useEditSession(params: UseEditSessionParams): EditSessionApi {
  const {
    enabled,
    viewerRef,
    itemIdToFileRef,
    fileSetKeyRef,
    reviewBaseRef,
    reviewSnapshotIdRef,
    annotationsRef,
    onAddSuggestions,
    onSelectionAnnotation,
    refreshItem,
  } = params;

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const editingItemIdRef = useRef<string | null>(null);
  const editUnavailableRef = useRef<Map<string, string>>(new Map());
  const sessionRef = useRef<ActiveEditSession | null>(null);
  const onAddSuggestionsRef = useRef(onAddSuggestions);
  onAddSuggestionsRef.current = onAddSuggestions;
  const onSelectionAnnotationRef = useRef(onSelectionAnnotation);
  onSelectionAnnotationRef.current = onSelectionAnnotation;

  // --- Dirty-count store (see EditSessionDirtyStore) ------------------------
  const changeCountRef = useRef(0);
  const changeListenersRef = useRef(new Set<() => void>());
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishChangeCount = (count: number) => {
    if (changeCountRef.current === count) return;
    changeCountRef.current = count;
    for (const listener of changeListenersRef.current) listener();
  };

  const resetChangeCount = () => {
    if (changeTimerRef.current != null) {
      clearTimeout(changeTimerRef.current);
      changeTimerRef.current = null;
    }
    publishChangeCount(0);
  };

  const dirtyStore = useMemo<EditSessionDirtyStore>(
    () => ({
      subscribe: (listener) => {
        changeListenersRef.current.add(listener);
        return () => changeListenersRef.current.delete(listener);
      },
      getSnapshot: () => changeCountRef.current,
    }),
    [],
  );

  const setEditing = (itemId: string | null) => {
    // Ref first: header slots republish synchronously on the very next
    // updateItem, before React commits the state update.
    editingItemIdRef.current = itemId;
    setEditingItemId(itemId);
  };

  const markUnavailable = (filePath: string, reason: string) => {
    editUnavailableRef.current.set(filePath, reason);
  };

  /** The pristine write applied to an item when its session ends: restored
   * fileDiff with a FRESH cacheKey (contents changed back; a reused key would
   * serve the edited session's highlight cache for the pristine lines). */
  const writeRestore = useStableCallback((session: ActiveEditSession) => {
    // Only touch the item if the diff generation it belongs to is still on
    // screen — after a diff switch the remounted items are already pristine.
    if (fileSetKeyRef.current !== session.generation) return;
    const handle = viewerRef.current;
    const item = handle?.getItem(session.itemId);
    if (handle == null || item == null || item.type !== 'diff') return;
    const restored = session.pristine;
    session.seq += 1;
    restored.cacheKey = `${session.generation}::${session.itemId}#edit-restore${session.seq}`;
    item.fileDiff = restored;
    item.edit = false;
    item.version = (item.version ?? 0) + 1;
    handle.updateItem(item);
    // Pinned to @pierre/diffs 1.3.2: the updateItem above is NOT enough to
    // repaint the pristine content. DiffHunksRenderer.renderDiff only swaps
    // its render cache for new content while the cache is UNhighlighted; an
    // ended edit session leaves `renderCache.highlighted === true`, so the
    // teardown repaint keeps painting the stale edited `renderCache.result`
    // and merely queues an async worker highlight of the pristine diff. That
    // heal takes 30ms-seconds and never lands at all if the task is
    // invalidated (e.g. workerPool's theme sync calling invalidateRenderTasks)
    // — permanently stale pixels after Discard. Clearing the render cache on
    // the live instance forces the next paint down the cold-render path:
    // pristine plaintext immediately, then the normal async highlight — the
    // same UX as any diff switch. This deliberately reaches past the edit
    // adapter wall into the (protected) hunksRenderer, which upstream does
    // not expose for this; remove once upstream's renderDiff honors
    // newContent for highlighted caches.
    try {
      const rendered = handle
        .getInstance()
        ?.getRenderedItems()
        .find((r) => r.id === session.itemId);
      if (rendered != null && rendered.type === 'diff') {
        const instance = rendered.instance as unknown as {
          hunksRenderer?: { clearRenderCache(): void };
          rerender(): void;
        };
        instance.hunksRenderer?.clearRenderCache();
        instance.rerender();
      }
    } catch {
      // Best-effort: a virtualized-away (not currently rendered) item is
      // fine — it repaints pristine from item.fileDiff on remount.
    }
  });

  /** End the current session. `suppress` skips suggestion creation (Cancel).
   *
   * Upstream's documented commit pattern is ONE combined item write: edit off
   * AND the final fileDiff (fresh cacheKey) in the same updateItem. A
   * two-step write (edit off first, restore later) races CodeView's own
   * session-teardown re-render — on large files the teardown render lands
   * after the deferred restore and leaves the edited content on screen. The
   * combined write alone is still not sufficient to REPAINT pristine,
   * though: the renderer's highlighted cache ignores the new content on the
   * teardown repaint, so writeRestore also clears the live instance's render
   * cache (see the pinned note there). The completion callback still fires
   * from this write with the session's final contents, which is all the
   * suggestion derivation needs. */
  const endSession = useStableCallback((suppress: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    session.suppressSuggestions = suppress;
    session.ending = true;
    // The write republishes the header slot synchronously, so the editing ref
    // must already read idle; sessionRef must still point at this session
    // because onItemEditComplete fires from inside the write.
    editingItemIdRef.current = null;
    writeRestore(session);
    sessionRef.current = null;
    setEditingItemId(null);
    resetChangeCount();
  });

  const completeEdit = useStableCallback(() => endSession(false));
  const cancelEdit = useStableCallback(() => endSession(true));

  const finishIfEditing = useStableCallback((itemId: string) => {
    if (sessionRef.current?.itemId === itemId) endSession(false);
  });

  const handleFileSetChange = useStableCallback(() => {
    // The CodeView holding the session remounted (diff switch / refresh, or a
    // sort-order / collapse-default change — fileSetKey covers all of them).
    // The old items are unreachable and Pierre tore the editor down without a
    // completion callback, so the session cannot continue. A clean session is
    // dropped silently; a DIRTY session must never be silently discarded —
    // recover its last-known contents and prompt (the same pattern as the
    // dirty file-switch path in startEdit; this runs from a post-commit
    // effect, so a synchronous confirm is safe here).
    const session = sessionRef.current;
    if (session) {
      sessionRef.current = null;
      setEditing(null);
      resetChangeCount();
      if (session.dirty && !session.ending && !session.suppressSuggestions) {
        const hunks = recoverDirtySessionHunks(session);
        if (hunks.length > 0) {
          const keep = window.confirm(
            `The file view changed and ended your edit session on ${session.filePath}. Keep your changes there as suggestions?`,
          );
          if (keep) onAddSuggestionsRef.current?.(session.filePath, hunks);
        }
      }
    }
    // A fresh diff may make previously-unavailable files editable again.
    editUnavailableRef.current.clear();
  });

  /** Ensure the item carries a full-content (non-partial) FileDiffMetadata.
   * Pierre's applyDocumentChange THROWS on partial diffs, so this is a hard
   * precondition for starting a session. */
  const ensureFullContent = useStableCallback(
    async (itemId: string, file: DiffFile): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const handle = viewerRef.current;
      const item = handle?.getItem(itemId);
      if (handle == null || item == null || item.type !== 'diff') {
        return { ok: false, reason: 'File is not available' };
      }
      if (item.fileDiff.isPartial !== true) return { ok: true };

      const generation = fileSetKeyRef.current;
      const params = new URLSearchParams({ path: file.path });
      if (file.oldPath) params.set('oldPath', file.oldPath);
      const base = reviewBaseRef.current;
      if (base) params.set('base', base);
      const snapshot = reviewSnapshotIdRef.current;
      if (snapshot) params.set('snapshot', snapshot);

      let data: { oldContent: string | null; newContent: string | null } | null = null;
      try {
        const res = await fetch(`/api/file-content?${params}`);
        data = res.ok ? await res.json() : null;
      } catch {
        data = null;
      }
      if (fileSetKeyRef.current !== generation) return { ok: false, reason: 'Diff changed' };
      if (!data || data.newContent == null) {
        return { ok: false, reason: 'Full file content unavailable' };
      }
      if (!isContentConsistentWithPatch(file.patch, data.oldContent, data.newContent)) {
        return { ok: false, reason: 'File changed since the diff was captured' };
      }

      let augmented: FileDiffMetadata | null = null;
      try {
        const result = processFile(file.patch, {
          oldFile:
            data.oldContent != null
              ? { name: file.oldPath || file.path, contents: data.oldContent }
              : undefined,
          newFile: { name: file.path, contents: data.newContent },
        });
        if (result && !result.isPartial) augmented = result;
      } catch {
        augmented = null;
      }
      if (!augmented) return { ok: false, reason: 'Full file content unavailable' };

      const liveHandle = viewerRef.current;
      const liveItem = liveHandle?.getItem(itemId);
      if (liveHandle == null || liveItem == null || liveItem.type !== 'diff') {
        return { ok: false, reason: 'File is not available' };
      }
      augmented.cacheKey = `${generation}::${itemId}#edit-full`;
      liveItem.fileDiff = augmented;
      liveItem.version = (liveItem.version ?? 0) + 1;
      liveHandle.updateItem(liveItem);
      return { ok: true };
    },
  );

  const startEdit = useStableCallback((itemId: string) => {
    if (!enabled) return;
    const current = sessionRef.current;
    if (current?.itemId === itemId) return;
    if (current) {
      if (current.dirty) {
        const proceed = window.confirm(
          `Finish editing ${current.filePath} first? Your changes there will become suggestions.`,
        );
        if (!proceed) return;
        endSession(false);
      } else {
        endSession(true);
      }
    }

    const file = itemIdToFileRef.current.get(itemId);
    if (!file) return;
    if (file.status === 'deleted') {
      markUnavailable(file.path, 'Deleted files have no content to edit');
      refreshItem(itemId);
      return;
    }

    const generation = fileSetKeyRef.current;
    void (async () => {
      try {
        await loadPierreEdit();
      } catch {
        markUnavailable(file.path, 'Editor failed to load');
        refreshItem(itemId);
        return;
      }
      const hydrated = await ensureFullContent(itemId, file);
      if (fileSetKeyRef.current !== generation) return;
      if (!hydrated.ok) {
        markUnavailable(file.path, hydrated.reason);
        refreshItem(itemId);
        return;
      }
      // A session may have been started elsewhere while we were loading.
      if (sessionRef.current) return;
      const handle = viewerRef.current;
      const item = handle?.getItem(itemId);
      if (handle == null || item == null || item.type !== 'diff') return;

      let pristine: FileDiffMetadata;
      try {
        pristine = cloneFileDiff(item.fileDiff);
      } catch {
        markUnavailable(file.path, 'This diff cannot be edited');
        refreshItem(itemId);
        return;
      }

      sessionRef.current = {
        itemId,
        filePath: file.path,
        pristine,
        // The editor document is additionLines joined verbatim (they carry
        // their own line breaks) — this is the derivation baseline.
        preEditContent: (item.fileDiff.additionLines ?? []).join(''),
        generation,
        dirty: false,
        latestContents: null,
        suppressSuggestions: false,
        ending: false,
        seq: 0,
        editor: null,
      };
      resetChangeCount();
      setEditing(itemId);
      item.collapsed = false;
      item.edit = true;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    })();
  });

  const onItemEditChange = useStableCallback(
    (item: CodeViewItem<DiffAnnotationMetadata>, file?: { contents: string }) => {
      const session = sessionRef.current;
      if (session && session.itemId === item.id) {
        session.dirty = true;
        // Keep the FileContents object, not a copy: its `contents` getter is
        // lazy, so holding it costs nothing per keystroke and the document
        // stays readable even after an unrouted teardown (see
        // recoverDirtySessionHunks).
        if (file) session.latestContents = file;
        // Refresh the HUD's net change count on a short debounce: the count is
        // a full-content line diff, so once per pause rather than per
        // keystroke. Guarded against the session ending before the timer fires.
        if (changeTimerRef.current != null) clearTimeout(changeTimerRef.current);
        changeTimerRef.current = setTimeout(() => {
          changeTimerRef.current = null;
          const live = sessionRef.current;
          if (!live || live.itemId !== item.id) return;
          publishChangeCount(recoverDirtySessionHunks(live).length);
        }, 250);
      }
    },
  );

  const onItemEditComplete = useStableCallback(
    (item: CodeViewItem<DiffAnnotationMetadata>, file: { contents: string }) => {
      const session = sessionRef.current;
      if (!session || session.itemId !== item.id) return;
      if (!session.suppressSuggestions) {
        // Copy immediately: `contents` is a live getter over the (already
        // cleaned-up) session document.
        const edited = String(file.contents);
        const hunks = deriveSuggestionHunks(session.preEditContent, edited);
        if (hunks.length > 0) onAddSuggestionsRef.current?.(session.filePath, hunks);
      }
      // External session end (a Pierre-initiated teardown we didn't route
      // through endSession, e.g. an unrouted collapse): restore on a fresh
      // task so we never re-enter the teardown's own updateItem, then clear
      // the session.
      if (!session.ending) {
        session.ending = true;
        sessionRef.current = null;
        editingItemIdRef.current = null;
        setEditingItemId(null);
        resetChangeCount();
        setTimeout(() => writeRestore(session), 0);
      }
    },
  );

  // Cast rationale: our factory returns undefined before the lazy chunk has
  // loaded — a guard the wired flow never hits (startEdit awaits the chunk
  // before flipping edit on; the React wrapper throws on an undefined
  // return). Upstream's React `CreateEditor` type does not model the
  // undefined return, hence the cast.
  const createEditor = useStableCallback((options: PierreEditorOptions) =>
    createPierreEditor(options),
  ) as unknown as CreateEditor<DiffAnnotationMetadata>;

  /** Marker projection is intentionally disabled: wavy underlines read as
   * errors in every editor's visual language, which misrepresents comments.
   * Annotations render in their normal slots below the code instead. Kept as
   * a no-op so callers need no knowledge of the decision. */
  const refreshMarkers = useStableCallback(() => {});

  /** Collapse the current editor selection to its end (post-submit cleanup;
   * see EditSessionApi.collapseSelection). Best-effort, never throws. */
  const collapseSelection = useStableCallback(() => {
    const editor = sessionRef.current?.editor;
    if (!editor) return;
    try {
      const sel = editor.getState().selections?.at(-1);
      if (!sel) return;
      editor.setSelections([{ start: sel.end, end: sel.end, direction: 'none' }]);
    } catch {
      // Cosmetic cleanup only; the session must never break over it.
    }
  });

  /** The Selection Action popover's "Make annotation" click. Everything is
   * snapshotted synchronously — the popover is torn down as soon as the
   * editor selection collapses (which focusing the app-side comment entry
   * causes), so nothing here may defer reading the selection. */
  const handleMakeAnnotation = useStableCallback(
    (context: PierreSelectionActionContext, anchorRect: DOMRect) => {
      const session = sessionRef.current;
      const sink = onSelectionAnnotationRef.current;
      if (!session || !sink) return;
      let selectedText = '';
      try {
        selectedText = context.getSelectionText();
      } catch {
        // Fall through with empty text; the anchor range still stands.
      }
      // The text document is the authoritative edited content at click time
      // (latestContents lags by one change-event dispatch at most, but the
      // document read is direct and always current).
      let edited: string;
      try {
        edited = context.textDocument.getText();
      } catch {
        try {
          edited = session.latestContents ? String(session.latestContents.contents) : session.preEditContent;
        } catch {
          edited = session.preEditContent;
        }
      }
      const { lineStart, lineEnd } = selectionToLineRange(context.selection);
      const anchor = mapEditedRangeToPristine(session.preEditContent, edited, lineStart, lineEnd);
      sink({
        filePath: session.filePath,
        lineStart: anchor.lineStart,
        lineEnd: anchor.lineEnd,
        exact: anchor.exact,
        selectedText,
        anchorRect,
      });
      try {
        context.close();
      } catch {
        // Popover teardown is Pierre's job; a failure here is cosmetic.
      }
    },
  );

  // Editor construction options. Markers surface the file's existing line
  // annotations during the session. Upstream delivers onAttach ONCE per
  // editor (an attachState.delivered guard) — it does not re-fire across
  // virtualization re-attaches — so this is a one-shot projection; the
  // retry loop below only covers the text document initializing after the
  // callback fires. The Selection Action popover (a plain DOM node rendered
  // into the editor's shadow DOM) carries the "Make annotation" action.
  const editorOptions = useMemo<EditSessionEditorOptions>(
    () => ({
      enabledSelectionAction: true,
      renderSelectionAction: (context: PierreSelectionActionContext) =>
        buildSelectionActionElement((anchorRect) => handleMakeAnnotation(context, anchorRect)),
      onAttach: (editor: unknown) => {
        const session = sessionRef.current;
        if (!session) return;
        // Stash the instance for selection collapse after annotation submit.
        session.editor = editor as PierreEditorInstance;
        // Annotation markers are intentionally not projected; see refreshMarkers.
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    editingItemId,
    editingItemIdRef,
    editUnavailableRef,
    dirtyStore,
    startEdit,
    completeEdit,
    cancelEdit,
    finishIfEditing,
    handleFileSetChange,
    refreshMarkers,
    collapseSelection,
    onItemEditChange,
    onItemEditComplete,
    createEditor,
    editorOptions,
  };
}
