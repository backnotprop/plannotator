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

export interface UseLinkedDocOptions {
  markdown: string;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  globalAttachments: ImageAttachment[];
  setMarkdown: (md: string) => void;
  setAnnotations: (anns: Annotation[]) => void;
  setSelectedAnnotationId: (id: string | null) => void;
  setGlobalAttachments: (att: ImageAttachment[]) => void;
  viewerRef: React.RefObject<ViewerHandle | null>;
  sidebar: { open: (tab: string) => void };
}

interface SavedPlanState {
  markdown: string;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  globalAttachments: ImageAttachment[];
}

export interface CachedDocState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
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
  open: (docPath: string) => Promise<void>;
  /** Return to the plan (caches doc annotations, restores plan state) */
  back: () => void;
  /** Dismiss the current error */
  dismissError: () => void;
  /** All linked doc annotations including the active doc's live state (keyed by filepath) */
  getDocAnnotations: () => Map<string, CachedDocState>;
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
    viewerRef,
    sidebar,
  } = options;

  const [linkedDoc, setLinkedDoc] = useState<{ filepath: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Stash plan state when navigating to a linked doc
  const savedPlanState = useRef<SavedPlanState | null>(null);

  // Cache linked doc annotations keyed by filepath (persists across back/forth within session)
  const docCache = useRef<Map<string, CachedDocState>>(new Map());

  const open = useCallback(
    async (docPath: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/doc?path=${encodeURIComponent(docPath)}`
        );
        const data = (await res.json()) as {
          markdown?: string;
          filepath?: string;
          error?: string;
          matches?: string[];
        };

        if (!res.ok || data.error) {
          setError(data.error || "Failed to load document");
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
          };
        } else if (linkedDoc) {
          // Already viewing a linked doc — cache its annotations before moving on
          docCache.current.set(linkedDoc.filepath, {
            annotations: [...annotations],
            globalAttachments: [...globalAttachments],
          });
        }

        // Check cache for previous annotations on this file
        const cached = docCache.current.get(data.filepath!);

        // Swap to linked doc
        setMarkdown(data.markdown!);
        setAnnotations(cached?.annotations ?? []);
        setGlobalAttachments(cached?.globalAttachments ?? []);
        setSelectedAnnotationId(null);
        setLinkedDoc({ filepath: data.filepath! });
        sidebar.open("toc");

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
      linkedDoc,
      setMarkdown,
      setAnnotations,
      setSelectedAnnotationId,
      setGlobalAttachments,
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
      });
    }

    // Restore plan state
    const saved = savedPlanState.current;
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
    viewerRef,
  ]);

  const dismissError = useCallback(() => setError(null), []);

  const getDocAnnotations = useCallback((): Map<string, CachedDocState> => {
    const result = new Map(docCache.current);
    if (linkedDoc) {
      result.set(linkedDoc.filepath, {
        annotations: [...annotations],
        globalAttachments: [...globalAttachments],
      });
    }
    return result;
  }, [linkedDoc, annotations, globalAttachments]);

  return {
    isActive: linkedDoc !== null,
    filepath: linkedDoc?.filepath ?? null,
    error,
    isLoading,
    open,
    back,
    dismissError,
    getDocAnnotations,
  };
}
