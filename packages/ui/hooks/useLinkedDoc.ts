/**
 * Linked Document Hook
 *
 * Manages same-view navigation to local .md files referenced in plans.
 * Handles state swapping (save plan state, load doc, restore on back),
 * annotation caching per filepath, and highlight re-application.
 */

import { useState, useCallback, useRef } from "react";
import type { Annotation, ImageAttachment } from "../types";
import type { ViewerHandle } from "../components/Viewer";
import type { SidebarTab } from "./useSidebar";

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
  renderAs: 'markdown' | 'html';
  rawHtml: string;
  setRenderAs: (r: 'markdown' | 'html') => void;
  setRawHtml: (html: string) => void;
  viewerRef: React.RefObject<ViewerHandle | null>;
  sidebar: { open: (tab?: SidebarTab) => void };
  /** Absolute path of the primary document — enables getDocAnnotations() to include
   *  stashed original-file annotations when viewing a linked doc. */
  sourceFilePath?: string;
  /** Whether the primary document was converted from HTML/URL — propagated to the
   *  stashed entry so feedback caveats survive cross-doc navigation. */
  sourceConverted?: boolean;
}

interface SavedPlanState {
  markdown: string;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  globalAttachments: ImageAttachment[];
  renderAs: 'markdown' | 'html';
  rawHtml: string;
}

export interface CachedDocState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  markdown?: string;
  isConverted?: boolean;
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
  /** Open a linked document by path (saves plan state, fetches doc, swaps) */
  open: (docPath: string, buildUrl?: (path: string) => string, targetTab?: SidebarTab) => Promise<void>;
  /** Return to the plan (caches doc annotations, restores plan state) */
  back: () => void;
  /** Dismiss the current error */
  dismissError: () => void;
  /** All linked doc annotations including the active doc's live state (keyed by filepath) */
  getDocAnnotations: () => Map<string, CachedDocState>;
  /** Snapshot the root document plus linked-doc cache for cross-document session swaps */
  snapshotSession: () => LinkedDocSessionState;
  /** Restore a root document plus linked-doc cache, closing any active linked document */
  restoreSession: (state: LinkedDocSessionState) => void;
  /** Reactive count of annotations on non-active documents (updates on open() and back()) */
  docAnnotationCount: number;
}

