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
import {
  buildEditorMarkers,
  createPierreEditor,
  loadPierreEdit,
  type PierreEditorInstance,
  type PierreEditorOptions,
} from './pierreEditAdapter';

/**
 * Controller for the flag-gated "edit code to author a suggestion" session
 * (one file at a time, plain all-files view only).
 *
 * Lifecycle contract with Pierre's CodeView (v1.3.1):
 * - `item.edit = true` + version bump + updateItem starts a session (needs an
 *   EditProvider factory above the CodeView; ours declines until the lazy
 *   editor chunk has loaded).
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
  /** Set by Cancel: the completion callback must not create suggestions. */
  suppressSuggestions: boolean;
  /** Set by our explicit complete/cancel paths (restore already scheduled). */
  ending: boolean;
  /** Monotonic per-session counter for fresh restore cacheKeys. */
  seq: number;
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
  /** Republish one item's slots (version bump + updateItem). */
  refreshItem: (itemId: string) => void;
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
  /** Called by the fileSetKey reset effect: the old items are gone. */
  handleFileSetChange: () => void;
  /** CodeView prop: fires per document change while a session is active. */
  onItemEditChange: (item: CodeViewItem<DiffAnnotationMetadata>) => void;
  /** CodeView prop: fires once when a session with changes ends. */
  onItemEditComplete: (
    item: CodeViewItem<DiffAnnotationMetadata>,
    file: { contents: string },
  ) => void;
  /** EditProvider factory. Returns undefined until the lazy editor chunk has
   * loaded — CodeView's documented decline-and-retry contract, which
   * upstream's React `CreateEditor` type does not yet model (hence the cast
   * where this is produced). */
  createEditor: CreateEditor<DiffAnnotationMetadata>;
  /** Editor construction options (markers wired via onAttach). Structural
   * subset of Pierre's EditorOptions so the generic variance stays out of
   * app code. */
  editorOptions: EditSessionEditorOptions;
}

export interface EditSessionEditorOptions {
  enabledSelectionAction: boolean;
  onAttach: (editor: unknown) => void;
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
    refreshItem,
  } = params;

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const editingItemIdRef = useRef<string | null>(null);
  const editUnavailableRef = useRef<Map<string, string>>(new Map());
  const sessionRef = useRef<ActiveEditSession | null>(null);
  const onAddSuggestionsRef = useRef(onAddSuggestions);
  onAddSuggestionsRef.current = onAddSuggestions;

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
  });

  /** End the current session. `suppress` skips suggestion creation (Cancel).
   *
   * Upstream's documented commit pattern is ONE combined item write: edit off
   * AND the final fileDiff (fresh cacheKey) in the same updateItem. A
   * two-step write (edit off first, restore later) races CodeView's own
   * session-teardown re-render — on large files the teardown render lands
   * after the deferred restore and leaves the edited content on screen. The
   * completion callback still fires from this write with the session's final
   * contents, which is all the suggestion derivation needs. */
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
  });

  const completeEdit = useStableCallback(() => endSession(false));
  const cancelEdit = useStableCallback(() => endSession(true));

  const finishIfEditing = useStableCallback((itemId: string) => {
    if (sessionRef.current?.itemId === itemId) endSession(false);
  });

  const handleFileSetChange = useStableCallback(() => {
    // The CodeView holding the session remounted (diff switch / refresh). The
    // old items are unreachable; Pierre tore the editor down without a
    // completion callback. Drop the session — in-progress edits are discarded
    // (documented v1 behavior; refresh is always user-initiated).
    if (sessionRef.current) {
      sessionRef.current = null;
      setEditing(null);
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
        suppressSuggestions: false,
        ending: false,
        seq: 0,
      };
      setEditing(itemId);
      item.collapsed = false;
      item.edit = true;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    })();
  });

  const onItemEditChange = useStableCallback((item: CodeViewItem<DiffAnnotationMetadata>) => {
    const session = sessionRef.current;
    if (session && session.itemId === item.id) session.dirty = true;
  });

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
        setTimeout(() => writeRestore(session), 0);
      }
    },
  );

  // Cast rationale: our factory returns undefined before the lazy chunk has
  // loaded. That is CodeView's documented "decline the attach; retry on later
  // render passes" contract, but upstream's React `CreateEditor` type does
  // not model the undefined return yet.
  const createEditor = useStableCallback((options: PierreEditorOptions) =>
    createPierreEditor(options),
  ) as unknown as CreateEditor<DiffAnnotationMetadata>;

  // Editor construction options. Markers surface the file's existing line
  // annotations during the session; onAttach re-fires across virtualization
  // re-attaches, which is exactly when markers need re-applying.
  const editorOptions = useMemo<EditSessionEditorOptions>(
    () => ({
      enabledSelectionAction: false,
      onAttach: (editor: unknown) => {
        const session = sessionRef.current;
        if (!session) return;
        const markers = buildEditorMarkers(annotationsRef.current ?? [], session.filePath);
        if (markers.length === 0) return;
        // Markers are best-effort chrome; never let them break the session.
        // setMarkers throws until the editor's text document is initialized,
        // which can be after onAttach — retry across a few frames.
        const itemId = session.itemId;
        let attempts = 0;
        const apply = () => {
          if (sessionRef.current?.itemId !== itemId) return;
          try {
            (editor as PierreEditorInstance).setMarkers(markers);
          } catch {
            attempts += 1;
            if (attempts < 10) requestAnimationFrame(apply);
          }
        };
        requestAnimationFrame(apply);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    editingItemId,
    editingItemIdRef,
    editUnavailableRef,
    startEdit,
    completeEdit,
    cancelEdit,
    finishIfEditing,
    handleFileSetChange,
    onItemEditChange,
    onItemEditComplete,
    createEditor,
    editorOptions,
  };
}
