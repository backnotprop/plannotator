/**
 * Linked Document Hook
 *
 * Manages same-view navigation to local .md files referenced in plans.
 * Handles state swapping (save plan state, load doc, restore on back),
 * annotation caching per filepath, and highlight re-application.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeBrowserPath } from "@plannotator/core/browser-paths";
import { isDiagramRenderKind } from "@plannotator/core/annotatable";
import type { Annotation, DocumentRenderAs, ImageAttachment } from "../types";
import type { ViewerHandle } from "../components/Viewer";
import type { SidebarTab } from "./useSidebar";
import type { SourceSaveCapability } from "@plannotator/core/source-save";
import type { VersionInfo } from "./usePlanDiff";
import { annotationOwnsHighlight } from "../utils/annotationOwnsHighlight";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  scrollAnchorReady,
  type ScrollAnchor,
} from "../utils/scrollAnchor";
import { getScrollViewportTop } from "./useScrollViewport";

export interface LinkedDocLoadData {
  markdown?: string;
  filepath?: string;
  isConverted?: boolean;
  renderAs?: DocumentRenderAs;
  rawHtml?: string;
  shareHtml?: string;
  sourceSave?: SourceSaveCapability;
  /**
   * Per-file version-diff baseline (annotate folder sessions only) — the same
   * field names/shapes /api/plan already returns for single-file sessions.
   * /api/doc only populates these for eligible folder files (local annotatable
   * plain-text files — .md/.mdx/.txt plus the config set, per
   * `isAnnotatableTextPath` — markdown-branch, not converted/HTML); every other
   * document — including
   * plain linked docs outside folder mode — omits them, which is what keeps
   * the diff badge/version browser from appearing for those.
   */
  previousPlan?: string | null;
  versionInfo?: VersionInfo | null;
}

/**
 * Resolve the version-diff baseline for a document being activated: prefer
 * an already-cached baseline (set the first time this document was opened)
 * over the freshly-fetched `data`, so re-opening a document during a session
 * never loses — or needs to re-request — its baseline. Pure so it's testable
 * without mounting the hook; used by activateDocument below.
 *
 * Gated on whether a baseline was EVER captured for this document (versionInfo
 * presence), not on truthiness of the cached previousPlan value — a document
 * at its first-ever version legitimately caches `previousPlan: null` ("no
 * earlier version to diff against yet"), which is a resolved fact, not a
 * cache miss. Falling through to `data` on a plain `??` would silently
 * discard that fact whenever `data` lacks the fields too (e.g. the
 * missing-on-disk openLoaded path, which never fetches /api/doc).
 */
export function resolveDiffBaseline(
  cached: Pick<CachedDocState, 'previousPlan' | 'versionInfo'> | undefined,
  data: Pick<LinkedDocLoadData, 'previousPlan' | 'versionInfo'>,
): { previousPlan: string | null | undefined; versionInfo: VersionInfo | null | undefined } {
  if (cached && cached.versionInfo !== undefined) {
    return { previousPlan: cached.previousPlan, versionInfo: cached.versionInfo };
  }
  return { previousPlan: data.previousPlan, versionInfo: data.versionInfo };
}

export interface UseLinkedDocOptions {
  markdown: string;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  globalAttachments: ImageAttachment[];
  setMarkdown: (md: string) => void;
  setAnnotations: (anns: Annotation[]) => void;
  setSelectedAnnotationId: (id: string | null) => void;
  setGlobalAttachments: (att: ImageAttachment[]) => void;
  /** Current render mode + raw HTML of the base document. An HTML linked/folder file
   *  swaps these to render raw; back() restores the base values from this snapshot. */
  renderAs: DocumentRenderAs;
  rawHtml: string;
  shareHtml: string;
  setRenderAs: (r: DocumentRenderAs) => void;
  setRawHtml: (html: string) => void;
  setShareHtml: (html: string) => void;
  viewerRef: React.RefObject<ViewerHandle | null>;
  sidebar: { open: (tab?: SidebarTab) => void };
  /** Absolute path of the primary document — enables getDocAnnotations() to include
   *  stashed original-file annotations when viewing a linked doc. */
  sourceFilePath?: string;
  /** Whether the primary document was converted from HTML/URL — propagated to the
   *  stashed entry so feedback caveats survive cross-doc navigation. */
  sourceConverted?: boolean;
  /** Snapshot live editor state before linked/folder navigation swaps documents. */
  onBeforeNavigate?: () => void;
  /** Let the host initialize/restore editable document state and optionally
   *  override the markdown displayed for this file. */
  onDocumentLoaded?: (doc: LinkedDocLoadData) => string | undefined;
  /** Notify the host after any fetched or already-loaded destination has been
   *  activated, including HTML documents and backlinks to the source. */
  onDocumentActivated?: (doc: LinkedDocLoadData & { filepath: string }) => void;
  /** Read current host-owned text when caching a linked doc. */
  getDocumentMarkdown?: (filepath: string, fallback?: string) => string | undefined;
  /** Let the host restore any state that was suspended while a linked doc was active. */
  onAfterBack?: () => void;
  /**
   * The element the documents scroll in (the host's ScrollViewportContext
   * value). When given, opening a linked document remembers where the reader
   * was in the root document, and back() returns them there. Omitted, nothing
   * about scrolling changes.
   */
  scrollViewport?: HTMLElement | null;
}

