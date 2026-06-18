/**
 * Auto-save annotation drafts to the server.
 *
 * Stores full Annotation[] objects directly (preserving all fields
 * including `source`, `id`, offsets, and meta). On mount, checks for
 * an existing draft and exposes banner state for the UI to offer restoration.
 *
 * Direct edits persist alongside annotations: the host supplies a
 * `getEditedMarkdown` getter (the live editor buffer or last committed edit,
 * null when none) and calls `scheduleDraftSave()` on edit activity. The
 * getter is read at save time, not reactively, so per-keystroke saves don't
 * require pushing the full document through React state.
 *
 * Backward compatible: loads old tuple-serialized drafts via fromShareable().
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { SourceSaveCapability } from '@plannotator/shared/source-save';
import type { Annotation, CodeAnnotation, ImageAttachment } from '../types';
import { fromShareable, parseShareableImages } from '../utils/sharing';
import type { ShareableAnnotation } from '../utils/sharing';

const DEBOUNCE_MS = 500;

type DraftSourceSaveCapability = Extract<SourceSaveCapability, { enabled: true }>;

export interface DraftEditedDocument {
  key: string;
  sourceSave: DraftSourceSaveCapability;
  sessionOpenText: string;
  diskBaseline: string;
  currentText: string;
  savedChange?: DraftSavedFileChange;
}

export interface DraftSavedFileChange {
  key: string;
  path: string;
  basename: string;
  beforeText: string;
  afterText: string;
  beforeHash?: string;
  afterHash?: string;
  sourceSave: DraftSourceSaveCapability;
}

/** New format: full objects. */
interface DraftData {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  /** Direct-edit document text. Present only when it differs from the
      as-submitted baseline ('' is a real value: a committed emptied doc). */
  editedMarkdown?: string;
  /** Source-backed direct edits for folder/single-file annotate sessions. */
  editedDocuments?: DraftEditedDocument[];
  /** Source-backed edits that were already saved to disk but not sent yet. */
  savedFileChanges?: DraftSavedFileChange[];
  ts: number;
}

/** Old format: compact tuples (for backward compat on load). */
interface LegacyDraftData {
  a: ShareableAnnotation[];
  g?: unknown[];
  d?: (string | null)[];
  ts: number;
}

function isLegacyDraft(data: unknown): data is LegacyDraftData {
  return !!data && typeof data === 'object' && 'a' in data && Array.isArray((data as LegacyDraftData).a);
}

function parseDraftEditedDocument(value: unknown): DraftEditedDocument | null {
  if (!value || typeof value !== 'object') return null;
  const doc = value as Partial<DraftEditedDocument>;
  const sourceSave = doc.sourceSave as Partial<DraftSourceSaveCapability> | undefined;
  if (!(
    typeof doc.key === 'string' &&
    typeof doc.sessionOpenText === 'string' &&
    typeof doc.diskBaseline === 'string' &&
    typeof doc.currentText === 'string' &&
    isDraftSourceSaveCapability(sourceSave)
  )) {
    return null;
  }
  const savedChange = parseDraftSavedFileChange(doc.savedChange, sourceSave);
  return {
    key: doc.key,
    sourceSave,
    sessionOpenText: doc.sessionOpenText,
    diskBaseline: doc.diskBaseline,
    currentText: doc.currentText,
    ...(savedChange ? { savedChange } : {}),
  };
}

function isDraftSavedFileChange(value: unknown): value is DraftSavedFileChange {
  return parseDraftSavedFileChange(value) !== null;
}

function parseDraftSavedFileChange(
  value: unknown,
  fallbackSourceSave?: DraftSourceSaveCapability,
): DraftSavedFileChange | null {
  if (!value || typeof value !== 'object') return null;
  const change = value as Partial<DraftSavedFileChange>;
  if (!(
    typeof change.key === 'string' &&
    typeof change.path === 'string' &&
    typeof change.basename === 'string' &&
    typeof change.beforeText === 'string' &&
    typeof change.afterText === 'string' &&
    (change.beforeHash === undefined || typeof change.beforeHash === 'string') &&
    (change.afterHash === undefined || typeof change.afterHash === 'string')
  )) {
    return null;
  }
  const sourceSave = isDraftSourceSaveCapability(change.sourceSave)
    ? change.sourceSave
    : fallbackSourceSave;
  if (!sourceSave) return null;
  return {
    key: change.key,
    path: change.path,
    basename: change.basename,
    beforeText: change.beforeText,
    afterText: change.afterText,
    beforeHash: change.beforeHash,
    afterHash: change.afterHash,
    sourceSave,
  };
}