const HIGHLIGHT_REAPPLY_DELAY = 100;

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
    setRenderAs,
    setRawHtml,
    viewerRef,
    sidebar,
    sourceFilePath,
    sourceConverted,
  } = options;

  const [linkedDoc, setLinkedDoc] = useState<{ filepath: string; isConverted?: boolean; markdown?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [docAnnotationCount, setDocAnnotationCount] = useState(0);

  // Stash plan state when navigating to a linked doc
  const savedPlanState = useRef<SavedPlanState | null>(null);

  // Cache linked doc annotations keyed by filepath (persists across back/forth within session)
  const docCache = useRef<Map<string, CachedDocState>>(new Map());

  const defaultBuildUrl = useCallback(
    (path: string) => `/api/doc?path=${encodeURIComponent(path)}`,
    []
  );

  const open = useCallback(
    async (docPath: string, buildUrl?: (path: string) => string, targetTab?: SidebarTab) => {
      setIsLoading(true);
      setError(null);

      try {
        const url = (buildUrl ?? defaultBuildUrl)(docPath);
        const res = await fetch(url);
        const data = (await res.json()) as {
          markdown?: string;
          filepath?: string;
          isConverted?: boolean;
          renderAs?: 'markdown' | 'html';
          rawHtml?: string;
          error?: string;
          matches?: string[];
        };

        if (!res.ok || data.error) {
          setError(data.error || "Failed to load document");
          return;
        }

        // Backlink detection: if a linked doc links back to the source file (e.g.,
        // original.md → design.md → link back to original.md), opening it as a linked
        // doc would create two competing Map entries for the same filepath in
        // getDocAnnotations(), and the empty linked-doc entry would overwrite the
        // stashed annotations. Instead, treat the backlink as a back() navigation —
        // the current linked doc gets cached and the source file restores with its
        // annotations intact.
        if (sourceFilePath && data.filepath === sourceFilePath && savedPlanState.current) {
          back();
          return;
        }

        // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
        viewerRef.current?.clearAllHighlights();

        // Save current state (plan or another linked doc)
        if (!savedPlanState.current) {
          savedPlanState.current = {
            markdown,
            annotations: [...annotations],
            selectedAnnotationId,
            globalAttachments: [...globalAttachments],
            renderAs,
            rawHtml,
          };
          let total = annotations.length + globalAttachments.length;
          for (const [fp, cached] of docCache.current.entries()) {
            if (fp === data.filepath!) continue; // destination becomes active — don't double-count
            total += cached.annotations.length + cached.globalAttachments.length;
          }
          setDocAnnotationCount(total);
        } else if (linkedDoc) {
          // Already viewing a linked doc — cache its annotations before moving on
          docCache.current.set(linkedDoc.filepath, {
            annotations: [...annotations],
            globalAttachments: [...globalAttachments],
            markdown: linkedDoc.markdown,
            isConverted: linkedDoc.isConverted,
          });
          let total = 0;
          for (const [fp, cached] of docCache.current.entries()) {
            if (fp === data.filepath!) continue; // destination becomes active — don't double-count
            total += cached.annotations.length + cached.globalAttachments.length;
          }
          if (savedPlanState.current) {
            total += savedPlanState.current.annotations.length + savedPlanState.current.globalAttachments.length;
          }
          setDocAnnotationCount(total);
        }

        // Check cache for previous annotations on this file
        const cached = docCache.current.get(data.filepath!);

        // Swap to linked doc — an .html file renders raw (HtmlViewer), a markdown
        // file parses to blocks (Viewer). Drive renderAs/rawHtml per file so the
        // App's renderAs === 'html' ? HtmlViewer : Viewer switch flips automatically.
        const docRenderAs = data.renderAs === 'html' ? 'html' : 'markdown';
        setRenderAs(docRenderAs);
        setRawHtml(docRenderAs === 'html' ? (data.rawHtml ?? '') : '');
        setMarkdown(docRenderAs === 'html' ? '' : (data.markdown ?? ''));
        setAnnotations(cached?.annotations ?? []);
        setGlobalAttachments(cached?.globalAttachments ?? []);
        setSelectedAnnotationId(null);
        setLinkedDoc({
          filepath: data.filepath!,
          isConverted: !!data.isConverted,
          markdown: data.markdown,
        });
        sidebar.open(targetTab ?? "toc");

        // Re-apply cached annotations after DOM settles
        if (cached?.annotations.length) {
          setTimeout(() => {
            viewerRef.current?.clearAllHighlights();
            viewerRef.current?.applySharedAnnotations(cached.annotations);
          }, HIGHLIGHT_REAPPLY_DELAY);
        }
      } catch {
        setError("Failed to connect to server");
      } finally {
        setIsLoading(false);
      }
    },
    [
      markdown,
      annotations,
      selectedAnnotationId,
      globalAttachments,
      renderAs,
      rawHtml,
      linkedDoc,
      setMarkdown,
      setAnnotations,
      setSelectedAnnotationId,
      setGlobalAttachments,
      setRenderAs,
      setRawHtml,
      viewerRef,
      sidebar,
    ]
  );

  const back = useCallback(() => {
    if (!savedPlanState.current) return;

    // Clear web-highlighter marks before swapping content to prevent React DOM mismatch
    viewerRef.current?.clearAllHighlights();

    // Cache current linked doc annotations
    if (linkedDoc) {
      docCache.current.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
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
    setMarkdown(saved.markdown);
    setAnnotations(saved.annotations);
    setGlobalAttachments(saved.globalAttachments);
    setSelectedAnnotationId(saved.selectedAnnotationId);
    setLinkedDoc(null);
    setError(null);
    savedPlanState.current = null;

    // Re-apply plan annotation highlights after DOM settles
    if (saved.annotations.length) {
      setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(saved.annotations);
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
    viewerRef,
  ]);

  const dismissError = useCallback(() => setError(null), []);

  const snapshotSession = useCallback((): LinkedDocSessionState => {
    const docs = new Map(docCache.current);
    if (linkedDoc) {
      docs.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
        markdown: linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
      });
    }

    const root = savedPlanState.current
      ? {
          markdown: savedPlanState.current.markdown,
          renderAs: savedPlanState.current.renderAs,
          rawHtml: savedPlanState.current.rawHtml,
          annotations: [...savedPlanState.current.annotations],
          selectedAnnotationId: savedPlanState.current.selectedAnnotationId,
          globalAttachments: [...savedPlanState.current.globalAttachments],
        }
      : {
          markdown,
          renderAs,
          rawHtml,
          annotations: [...annotations],
          selectedAnnotationId,
          globalAttachments: [...globalAttachments],
        };

    return { root, docs };
  }, [linkedDoc, annotations, globalAttachments, markdown, renderAs, rawHtml, selectedAnnotationId]);

  const restoreSession = useCallback((state: LinkedDocSessionState) => {
    viewerRef.current?.clearAllHighlights();

    savedPlanState.current = null;
    docCache.current = new Map(state.docs);
    let total = 0;
    for (const cached of docCache.current.values()) {
      total += cached.annotations.length + cached.globalAttachments.length;
    }
    setDocAnnotationCount(total);

    setMarkdown(state.root.markdown);
    setAnnotations([...state.root.annotations]);
    setGlobalAttachments([...state.root.globalAttachments]);
    setSelectedAnnotationId(state.root.selectedAnnotationId);
    setLinkedDoc(null);
    setError(null);

    if (state.root.annotations.length) {
      setTimeout(() => {
        viewerRef.current?.clearAllHighlights();
        viewerRef.current?.applySharedAnnotations(state.root.annotations);
      }, HIGHLIGHT_REAPPLY_DELAY);
    }
  }, [
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    viewerRef,
  ]);

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
        markdown: linkedDoc.markdown,
        isConverted: linkedDoc.isConverted,
      });
    }
    return result;
  }, [linkedDoc, annotations, globalAttachments, sourceFilePath, sourceConverted]);

  return {
    isActive: linkedDoc !== null,
    filepath: linkedDoc?.filepath ?? null,
    error,
    isLoading,
    open,
    back,
    dismissError,
    getDocAnnotations,
    snapshotSession,
    restoreSession,
    docAnnotationCount,
  };
}