interface SavedPlanState {
  markdown: string;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  globalAttachments: ImageAttachment[];
  renderAs: DocumentRenderAs;
  rawHtml: string;
  shareHtml: string;
  /** Where the reader was in the root document when it was left. */
  scrollAnchor?: ScrollAnchor | null;
}

export interface CachedDocState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  markdown?: string;
  isConverted?: boolean;
  /** Version-diff baseline captured the first time this document was
   *  activated — see LinkedDocLoadData. Persisted here so re-opening the
   *  same document later in the session reuses it instead of losing it (or
   *  needing to re-fetch it) once the fresh /api/doc data is gone. */
  previousPlan?: string | null;
  versionInfo?: VersionInfo | null;
}

/**
 * The session's documents split the way FEEDBACK must be: the root document
 * (the plan, the annotated file, or the folder itself) once, and every other
 * document once under its own path. `getDocAnnotations()` is NOT this split —
 * it also carries the active document's live state, which the host exports
 * from its own state too, so exporting both printed the open document twice.
 */
export interface FeedbackDocuments {
  /**
   * The root document's stashed state while a linked document is open. Null
   * while the root itself is the active document: its annotations are then
   * the host's live state, which the host exports itself.
   */
  root: (CachedDocState & { renderAs: DocumentRenderAs }) | null;
  /**
   * Every document other than the root that carries state, keyed by path:
   * the cached documents plus the active linked document's live state. The
   * root's own annotations are never here; a copy of the root's path opened
   * from the root itself is a separate annotation set and is listed by path.
   */
  documents: Map<string, CachedDocState>;
}

export interface LinkedDocSessionState {
  root: SavedPlanState;
  docs: Map<string, CachedDocState>;
}