function isDraftSourceSaveCapability(value: unknown): value is DraftSourceSaveCapability {
  const sourceSave = value as Partial<DraftSourceSaveCapability> | undefined;
  return (
    !!sourceSave &&
    sourceSave.enabled === true &&
    typeof sourceSave.path === 'string' &&
    typeof sourceSave.basename === 'string' &&
    typeof sourceSave.hash === 'string' &&
    typeof sourceSave.mtimeMs === 'number' &&
    typeof sourceSave.size === 'number' &&
    typeof sourceSave.eol === 'string'
  );
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

interface UseAnnotationDraftOptions {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  /** Current direct-edit text (live buffer or last commit), or null when the
      document matches the as-submitted baseline. Read at save time. */
  getEditedMarkdown?: () => string | null;
  /** Current dirty source-backed documents. Read at save time. */
  getEditedDocuments?: () => DraftEditedDocument[];
  /** Current saved source-backed edits. Read at save time. */
  getSavedFileChanges?: () => DraftSavedFileChange[];
  isApiMode: boolean;
  isSharedSession: boolean;
  submitted: boolean;
}

interface RestoredDraft {
  annotations: Annotation[];
  codeAnnotations: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  editedMarkdown: string | null;
  editedDocuments: DraftEditedDocument[];
  savedFileChanges: DraftSavedFileChange[];
}

interface UseAnnotationDraftResult {
  draftBanner: { count: number; timeAgo: string; hasEdits: boolean } | null;
  restoreDraft: () => RestoredDraft;
  /** Debounced save trigger for changes the reactive deps can't see
      (editor keystrokes, edit commit/discard). Stable identity. */
  scheduleDraftSave: () => void;
  dismissDraft: () => void;
}

export function useAnnotationDraft({
  annotations,
  codeAnnotations = [],
  globalAttachments,
  getEditedMarkdown,
  getEditedDocuments,
  getSavedFileChanges,
  isApiMode,
  isSharedSession,
  submitted,
}: UseAnnotationDraftOptions): UseAnnotationDraftResult {
  const [draftBanner, setDraftBanner] = useState<{ count: number; timeAgo: string; hasEdits: boolean } | null>(null);
  const draftDataRef = useRef<RestoredDraft | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);

  // Latest-values ref so the stable scheduleDraftSave reads current data when
  // the debounce fires, without re-creating callbacks per keystroke.
  const latestRef = useRef({ annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges });
  latestRef.current = { annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges };
  const canPersist = isApiMode && !isSharedSession && !submitted;
  const canPersistRef = useRef(canPersist);
  canPersistRef.current = canPersist;

  // Load draft on mount
  useEffect(() => {
    if (!isApiMode || isSharedSession) return;

    fetch('/api/draft')
      .then(res => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: DraftData | LegacyDraftData | null) => {
        if (!data) {
          hasMountedRef.current = true;
          return;
        }

        let restoredAnnotations: Annotation[];
        let restoredCodeAnnotations: CodeAnnotation[] = [];
        let restoredGlobal: ImageAttachment[];

        if (isLegacyDraft(data)) {
          // Old tuple format — deserialize via fromShareable
          restoredAnnotations = data.a.length > 0 ? fromShareable(data.a, data.d) : [];
          restoredGlobal = data.g ? (parseShareableImages(data.g as Parameters<typeof parseShareableImages>[0]) ?? []) : [];
        } else if (Array.isArray(data.annotations)) {
          // New direct-object format
          restoredAnnotations = data.annotations;
          restoredCodeAnnotations = Array.isArray(data.codeAnnotations) ? data.codeAnnotations : [];
          restoredGlobal = Array.isArray(data.globalAttachments) ? data.globalAttachments : [];
        } else if (Array.isArray((data as DraftData).codeAnnotations) && (data as DraftData).codeAnnotations!.length > 0) {
          restoredAnnotations = [];
          restoredCodeAnnotations = (data as DraftData).codeAnnotations!;
          restoredGlobal = Array.isArray((data as DraftData).globalAttachments) ? (data as DraftData).globalAttachments : [];
        } else {
          hasMountedRef.current = true;
          return;
        }

        const restoredEdited =
          !isLegacyDraft(data) && typeof (data as DraftData).editedMarkdown === 'string'
            ? (data as DraftData).editedMarkdown!
            : null;
        const restoredEditedDocuments =
          !isLegacyDraft(data) && Array.isArray((data as DraftData).editedDocuments)
            ? (data as DraftData).editedDocuments!
                .map(parseDraftEditedDocument)
                .filter((doc): doc is DraftEditedDocument => doc !== null)
            : [];
        const restoredSavedFileChanges =
          !isLegacyDraft(data) && Array.isArray((data as DraftData).savedFileChanges)
            ? (data as DraftData).savedFileChanges!.filter(isDraftSavedFileChange)
            : [];

        const totalCount = restoredAnnotations.length + restoredCodeAnnotations.length + restoredGlobal.length;
        if (totalCount > 0 || restoredEdited !== null || restoredEditedDocuments.length > 0 || restoredSavedFileChanges.length > 0) {
          draftDataRef.current = {
            annotations: restoredAnnotations,
            codeAnnotations: restoredCodeAnnotations,
            globalAttachments: restoredGlobal,
            editedMarkdown: restoredEdited,
            editedDocuments: restoredEditedDocuments,
            savedFileChanges: restoredSavedFileChanges,
          };
          setDraftBanner({
            count: totalCount,
            timeAgo: formatTimeAgo(data.ts || 0),
            hasEdits: restoredEdited !== null || restoredEditedDocuments.length > 0 || restoredSavedFileChanges.length > 0,
          });
        }
        hasMountedRef.current = true;
      })
      .catch(() => {
        hasMountedRef.current = true;
      });
  }, [isApiMode, isSharedSession]);

  const persistNow = useCallback((keepalive: boolean) => {
    // Re-check: the session may have been submitted while the debounce was
    // pending — a save landing after submit would resurrect a draft the
    // server just deleted, ghosting it into the next session for this plan.
    if (!canPersistRef.current) return;
    const { annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges } = latestRef.current;
    const editedMarkdown = getEditedMarkdown?.() ?? null;
    const editedDocuments = getEditedDocuments?.() ?? [];
    const savedFileChanges = getSavedFileChanges?.() ?? [];

    if (annotations.length === 0 && codeAnnotations.length === 0 && globalAttachments.length === 0 && editedMarkdown === null && editedDocuments.length === 0 && savedFileChanges.length === 0) {
      // Everything was cleared (last annotation removed, edits discarded).
      // A stale draft left on disk would offer back content the user
      // explicitly threw away.
      fetch('/api/draft', { method: 'DELETE', keepalive }).catch(() => {});
      return;
    }

    const payload: DraftData = {
      annotations,
      codeAnnotations,
      globalAttachments,
      ...(editedMarkdown !== null ? { editedMarkdown } : {}),
      ...(editedDocuments.length > 0 ? { editedDocuments } : {}),
      ...(savedFileChanges.length > 0 ? { savedFileChanges } : {}),
      ts: Date.now(),
    };

    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    fetch('/api/draft', { method: 'POST', headers, body, keepalive }).catch(() => {
      // Chromium caps keepalive bodies (~64KB); retry without it. Completes
      // fine when the page was only backgrounded, best-effort on close.
      if (keepalive && canPersistRef.current) fetch('/api/draft', { method: 'POST', headers, body }).catch(() => {});
      // Otherwise silent failure — draft is best-effort.
    });
  }, []);

  const scheduleDraftSave = useCallback(() => {
    if (!canPersistRef.current || !hasMountedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persistNow(false);
    }, DEBOUNCE_MS);
  }, [persistNow]);

  // Flush a pending save when the page is backgrounded or closed — otherwise
  // the last debounce window of typing is lost on tab close, and reopening
  // the (still-running) session would restore a draft missing those
  // keystrokes. Only fires when a save is actually pending.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      persistNow(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [persistNow]);

  // Debounced auto-save on annotation changes
  useEffect(() => {
    if (!isApiMode || isSharedSession || submitted) return;
    if (!hasMountedRef.current) return;
    scheduleDraftSave();
  }, [annotations, codeAnnotations, globalAttachments, isApiMode, isSharedSession, submitted, scheduleDraftSave]);

  // Clear any pending save on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const restoreDraft = useCallback((): RestoredDraft => {
    const data = draftDataRef.current;
    setDraftBanner(null);
    draftDataRef.current = null;

    if (!data) return { annotations: [], codeAnnotations: [], globalAttachments: [], editedMarkdown: null, editedDocuments: [], savedFileChanges: [] };

    return data;
  }, []);

  const dismissDraft = useCallback(() => {
    setDraftBanner(null);
    draftDataRef.current = null;

    fetch('/api/draft', { method: 'DELETE' }).catch(() => {
      // Silent failure
    });
  }, []);

  return { draftBanner, restoreDraft, scheduleDraftSave, dismissDraft };
}
