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

interface ActiveEditSession {
  itemId: string;
  filePath: string;
  pristine: FileDiffMetadata;
  preEditContent: string;
  generation: string;
  dirty: boolean;
  /**
   * The FileContents delivered with the most recent change event. Its `contents` getter closes over
   * the session's TextDocument (which stays readable after Pierre's editor cleanup), so a dirty
   * session torn down by a CodeView remount can still recover its final text from here.
   */
  latestContents: { contents: string } | null;
  /** Set by Cancel: the completion callback must not create suggestions. */
  suppressSuggestions: boolean;
  ending: boolean;
  seq: number;
  editor: PierreEditorInstance | null;
}

export interface EditSelectionAnnotationRequest {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  exact: boolean;
  selectedText: string;
  anchorRect: DOMRect;
}

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
  onSelectionAnnotation?: (request: EditSelectionAnnotationRequest) => void;
  refreshItem: (itemId: string) => void;
}

/**
 * The HUD lives inside Pierre's memoized header slot portal, which only republishes on updateItem —
 * never on parent state changes — so the count is delivered as a subscribable the HUD reads via
 * useSyncExternalStore, letting it re-render itself while the user types without touching the item.
 */
export interface EditSessionDirtyStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

export interface EditSessionApi {
  editingItemId: string | null;
  /**
   * Pierre's header slots republish synchronously inside updateItem — BEFORE React commits the
   * state update — so anything rendered into a slot must read this ref, never the state value.
   */
  editingItemIdRef: React.RefObject<string | null>;
  /** filePath -> human-readable reason the edit button is disabled. Ref for
   * the same slot-portal ordering reason as editingItemIdRef. */
  editUnavailableRef: React.RefObject<Map<string, string>>;
  startEdit: (itemId: string) => void;
  completeEdit: () => void;
  cancelEdit: () => void;
  finishIfEditing: (itemId: string) => void;
  dirtyStore: EditSessionDirtyStore;
  handleFileSetChange: () => void;
  /** No-op outside a session; markers are best-effort chrome (never throws). */
  refreshMarkers: () => void;
  collapseSelection: () => void;
  onItemEditChange: (
    item: CodeViewItem<DiffAnnotationMetadata>,
    file?: { contents: string },
  ) => void;
  onItemEditComplete: (
    item: CodeViewItem<DiffAnnotationMetadata>,
    file: { contents: string },
  ) => void;
  createEditor: CreateEditor<DiffAnnotationMetadata>;
  /** Structural subset of Pierre's EditorOptions so the generic variance stays out of app code. */
  editorOptions: EditSessionEditorOptions;
}

export interface EditSessionEditorOptions {
  enabledSelectionAction: boolean;
  renderSelectionAction: (context: PierreSelectionActionContext) => HTMLElement;
  onAttach: (editor: unknown) => void;
}

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
    editingItemIdRef.current = itemId;
    setEditingItemId(itemId);
  };

  const markUnavailable = (filePath: string, reason: string) => {
    editUnavailableRef.current.set(filePath, reason);
  };

  const writeRestore = useStableCallback((session: ActiveEditSession) => {
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
    // Pinned to @pierre/diffs 1.3.2: the updateItem above is NOT enough to repaint the pristine
    // content.
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
    }
  });

  const endSession = useStableCallback((suppress: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    session.suppressSuggestions = suppress;
    session.ending = true;
    // The write republishes the header slot synchronously, so the editing ref must already read
    // idle; sessionRef must still point at this session because onItemEditComplete fires from
    // inside the write.
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
    // The old items are unreachable and Pierre tore the editor down without a completion callback,
    // so the session cannot continue.
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
    editUnavailableRef.current.clear();
  });

  /**
   * Pierre's applyDocumentChange THROWS on partial diffs, so this is a hard precondition for
   * starting a session.
   */
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
        if (file) session.latestContents = file;
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
        const edited = String(file.contents);
        const hunks = deriveSuggestionHunks(session.preEditContent, edited);
        if (hunks.length > 0) onAddSuggestionsRef.current?.(session.filePath, hunks);
      }
      // External session end (a Pierre-initiated teardown we didn't route through endSession, e.g.
      // an unrouted collapse): restore on a fresh task so we never re-enter the teardown's own
      // updateItem, then clear the session.
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

  const createEditor = useStableCallback((options: PierreEditorOptions) =>
    createPierreEditor(options),
  ) as unknown as CreateEditor<DiffAnnotationMetadata>;

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

  const handleMakeAnnotation = useStableCallback(
    (context: PierreSelectionActionContext, anchorRect: DOMRect) => {
      const session = sessionRef.current;
      const sink = onSelectionAnnotationRef.current;
      if (!session || !sink) return;
      let selectedText = '';
      try {
        selectedText = context.getSelectionText();
      } catch {
      }
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

  // The Selection Action popover (a plain DOM node rendered into the editor's shadow DOM) carries
  // the "Make annotation" action.
  const editorOptions = useMemo<EditSessionEditorOptions>(
    () => ({
      enabledSelectionAction: true,
      renderSelectionAction: (context: PierreSelectionActionContext) =>
        buildSelectionActionElement((anchorRect) => handleMakeAnnotation(context, anchorRect)),
      onAttach: (editor: unknown) => {
        const session = sessionRef.current;
        if (!session) return;
        session.editor = editor as PierreEditorInstance;
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