export interface UseLinkedDocReturn {
  /** Whether a linked doc is currently active */
  isActive: boolean;
  /** Resolved filepath of the active linked doc */
  filepath: string | null;
  /** Error from the last open attempt */
  error: string | null;
  /** Whether a fetch is in progress */
  isLoading: boolean;
  /** Open a linked document by path (saves plan state, fetches doc, swaps).
   *  `revealSidebar: false` leaves the sidebar exactly as it was.
   *  `restoreScroll: true` (with a `scrollViewport`) returns the reader to
   *  where they were when they last left this linked document for another
   *  one: a host's Back to a document that is not the root (a review of
   *  several files goes back to the file a link was followed from). */
  open: (
    docPath: string,
    buildUrl?: (path: string) => string,
    targetTab?: SidebarTab,
    options?: { revealSidebar?: boolean; restoreScroll?: boolean },
  ) => Promise<void>;
  /** Open an already-loaded linked document without refetching from disk */
  openLoaded: (
    doc: LinkedDocLoadData & { filepath: string },
    targetTab?: SidebarTab,
    options?: { notifyDocumentLoaded?: boolean; revealSidebar?: boolean; restoreScroll?: boolean },
  ) => void;
  /** Return to the plan (caches doc annotations, restores plan state). With a
   *  `scrollViewport`, the reader's place in the root comes back too, unless
   *  `restoreScroll: false` (a caller that scrolls to a target itself). */
  back: (options?: { restoreScroll?: boolean }) => void;
  /** Stop a scroll restore that back() started and is still settling. A host
   *  that scrolls programmatically (a jump to a comment or a section) calls it
   *  first, so the restore cannot cancel or undo that scroll. */
  cancelScrollRestore: () => void;
  /** Dismiss the current error */
  dismissError: () => void;
  /** All linked doc annotations including the active doc's live state (keyed by filepath).
   *  For counts and the cross-file panel; a feedback export reads getFeedbackDocuments(). */
  getDocAnnotations: () => Map<string, CachedDocState>;
  /** The root document and every other document, each exactly once — what a
   *  feedback export reads (see FeedbackDocuments). */
  getFeedbackDocuments: () => FeedbackDocuments;
  /**
   * Replace the stored annotations of a document that is NOT the active one —
   * a cached linked doc, or the stashed source document. This is what lets the
   * panel's cross-file view edit and delete another file's comments without
   * navigating to it; the active document's annotations are host state
   * (`setAnnotations`) and are deliberately never touched here.
   *
   * Returns false when no stored document matches (including the active one),
   * so a host can fall back to its own live-state path.
   */
  updateStoredAnnotations: (
    filepath: string,
    update: (annotations: Annotation[]) => Annotation[],
  ) => boolean;
  /**
   * Put recovered comments back on documents other than the active one, by
   * path (a restored draft that carried several documents). A cached document
   * gains the entries whose id (attachments: path) it does not hold yet; a
   * document not opened in this session gets a cache entry, so its comments
   * count, list and export at once, and show when it is opened. Returns the
   * paths not taken: the active document's comments are host state.
   */
  restoreStoredDocuments: (
    documents: ReadonlyArray<{ path: string; annotations: Annotation[]; globalAttachments: ImageAttachment[] }>,
  ) => string[];
  /** Snapshot the root document plus linked-doc cache for cross-document session swaps */
  snapshotSession: () => LinkedDocSessionState;
  /** Restore a root document plus linked-doc cache, closing any active linked document */
  restoreSession: (state: LinkedDocSessionState) => void;
  /** Reactive count of annotations on non-active documents (updates on open() and back()) */
  docAnnotationCount: number;
  /** Active document's version-diff baseline (folder annotate only). Null
   *  when no document is active, or the active document has no eligible
   *  history — including every non-folder linked doc, since /api/doc never
   *  populates these fields for those. */
  diffPreviousPlan: string | null;
  diffVersionInfo: VersionInfo | null;
}

const HIGHLIGHT_REAPPLY_DELAY = 100;

/**
 * After back(), the root document is re-anchored on the next frames until its
 * blocks are in the DOM, then again at these delays (ms) to absorb late layout:
 * re-applied highlights, images that finish loading, a sidebar that resizes the
 * reading column. A scroll the reader makes in between ends it.
 */
const SCROLL_RESTORE_SETTLE_DELAYS = [HIGHLIGHT_REAPPLY_DELAY + 50, 400, 1000];
const SCROLL_RESTORE_MAX_WAIT_FRAMES = 60;
/** The reader's own input, which ends a restore still settling. */
const READER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

