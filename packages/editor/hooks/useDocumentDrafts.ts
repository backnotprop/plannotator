/**
 * Per-document draft copies for local-file and folder annotate sessions
 * (server: packages/shared/annotate-draft.ts, `/api/draft/document`).
 *
 * The session draft (useAnnotationDraft) carries the session's ROOT document.
 * Every other document the reviewer comments on — a folder session's files, a
 * single-file session's linked documents — is saved under that file's path,
 * so the comments survive a crash and come back when the file is opened again
 * in any session, alone or in a folder, even after an agent edited it. Each
 * document's saved comments are merged in the first time it is opened in this
 * session (ids the session already holds are skipped) and re-anchor by text;
 * one whose text is gone gets the Unanchored chip and still exports.
 *
 * Inert unless the server advertised `documentDrafts` on /api/plan.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import type { FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import { documentDraftAdditions, planDocumentDraftWrites, type DocumentDraftState } from '../documentDrafts';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';

const DEBOUNCE_MS = 500;
const HIGHLIGHT_REAPPLY_DELAY = 100;

export interface UseDocumentDraftsOptions {
  enabled: boolean;
  /** A decision was sent (or is in flight): stop writing. */
  submitted: boolean;
  /** The open linked/folder document, or null while the root is open. */
  activePath: string | null;
  /** A single-file session's own file: saved by the session draft, never here. */
  rootPath: string | null;
  getFeedbackDocuments: () => FeedbackDocuments;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  setAnnotations: (annotations: Annotation[]) => void;
  setGlobalAttachments: (attachments: ImageAttachment[]) => void;
  updateStoredAnnotations: (filepath: string, update: (annotations: Annotation[]) => Annotation[]) => boolean;
  viewerRef: RefObject<ViewerHandle | null>;
  /** Called before saved comments are merged into the open document. */
  onBeforeMerge?: () => void;
  /** Saved comments were merged into a document. */
  onRestored?: (path: string, count: number) => void;
}

export interface UseDocumentDraftsResult {
  /**
   * Documents the server will not keep a path copy for: outside the session's
   * roots (an Obsidian vault document), a symlink alias of the session's own
   * file, or not a regular file. The host keeps their comments in the session
   * draft instead, so they stay crash-recoverable.
   */
  unbackedPaths: ReadonlySet<string>;
  /** Send a pending (debounced) write now, if there is one (see
      useAnnotationDraft's flushPendingSave). */
  flushPendingWrite: () => void;
}

export function useDocumentDrafts(options: UseDocumentDraftsOptions): UseDocumentDraftsResult {
  const { enabled, submitted, activePath, rootPath, getFeedbackDocuments } = options;
  const latest = useRef(options);
  latest.current = options;

  /** Documents whose saved copy was read (found or not). */
  const loadedRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Set<string>());
  /** What the server holds for each document, as last sent by this page. */
  const lastSentRef = useRef(new Map<string, string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writingRef = useRef(false);
  const rerunRef = useRef(false);
  /** The server refused a write because the review is decided. */
  const closedRef = useRef(false);

  const [unbackedPaths, setUnbackedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const canWrite = enabled && !submitted;
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;

  const mergeSaved = useCallback((path: string, saved: { annotations: unknown; globalAttachments: unknown }) => {
    const current = latest.current;
    if (current.activePath === path) {
      const additions = documentDraftAdditions(
        { annotations: current.annotations, globalAttachments: current.globalAttachments },
        saved,
      );
      const count = additions.annotations.length + additions.globalAttachments.length;
      if (count === 0) return;
      current.onBeforeMerge?.();
      const merged = [...current.annotations, ...additions.annotations];
      current.setAnnotations(merged);
      if (additions.globalAttachments.length > 0) {
        current.setGlobalAttachments([...current.globalAttachments, ...additions.globalAttachments]);
      }
      setTimeout(() => {
        current.viewerRef.current?.clearAllHighlights();
        current.viewerRef.current?.applySharedAnnotations(merged.filter(annotationOwnsHighlight));
      }, HIGHLIGHT_REAPPLY_DELAY);
      current.onRestored?.(path, count);
      return;
    }
    // The reviewer moved on before the copy arrived: merge into the stored
    // document instead (attachments of a stored document are not editable
    // from here, so only comments merge on this path).
    let added = 0;
    current.updateStoredAnnotations(path, (held) => {
      const additions = documentDraftAdditions({ annotations: held, globalAttachments: [] }, saved);
      added = additions.annotations.length;
      return added > 0 ? [...held, ...additions.annotations] : held;
    });
    if (added > 0) current.onRestored?.(path, added);
  }, []);

  // Read a document's saved copy the first time it is opened.
  useEffect(() => {
    if (!enabled || !activePath) return;
    if (rootPath && activePath === rootPath) return;
    if (loadedRef.current.has(activePath) || inFlightRef.current.has(activePath)) return;
    const path = activePath;
    inFlightRef.current.add(path);
    fetch(`/api/draft/document?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (res.status === 404) {
          loadedRef.current.add(path);
          return;
        }
        if (res.status === 400 || res.status === 403) {
          // Never loaded, so never written here: the session draft carries it.
          setUnbackedPaths((prev) => (prev.has(path) ? prev : new Set([...prev, path])));
          return;
        }
        if (!res.ok) return; // retried the next time the document opens
        const body = (await res.json().catch(() => null)) as { annotations?: unknown; globalAttachments?: unknown } | null;
        if (!body) return;
        loadedRef.current.add(path);
        // The copy is what the server holds now: sending it back unchanged is
        // pointless, and anything the merge adds still differs from it.
        lastSentRef.current.set(path, JSON.stringify([
          Array.isArray(body.annotations) ? body.annotations : [],
          Array.isArray(body.globalAttachments) ? body.globalAttachments : [],
        ]));
        mergeSaved(path, { annotations: body.annotations, globalAttachments: body.globalAttachments });
      })
      .catch(() => {})
      .finally(() => {
        inFlightRef.current.delete(path);
      });
  }, [enabled, activePath, rootPath, mergeSaved]);

  const writeNow = useCallback((keepalive: boolean) => {
    if (!canWriteRef.current || closedRef.current) return;
    if (writingRef.current) {
      rerunRef.current = true;
      return;
    }
    const current = latest.current;
    const { documents } = current.getFeedbackDocuments();
    const states = new Map<string, DocumentDraftState>();
    for (const [path, state] of documents) {
      states.set(path, { annotations: state.annotations, globalAttachments: state.globalAttachments });
    }
    const { writes, sent } = planDocumentDraftWrites({
      documents: states,
      lastSent: lastSentRef.current,
      loaded: loadedRef.current,
      rootPath: current.rootPath,
    });
    if (writes.length === 0) return;
    writingRef.current = true;
    fetch('/api/draft/document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: writes }),
      keepalive,
    })
      .then((res) => {
        if (res.ok) {
          lastSentRef.current = sent;
        } else if (res.status === 409) {
          closedRef.current = true;
        }
      })
      .catch(() => {})
      .finally(() => {
        writingRef.current = false;
        if (rerunRef.current) {
          rerunRef.current = false;
          writeNow(false);
        }
      });
  }, []);

  // Debounced write whenever any document's comments change.
  useEffect(() => {
    if (!canWrite) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      writeNow(false);
    }, DEBOUNCE_MS);
  }, [canWrite, getFeedbackDocuments, writeNow]);

  // Flush a pending write when the page is hidden or closed.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      writeNow(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [writeNow]);

  const flushPendingWrite = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    writeNow(false);
  }, [writeNow]);

  return { unbackedPaths, flushPendingWrite };
}
