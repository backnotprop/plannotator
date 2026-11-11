import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeBrowserPath } from "@plannotator/core/browser-paths";
import { isDocumentRenderKind } from "@plannotator/core/annotatable";
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
  previousPlan?: string | null;
  versionInfo?: VersionInfo | null;
}

/** Resolve the version-diff baseline for a document being activated. */
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
  renderAs: DocumentRenderAs;
  rawHtml: string;
  shareHtml: string;
  setRenderAs: (r: DocumentRenderAs) => void;
  setRawHtml: (html: string) => void;
  setShareHtml: (html: string) => void;
  viewerRef: React.RefObject<ViewerHandle | null>;
  sidebar: { open: (tab?: SidebarTab) => void };
  sourceFilePath?: string;
  sourceConverted?: boolean;
  onBeforeNavigate?: () => void;
  onDocumentLoaded?: (doc: LinkedDocLoadData) => string | undefined;
  onDocumentActivated?: (doc: LinkedDocLoadData & { filepath: string }) => void;
  getDocumentMarkdown?: (filepath: string, fallback?: string) => string | undefined;
  onAfterBack?: () => void;
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
  scrollAnchor?: ScrollAnchor | null;
}

export interface CachedDocState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  markdown?: string;
  isConverted?: boolean;
  previousPlan?: string | null;
  versionInfo?: VersionInfo | null;
}

/**
 * The session's documents split the way FEEDBACK must be: the root document (the plan, the
 * annotated file, or the folder itself) once.
 */
export interface FeedbackDocuments {
  root: (CachedDocState & { renderAs: DocumentRenderAs }) | null;
  documents: Map<string, CachedDocState>;
}

export interface LinkedDocSessionState {
  root: SavedPlanState;
  docs: Map<string, CachedDocState>;
}

export interface UseLinkedDocReturn {
  isActive: boolean;
  filepath: string | null;
  error: string | null;
  isLoading: boolean;
  open: (
    docPath: string,
    buildUrl?: (path: string) => string,
    targetTab?: SidebarTab,
    options?: { revealSidebar?: boolean; restoreScroll?: boolean },
  ) => Promise<void>;
  openLoaded: (
    doc: LinkedDocLoadData & { filepath: string },
    targetTab?: SidebarTab,
    options?: { notifyDocumentLoaded?: boolean; revealSidebar?: boolean; restoreScroll?: boolean },
  ) => void;
  back: (options?: { restoreScroll?: boolean }) => void;
  cancelScrollRestore: () => void;
  dismissError: () => void;
  getDocAnnotations: () => Map<string, CachedDocState>;
  getFeedbackDocuments: () => FeedbackDocuments;
  /**
   * Replace the stored annotations of a document that is NOT the active one — a cached linked
   * doc, or the stashed source document.
   */
  updateStoredAnnotations: (
    filepath: string,
    update: (annotations: Annotation[]) => Annotation[],
  ) => boolean;
  restoreStoredDocuments: (
    documents: ReadonlyArray<{ path: string; annotations: Annotation[]; globalAttachments: ImageAttachment[] }>,
  ) => string[];
  snapshotSession: () => LinkedDocSessionState;
  restoreSession: (state: LinkedDocSessionState) => void;
  docAnnotationCount: number;
  diffPreviousPlan: string | null;
  diffVersionInfo: VersionInfo | null;
}

const HIGHLIGHT_REAPPLY_DELAY = 100;

const SCROLL_RESTORE_SETTLE_DELAYS = [HIGHLIGHT_REAPPLY_DELAY + 50, 400, 1000];
const SCROLL_RESTORE_MAX_WAIT_FRAMES = 60;
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

  const scrollViewportRef = useRef<HTMLElement | null>(scrollViewport ?? null);
  scrollViewportRef.current = scrollViewport ?? null;
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
  // Bumped whenever a stored (non-active) document's annotations change in place. docCache is a
  // ref, so without this the memos keyed on getDocAnnotations' identity — panel groups, counts,
  // the export — would keep serving the pre-mutation cache.
  const [storeRevision, setStoreRevision] = useState(0);

  const savedPlanState = useRef<SavedPlanState | null>(null);

  const docCache = useRef<Map<string, CachedDocState>>(new Map());
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
    frame(() => frame(firstApply));
  }, [cancelScrollRestore]);

  const back = useCallback((backOptions?: { restoreScroll?: boolean }) => {
    if (!savedPlanState.current) return;
    const restoreScroll = backOptions?.restoreScroll !== false;
    onBeforeNavigate?.();

    // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
    viewerRef.current?.clearAllHighlights();

    if (linkedDoc) {
      docCache.current.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: getDocumentMarkdown?.(linkedDoc.filepath, linkedDoc.markdown) ?? linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
        previousPlan: linkedDoc.previousPlan,
        versionInfo: linkedDoc.versionInfo,
      });
      let total = 0;
      for (const cached of docCache.current.values()) {
        total += cached.annotations.length + cached.globalAttachments.length;
      }
      setDocAnnotationCount(total);
    }

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
    const revealSidebar = options.revealSidebar ?? true;
    if (snapshotCurrent) onBeforeNavigate?.();

    if (sourceFilePath && data.filepath === sourceFilePath && savedPlanState.current) {
      back();
      onDocumentActivated?.(data);
      return;
    }

    // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
    viewerRef.current?.clearAllHighlights();

    // A restore of an earlier back() must not pull the new document around.
    cancelScrollRestore();

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

    const cached = docCache.current.get(data.filepath);

    const docRenderAs: DocumentRenderAs =
      data.renderAs === 'html' ? 'html' : isDocumentRenderKind(data.renderAs) ? data.renderAs : 'markdown';
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

    const scrollAnchor = options.restoreScroll
      ? docScrollAnchors.current.get(normalizeBrowserPath(data.filepath))
      : undefined;
    if (scrollAnchor) restoreScrollAnchorSettled(scrollAnchor);

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
    const wanted = normalizeBrowserPath(filepath);

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