export function useLinkedDoc(options: UseLinkedDocOptions): UseLinkedDocReturn {
  const {
    markdown,
    annotations,
    selectedAnnotationId,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    renderAs,
    rawHtml,
    shareHtml,
    setRenderAs,
    setRawHtml,
    setShareHtml,
    viewerRef,
    sidebar,
    sourceFilePath,
    sourceConverted,
    onBeforeNavigate,
    onDocumentLoaded,
    onDocumentActivated,
    getDocumentMarkdown,
    onAfterBack,
    scrollViewport,
  } = options;

  // Read through a ref so back() keeps its identity when the viewport mounts.
  const scrollViewportRef = useRef<HTMLElement | null>(scrollViewport ?? null);
  scrollViewportRef.current = scrollViewport ?? null;
  // The restore of the last back(), while it settles: stops it and releases
  // its frames, timers and listeners. Null when nothing is settling.
  const stopScrollRestoreRef = useRef<(() => void) | null>(null);
  const cancelScrollRestore = useCallback(() => {
    const stop = stopScrollRestoreRef.current;
    stopScrollRestoreRef.current = null;
    stop?.();
  }, []);
  useEffect(() => cancelScrollRestore, [cancelScrollRestore]);

  const [linkedDoc, setLinkedDoc] = useState<{
    filepath: string;
    isConverted?: boolean;
    markdown?: string;
    previousPlan?: string | null;
    versionInfo?: VersionInfo | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [docAnnotationCount, setDocAnnotationCount] = useState(0);
  // Bumped whenever a stored (non-active) document's annotations change in
  // place. docCache is a ref, so without this the memos keyed on
  // getDocAnnotations' identity — panel groups, counts, the export — would
  // keep serving the pre-mutation cache.
  const [storeRevision, setStoreRevision] = useState(0);

  // Stash plan state when navigating to a linked doc
  const savedPlanState = useRef<SavedPlanState | null>(null);

  // Cache linked doc annotations keyed by filepath (persists across back/forth within session)
  const docCache = useRef<Map<string, CachedDocState>>(new Map());
  // Where the reader was in each linked document when they left it for
  // another one, keyed by normalized path. Read only by an open() that asks
  // for `restoreScroll` (the root's place lives in savedPlanState instead).
  const docScrollAnchors = useRef<Map<string, ScrollAnchor>>(new Map());

  const defaultBuildUrl = useCallback(
    (path: string) => `/api/doc?path=${encodeURIComponent(path)}`,
    []
  );

  const restoreScrollAnchorSettled = useCallback((anchor: ScrollAnchor) => {
    cancelScrollRestore();
    let stopped = false;
    const frames = new Set<number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const win = typeof window === 'undefined' ? null : window;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const id of frames) cancelAnimationFrame(id);
      for (const id of timers) clearTimeout(id);
      frames.clear();
      timers.clear();
      for (const type of READER_INPUT_EVENTS) win?.removeEventListener(type, onReaderInput, true);
      if (stopScrollRestoreRef.current === stop) stopScrollRestoreRef.current = null;
    };
    // Any input of the reader's own ends the restore: from then on, where the
    // page is is theirs.
    function onReaderInput() { stop(); }
    for (const type of READER_INPUT_EVENTS) {
      win?.addEventListener(type, onReaderInput, { capture: true, passive: true });
    }
    stopScrollRestoreRef.current = stop;

    const frame = (fn: () => void) => {
      const id = requestAnimationFrame(() => { frames.delete(id); fn(); });
      frames.add(id);
    };
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
    };

    let lastTop: number | null = null;
    const apply = () => {
      const viewport = scrollViewportRef.current;
      if (stopped || !viewport) return;
      // Something else scrolled since the last re-anchor (the reader, or the
      // host scrolling to a target): that position wins.
      if (lastTop !== null && Math.abs(getScrollViewportTop(viewport) - lastTop) > 2) {
        stop();
        return;
      }
      lastTop = restoreScrollAnchor(viewport, anchor);
    };
    let waited = 0;
    const firstApply = () => {
      if (stopped) return;
      const viewport = scrollViewportRef.current;
      if (viewport && scrollAnchorReady(viewport, anchor)) {
        apply();
        if (stopped) return;
        const last = SCROLL_RESTORE_SETTLE_DELAYS[SCROLL_RESTORE_SETTLE_DELAYS.length - 1];
        for (const delay of SCROLL_RESTORE_SETTLE_DELAYS) {
          later(() => { apply(); if (delay === last) stop(); }, delay);
        }
        return;
      }
      if (++waited > SCROLL_RESTORE_MAX_WAIT_FRAMES) {
        if (viewport) apply();
        stop();
        return;
      }
      frame(firstApply);
    };
    // Two frames: the swap commits, then layout settles.
    frame(() => frame(firstApply));
  }, [cancelScrollRestore]);

  const back = useCallback((backOptions?: { restoreScroll?: boolean }) => {
    if (!savedPlanState.current) return;
    // `back` may be handed straight to an onClick, so only an explicit false
    // turns the restore off.
    const restoreScroll = backOptions?.restoreScroll !== false;
    onBeforeNavigate?.();

    // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
    viewerRef.current?.clearAllHighlights();

    // Cache current linked doc annotations
    if (linkedDoc) {
      docCache.current.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
        previousPlan: linkedDoc.previousPlan,
        versionInfo: linkedDoc.versionInfo,
      });
      // Update reactive count so button labels can respond
      let total = 0;
      for (const cached of docCache.current.values()) {
        total += cached.annotations.length + cached.globalAttachments.length;
      }
      setDocAnnotationCount(total);
    }

    // Restore plan state (including render mode — an HTML base restores to HTML)
    const saved = savedPlanState.current;
    setRenderAs(saved.renderAs);
    setRawHtml(saved.rawHtml);
    setShareHtml(saved.shareHtml);
    setMarkdown(saved.markdown);
    setAnnotations(saved.annotations);
    setGlobalAttachments(saved.globalAttachments);
    setSelectedAnnotationId(saved.selectedAnnotationId);
    setLinkedDoc(null);
    setError(null);
    savedPlanState.current = null;
    onAfterBack?.();
    if (restoreScroll && saved.scrollAnchor) restoreScrollAnchorSettled(saved.scrollAnchor);
    else cancelScrollRestore();

    // Re-apply plan annotation highlights after DOM settles
    if (saved.annotations.length) {
      setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(saved.annotations.filter(annotationOwnsHighlight));
      }, HIGHLIGHT_REAPPLY_DELAY);
    }
  }, [
    linkedDoc,
    annotations,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    setRenderAs,
    setRawHtml,
    setShareHtml,
    viewerRef,
    onBeforeNavigate,
    getDocumentMarkdown,
    onAfterBack,
    restoreScrollAnchorSettled,
    cancelScrollRestore,
  ]);

  const activateDocument = useCallback((
    data: LinkedDocLoadData & { filepath: string },
    targetTab?: SidebarTab,
    options: {
      snapshotCurrent?: boolean;
      notifyDocumentLoaded?: boolean;
      revealSidebar?: boolean;
      restoreScroll?: boolean;
    } = {},
  ) => {
    const snapshotCurrent = options.snapshotCurrent ?? true;
    const notifyDocumentLoaded = options.notifyDocumentLoaded ?? true;
    // Opening a document reveals the sidebar so its "Viewing / Back to …"
    // header is in reach. A host whose surface has its own way back (the
    // raw-HTML header's Back control) passes false, and the sidebar is left
    // exactly as the user had it — closed stays closed, open stays put.
    const revealSidebar = options.revealSidebar ?? true;
    if (snapshotCurrent) onBeforeNavigate?.();

    // Backlink detection: if a linked doc links back to the source file (e.g.,
    // original.md → design.md → link back to original.md), opening it as a linked
    // doc would create two competing Map entries for the same filepath in
    // getDocAnnotations(), and the empty linked-doc entry would overwrite the
    // stashed annotations. Instead, treat the backlink as a back() navigation —
    // the current linked doc gets cached and the source file restores with its
    // annotations intact.
    if (sourceFilePath && data.filepath === sourceFilePath && savedPlanState.current) {
      back();
      onDocumentActivated?.(data);
      return;
    }

    // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
    viewerRef.current?.clearAllHighlights();

    // A restore of an earlier back() must not pull the new document around.
    cancelScrollRestore();

    // Save current state (plan or another linked doc)
    if (!savedPlanState.current) {
      const viewport = scrollViewportRef.current;
      savedPlanState.current = {
        scrollAnchor: viewport ? captureScrollAnchor(viewport) : null,
        markdown,
        annotations: [...annotations],
        selectedAnnotationId,
        globalAttachments: [...globalAttachments],
        renderAs,
        rawHtml,
        shareHtml,
      };
      let total = annotations.length + globalAttachments.length;
      for (const [fp, cached] of docCache.current.entries()) {
        if (fp === data.filepath) continue; // destination becomes active — don't double-count
        total += cached.annotations.length + cached.globalAttachments.length;
      }
      setDocAnnotationCount(total);
    } else if (linkedDoc) {
      // Already viewing a linked doc — remember the reader's place in it and
      // cache its annotations before moving on
      const viewport = scrollViewportRef.current;
      if (viewport) {
        docScrollAnchors.current.set(normalizeBrowserPath(linkedDoc.filepath), captureScrollAnchor(viewport));
      }
      docCache.current.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
        previousPlan: linkedDoc.previousPlan,
        versionInfo: linkedDoc.versionInfo,
      });
      let total = 0;
      for (const [fp, cached] of docCache.current.entries()) {
        if (fp === data.filepath) continue; // destination becomes active — don't double-count
        total += cached.annotations.length + cached.globalAttachments.length;
      }
      if (savedPlanState.current) {
        total += savedPlanState.current.annotations.length + savedPlanState.current.globalAttachments.length;
      }
      setDocAnnotationCount(total);
    }

    // Check cache for previous annotations on this file
    const cached = docCache.current.get(data.filepath);

    // Swap to linked doc — an .html file renders raw (HtmlViewer), a markdown
    // file parses to blocks (Viewer). Drive renderAs/rawHtml per file so the
    // App's renderAs === 'html' ? HtmlViewer : Viewer switch flips automatically.
    // A diagram source (.mmd/.dot) keeps the markdown state path — the raw
    // text is the document body — but names its engine so the App renders it
    // as one diagram instead of parsing it as markdown.
    const docRenderAs: DocumentRenderAs =
      data.renderAs === 'html' ? 'html' : isDiagramRenderKind(data.renderAs) ? data.renderAs : 'markdown';
    const hostMarkdown = docRenderAs === 'html' || !notifyDocumentLoaded ? undefined : onDocumentLoaded?.(data);
    const nextMarkdown = notifyDocumentLoaded
      ? hostMarkdown ?? cached?.markdown ?? data.markdown ?? ''
      : data.markdown ?? cached?.markdown ?? '';
    setRenderAs(docRenderAs);
    setRawHtml(docRenderAs === 'html' ? (data.rawHtml ?? '') : '');
    setShareHtml(docRenderAs === 'html' ? (data.shareHtml ?? '') : '');
    setMarkdown(docRenderAs === 'html' ? '' : nextMarkdown);
    setAnnotations(cached?.annotations ?? []);
    setGlobalAttachments(cached?.globalAttachments ?? []);
    setSelectedAnnotationId(null);
    const diffBaseline = resolveDiffBaseline(cached, data);
    setLinkedDoc({
      filepath: data.filepath,
      isConverted: !!data.isConverted,
      markdown: nextMarkdown,
      previousPlan: diffBaseline.previousPlan,
      versionInfo: diffBaseline.versionInfo,
    });
    setError(null);
    if (revealSidebar) sidebar.open(targetTab ?? "toc");
    onDocumentActivated?.(data);

    // Back to a linked document the reader left for another one: put them
    // back where they were, exactly as back() does for the root.
    const scrollAnchor = options.restoreScroll
      ? docScrollAnchors.current.get(normalizeBrowserPath(data.filepath))
      : undefined;
    if (scrollAnchor) restoreScrollAnchorSettled(scrollAnchor);

    // Re-apply cached annotations after DOM settles
    if (cached?.annotations.length) {
      setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(cached.annotations.filter(annotationOwnsHighlight));
      }, HIGHLIGHT_REAPPLY_DELAY);
    }
  }, [
    markdown,
    annotations,
    selectedAnnotationId,
    globalAttachments,
    renderAs,
    rawHtml,
    shareHtml,
    linkedDoc,
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    setRenderAs,
    setRawHtml,
    setShareHtml,
    viewerRef,
    sidebar,
    sourceFilePath,
    onBeforeNavigate,
    onDocumentLoaded,
    onDocumentActivated,
    getDocumentMarkdown,
    back,
    cancelScrollRestore,
    restoreScrollAnchorSettled,
  ]);

  const openLoaded = useCallback((
    doc: LinkedDocLoadData & { filepath: string },
    targetTab?: SidebarTab,
    options?: { notifyDocumentLoaded?: boolean; revealSidebar?: boolean; restoreScroll?: boolean },
  ) => {
    activateDocument(doc, targetTab, {
      snapshotCurrent: true,
      notifyDocumentLoaded: options?.notifyDocumentLoaded,
      revealSidebar: options?.revealSidebar,
      restoreScroll: options?.restoreScroll,
    });
  }, [activateDocument]);

  const open = useCallback(
    async (
      docPath: string,
      buildUrl?: (path: string) => string,
      targetTab?: SidebarTab,
      options?: { revealSidebar?: boolean; restoreScroll?: boolean },
    ) => {
      onBeforeNavigate?.();
      setIsLoading(true);
      setError(null);

      try {
        const url = (buildUrl ?? defaultBuildUrl)(docPath);
        const res = await fetch(url);
        const data = (await res.json()) as LinkedDocLoadData & {
          error?: string;
          matches?: string[];
        };

        if (!res.ok || data.error) {
          setError(data.error || "Failed to load document");
          return;
        }

        if (!data.filepath) {
          setError("Failed to load document");
          return;
        }
        activateDocument({ ...data, filepath: data.filepath }, targetTab, {
          snapshotCurrent: false,
          revealSidebar: options?.revealSidebar,
          restoreScroll: options?.restoreScroll,
        });
      } catch {
        setError("Failed to connect to server");
      } finally {
        setIsLoading(false);
      }
    },
    [
      onBeforeNavigate,
      activateDocument,
    ]
  );

  const dismissError = useCallback(() => setError(null), []);

  const snapshotSession = useCallback((): LinkedDocSessionState => {
    const docs = new Map(docCache.current);
    if (linkedDoc) {
      docs.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
        previousPlan: linkedDoc.previousPlan,
        versionInfo: linkedDoc.versionInfo,
      });
    }

    const root = savedPlanState.current
      ? {
          markdown: savedPlanState.current.markdown,
          renderAs: savedPlanState.current.renderAs,
          rawHtml: savedPlanState.current.rawHtml,
          shareHtml: savedPlanState.current.shareHtml,
          annotations: [...savedPlanState.current.annotations],
          selectedAnnotationId: savedPlanState.current.selectedAnnotationId,
          globalAttachments: [...savedPlanState.current.globalAttachments],
        }
      : {
          markdown,
          renderAs,
          rawHtml,
          shareHtml,
          annotations: [...annotations],
          selectedAnnotationId,
          globalAttachments: [...globalAttachments],
        };

    return { root, docs };
  }, [linkedDoc, annotations, globalAttachments, markdown, renderAs, rawHtml, shareHtml, selectedAnnotationId, getDocumentMarkdown]);

  const restoreSession = useCallback((state: LinkedDocSessionState) => {
    viewerRef.current?.clearAllHighlights();
    cancelScrollRestore();

    savedPlanState.current = null;
    docCache.current = new Map(state.docs);
    docScrollAnchors.current = new Map();
    let total = 0;
    for (const cached of docCache.current.values()) {
      total += cached.annotations.length + cached.globalAttachments.length;
    }
    setDocAnnotationCount(total);

    setMarkdown(state.root.markdown);
    setRenderAs(state.root.renderAs);
    setRawHtml(state.root.rawHtml);
    setShareHtml(state.root.shareHtml);
    setAnnotations([...state.root.annotations]);
    setGlobalAttachments([...state.root.globalAttachments]);
    setSelectedAnnotationId(state.root.selectedAnnotationId);
    setLinkedDoc(null);
    setError(null);

    if (state.root.annotations.length) {
      setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(state.root.annotations.filter(annotationOwnsHighlight));
      }, HIGHLIGHT_REAPPLY_DELAY);
    }
  }, [
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    setRenderAs,
    setRawHtml,
    setShareHtml,
    viewerRef,
  ]);

  const updateStoredAnnotations = useCallback((
    filepath: string,
    update: (annotations: Annotation[]) => Annotation[],
  ): boolean => {
    // Callers address documents by whatever spelling their list carries — the
    // panel's groups are normalized (forward slashes, collapsed separators)
    // while the cache is keyed by the raw server path. On Windows those differ
    // (`C:/repo/a.md` vs `C:\repo\a.md`) and an unnormalized lookup missed
    // every time, so a cross-file edit or delete silently did nothing.
    const wanted = normalizeBrowserPath(filepath);

    // The active document's annotations live in host state, not the cache — a
    // write here would be silently overwritten the next time it is cached.
    if (linkedDoc && wanted === normalizeBrowserPath(linkedDoc.filepath)) return false;

    let cacheKey: string | undefined;
    for (const key of docCache.current.keys()) {
      if (normalizeBrowserPath(key) === wanted) { cacheKey = key; break; }
    }
    const cached = cacheKey === undefined ? undefined : docCache.current.get(cacheKey);
    if (cached && cacheKey !== undefined) {
      docCache.current.set(cacheKey, { ...cached, annotations: update([...cached.annotations]) });
    } else if (savedPlanState.current && sourceFilePath && wanted === normalizeBrowserPath(sourceFilePath)) {
      const saved = savedPlanState.current;
      savedPlanState.current = { ...saved, annotations: update([...saved.annotations]) };
    } else {
      return false;
    }

    // Same accounting as activateDocument/back: everything except the document
    // that is active right now.
    let total = 0;
    for (const [fp, entry] of docCache.current.entries()) {
      if (linkedDoc && fp === linkedDoc.filepath) continue;
      total += entry.annotations.length + entry.globalAttachments.length;
    }
    if (linkedDoc && savedPlanState.current) {
      total += savedPlanState.current.annotations.length + savedPlanState.current.globalAttachments.length;
    }
    setDocAnnotationCount(total);
    setStoreRevision((r) => r + 1);
    return true;
  }, [linkedDoc, sourceFilePath]);

  const restoreStoredDocuments = useCallback((
    documents: ReadonlyArray<{ path: string; annotations: Annotation[]; globalAttachments: ImageAttachment[] }>,
  ): string[] => {
    const notTaken: string[] = [];
    let changed = false;
    for (const doc of documents) {
      const wanted = normalizeBrowserPath(doc.path);
      if (linkedDoc && wanted === normalizeBrowserPath(linkedDoc.filepath)) {
        notTaken.push(doc.path);
        continue;
      }
      let cacheKey: string | undefined;
      for (const key of docCache.current.keys()) {
        if (normalizeBrowserPath(key) === wanted) { cacheKey = key; break; }
      }
      const cached = cacheKey === undefined ? undefined : docCache.current.get(cacheKey);
      const heldIds = new Set((cached?.annotations ?? []).map((a) => a.id));
      const heldPaths = new Set((cached?.globalAttachments ?? []).map((g) => g.path));
      const annotations = doc.annotations.filter((a) => !heldIds.has(a.id));
      const globalAttachments = doc.globalAttachments.filter((g) => !heldPaths.has(g.path));
      if (annotations.length === 0 && globalAttachments.length === 0) continue;
      docCache.current.set(cacheKey ?? doc.path, {
        ...(cached ?? {}),
        annotations: [...(cached?.annotations ?? []), ...annotations],
        globalAttachments: [...(cached?.globalAttachments ?? []), ...globalAttachments],
      });
      changed = true;
    }
    if (changed) {
      // Same accounting as updateStoredAnnotations.
      let total = 0;
      for (const [fp, entry] of docCache.current.entries()) {
        if (linkedDoc && fp === linkedDoc.filepath) continue;
        total += entry.annotations.length + entry.globalAttachments.length;
      }
      if (linkedDoc && savedPlanState.current) {
        total += savedPlanState.current.annotations.length + savedPlanState.current.globalAttachments.length;
      }
      setDocAnnotationCount(total);
      setStoreRevision((r) => r + 1);
    }
    return notTaken;
  }, [linkedDoc]);

  const getDocAnnotations = useCallback((): Map<string, CachedDocState> => {
    const result = new Map(docCache.current);
    // Include stashed original-file annotations when viewing a linked doc
    if (linkedDoc && savedPlanState.current && sourceFilePath) {
      result.set(sourceFilePath, {
        annotations: [...savedPlanState.current.annotations],
        globalAttachments: [...savedPlanState.current.globalAttachments],
        markdown: savedPlanState.current.markdown,
        isConverted: !!sourceConverted,
      });
    }
    if (linkedDoc) {
      result.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
      });
    }
    return result;
    // storeRevision: cross-file edits mutate docCache in place, so the
    // identity of this callback is what tells memoized readers to recompute.
  }, [linkedDoc, annotations, globalAttachments, sourceFilePath, sourceConverted, getDocumentMarkdown, storeRevision]);

  const getFeedbackDocuments = useCallback((): FeedbackDocuments => {
    const documents = new Map(docCache.current);
    if (linkedDoc) {
      documents.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
      });
    }
    // A cache entry under the root's own path is NOT the root: it is a copy
    // the reviewer opened from the root itself (an HTML "Home" link, or
    // index.html#intro from index.html — a backlink only routes through
    // back() while a linked doc is open). Its comments are a separate set the
    // counts include, so it is exported under its path, never dropped.
    const saved = linkedDoc ? savedPlanState.current : null;
    return {
      root: saved
        ? {
            annotations: [...saved.annotations],
            globalAttachments: [...saved.globalAttachments],
            markdown: saved.markdown,
            isConverted: !!sourceConverted,
            renderAs: saved.renderAs,
          }
        : null,
      documents,
    };
    // storeRevision: same reason as getDocAnnotations above.
  }, [linkedDoc, annotations, globalAttachments, sourceConverted, getDocumentMarkdown, storeRevision]);

  return {
    isActive: linkedDoc !== null,
    filepath: linkedDoc?.filepath ?? null,
    error,
    isLoading,
    open,
    openLoaded,
    back,
    cancelScrollRestore,
    dismissError,
    getDocAnnotations,
    getFeedbackDocuments,
    updateStoredAnnotations,
    restoreStoredDocuments,
    snapshotSession,
    restoreSession,
    docAnnotationCount,
    diffPreviousPlan: linkedDoc?.previousPlan ?? null,
    diffVersionInfo: linkedDoc?.versionInfo ?? null,
  };
}
