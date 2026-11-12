import { useState, useEffect, useCallback, useRef } from 'react';
import type { SourceSaveCapability } from '@plannotator/core/source-save';
import type { Annotation, CodeAnnotation, ImageAttachment } from '../types';
import { fromShareable, parseShareableImages } from '../utils/sharing';
import type { ShareableAnnotation } from '../utils/sharing';

const DEBOUNCE_MS = 500;

/** Transport for persisting annotation/edit drafts. */
export interface DraftTransport {
  /**
   * GET the draft. `generation` is the store's reported generation when there is no draft (null
   * otherwise).
   */
  load(): Promise<{ data: unknown | null; generation: number | null }>;
  save(body: object, opts: { keepalive: boolean }): Promise<void | DraftSaveRefused>;
  remove(generation: number, opts: { keepalive: boolean }): Promise<void>;
}

/** A save the store refused as stale: the highest generation it knows. */
export interface DraftSaveRefused {
  staleGeneration: number;
}

/**
 * `save` rejects on failure (the keepalive retry stays in the hook so its generation-match gate
 * is preserved); `remove` always resolves.
 */
const defaultDraftTransport: DraftTransport = {
  async load() {
    const res = await fetch('/api/draft');
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const generation = readDraftGeneration(
        (data as MissingDraftData | null)?.draftGeneration,
      );
      return { data: null, generation };
    }
    return { data, generation: null };
  },
  save(body, { keepalive }) {
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    return fetch('/api/draft', { method: 'POST', headers, body: payload, keepalive }).then(
      async (res): Promise<void | DraftSaveRefused> => {
        if (res.status !== 409) return;
        const data = (await res.json().catch(() => null)) as (MissingDraftData & { decided?: boolean }) | null;
        // The review was decided: saving again would put back comments that
        // were just sent, so a decided refusal is never retried.
        if (data?.decided === true) return;
        const staleGeneration = readDraftGeneration(data?.draftGeneration);
        return staleGeneration !== null ? { staleGeneration } : undefined;
      },
    );
  },
  remove(generation, { keepalive }) {
    return fetch(`/api/draft?generation=${generation}`, { method: 'DELETE', keepalive }).then(
      () => {},
      () => {},
    );
  },
};

let draftTransport: DraftTransport = defaultDraftTransport;

/** Read the active draft transport at call time (so a late override is honored). */
export function getDraftTransport(): DraftTransport {
  return draftTransport;
}

export function setDraftTransport(t: DraftTransport): void {
  draftTransport = t;
}

export function resetDraftTransport(): void {
  draftTransport = defaultDraftTransport;
}

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

/** A linked document's saved comments, offered with the session draft. */
export interface DraftDocumentCopy {
  path: string;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
}

interface DraftData {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  editedMarkdown?: string;
  editedDocuments?: DraftEditedDocument[];
  savedFileChanges?: DraftSavedFileChange[];
  draftGeneration?: number;
  documents?: unknown;
  ts: number;
}

interface MissingDraftData {
  found?: false;
  draftGeneration?: number;
}

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

function parseDraftDocuments(value: unknown): DraftDocumentCopy[] {
  if (!Array.isArray(value)) return [];
  const documents: DraftDocumentCopy[] = [];
  for (const entry of value) {
    const doc = entry as Partial<DraftDocumentCopy> | null;
    if (!doc || typeof doc.path !== 'string' || doc.path.length === 0) continue;
    const annotations = Array.isArray(doc.annotations)
      ? doc.annotations.filter((a): a is Annotation => !!a && typeof a === 'object' && typeof (a as Annotation).id === 'string')
      : [];
    const globalAttachments = Array.isArray(doc.globalAttachments)
      ? doc.globalAttachments.filter((g): g is ImageAttachment => !!g && typeof g === 'object' && typeof (g as ImageAttachment).path === 'string')
      : [];
    if (annotations.length === 0 && globalAttachments.length === 0) continue;
    documents.push({ path: doc.path, annotations, globalAttachments });
  }
  return documents;
}

const countDraftDocuments = (documents: DraftDocumentCopy[]): number =>
  documents.reduce((total, doc) => total + doc.annotations.length + doc.globalAttachments.length, 0);

function readDraftGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
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
  getEditedMarkdown?: () => string | null;
  getEditedDocuments?: () => DraftEditedDocument[];
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
  documents: DraftDocumentCopy[];
}

export interface DraftBanner {
  count: number;
  timeAgo: string;
  hasEdits: boolean;
  documents?: number;
  documentComments?: number;
}

interface UseAnnotationDraftResult {
  draftBanner: DraftBanner | null;
  restoreDraft: () => RestoredDraft;
  scheduleDraftSave: () => void;
  scheduleDraftSaveAfterSubmitFailure: () => void;
  getDraftGeneration: () => number;
  dismissDraft: () => DraftDocumentCopy[];
  /**
   * For a session that ends WITHOUT a decision body (the agent closed it): the comment typed
   * just before must still reach the kept draft.
   */
  flushPendingSave: () => void;
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
  const [draftBanner, setDraftBanner] = useState<DraftBanner | null>(null);
  const draftDataRef = useRef<RestoredDraft | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const draftGenerationRef = useRef(0);

  const latestRef = useRef({ annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges });
  latestRef.current = { annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges };
  // The submitted gate is read in the effect but is deliberately not a trigger: a draft just deleted on submit
  // must not be recreated unless the user changes feedback again.
  const canPersist = isApiMode && !isSharedSession && !submitted;
  const canPersistRef = useRef(canPersist);
  canPersistRef.current = canPersist;

  useEffect(() => {
    if (!isApiMode || isSharedSession) return;

    getDraftTransport().load()
      .then(({ data, generation }) => {
        if (generation !== null) {
          draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        }
        return data as DraftData | LegacyDraftData | null;
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
          restoredAnnotations = data.a.length > 0 ? fromShareable(data.a, data.d) : [];
          restoredGlobal = data.g ? (parseShareableImages(data.g as Parameters<typeof parseShareableImages>[0]) ?? []) : [];
        } else if (Array.isArray(data.annotations)) {
          const generation = readDraftGeneration(data.draftGeneration);
          if (generation !== null) {
            draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
          }
          restoredAnnotations = data.annotations;
          restoredCodeAnnotations = Array.isArray(data.codeAnnotations) ? data.codeAnnotations : [];
          restoredGlobal = Array.isArray(data.globalAttachments) ? data.globalAttachments : [];
        } else if (Array.isArray((data as DraftData).codeAnnotations) && (data as DraftData).codeAnnotations!.length > 0) {
          const generation = readDraftGeneration((data as DraftData).draftGeneration);
          if (generation !== null) {
            draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
          }
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
        const restoredDocuments = !isLegacyDraft(data) ? parseDraftDocuments((data as DraftData).documents) : [];

        const totalCount =
          restoredAnnotations.length + restoredCodeAnnotations.length + restoredGlobal.length + countDraftDocuments(restoredDocuments);
        if (totalCount > 0 || restoredEdited !== null || restoredEditedDocuments.length > 0 || restoredSavedFileChanges.length > 0) {
          draftDataRef.current = {
            annotations: restoredAnnotations,
            codeAnnotations: restoredCodeAnnotations,
            globalAttachments: restoredGlobal,
            editedMarkdown: restoredEdited,
            editedDocuments: restoredEditedDocuments,
            savedFileChanges: restoredSavedFileChanges,
            documents: restoredDocuments,
          };
          setDraftBanner({
            count: totalCount,
            timeAgo: formatTimeAgo(data.ts || 0),
            hasEdits: restoredEdited !== null || restoredEditedDocuments.length > 0 || restoredSavedFileChanges.length > 0,
            ...(restoredDocuments.length > 0
              ? { documents: restoredDocuments.length, documentComments: countDraftDocuments(restoredDocuments) }
              : {}),
          });
        }
        hasMountedRef.current = true;
      })
      .catch(() => {
        hasMountedRef.current = true;
      });
  }, [isApiMode, isSharedSession]);

  const persistNow = useCallback((keepalive: boolean, retried = false) => {
    if (!canPersistRef.current) return;
    const { annotations, codeAnnotations, globalAttachments, getEditedMarkdown, getEditedDocuments, getSavedFileChanges } = latestRef.current;
    const editedMarkdown = getEditedMarkdown?.() ?? null;
    const editedDocuments = getEditedDocuments?.() ?? [];
    const savedFileChanges = getSavedFileChanges?.() ?? [];

    if (annotations.length === 0 && codeAnnotations.length === 0 && globalAttachments.length === 0 && editedMarkdown === null && editedDocuments.length === 0 && savedFileChanges.length === 0) {
      // A stale draft left on disk would offer back content the user explicitly threw away.
      const deletedGeneration = draftGenerationRef.current + 1;
      draftGenerationRef.current = deletedGeneration;
      getDraftTransport().remove(deletedGeneration, { keepalive }).catch(() => {});
      return;
    }

    const draftGeneration = draftGenerationRef.current + 1;
    draftGenerationRef.current = draftGeneration;
    const payload: DraftData = {
      annotations,
      codeAnnotations,
      globalAttachments,
      ...(editedMarkdown !== null ? { editedMarkdown } : {}),
      ...(editedDocuments.length > 0 ? { editedDocuments } : {}),
      ...(savedFileChanges.length > 0 ? { savedFileChanges } : {}),
      draftGeneration,
      ts: Date.now(),
    };

    // The transport moves the POST behind the seam; the keepalive retry-on-failure gate stays in
    // the hook verbatim so a host transport that resolves/rejects on failure still won't resurrect
    // a superseded save.
    const retryIfRefused = (result: void | DraftSaveRefused) => {
      if (!result || retried) return;
      if (!canPersistRef.current || draftGenerationRef.current !== draftGeneration) return;
      draftGenerationRef.current = Math.max(draftGenerationRef.current, result.staleGeneration);
      persistNowRef.current(false, true);
    };

    getDraftTransport().save(payload, { keepalive }).then(retryIfRefused, () => {
      // Chromium caps keepalive bodies (~64KB); retry without it. Completes
      // fine when the page was only backgrounded, best-effort on close.
      if (keepalive && canPersistRef.current && draftGenerationRef.current === draftGeneration) {
        getDraftTransport().save(payload, { keepalive: false }).then(retryIfRefused, () => {});
      }
      // Otherwise silent failure — draft is best-effort.
    });
  }, []);
  const persistNowRef = useRef(persistNow);
  persistNowRef.current = persistNow;

  const scheduleDraftSave = useCallback(() => {
    if (!canPersistRef.current || !hasMountedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persistNow(false);
    }, DEBOUNCE_MS);
  }, [persistNow]);

  const scheduleDraftSaveAfterSubmitFailure = useCallback(() => {
    setTimeout(() => {
      scheduleDraftSave();
    }, 0);
  }, [scheduleDraftSave]);

  const getDraftGeneration = useCallback(() => draftGenerationRef.current + 1, []);

  const flushPendingSave = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    persistNow(false);
  }, [persistNow]);

  // Flush a pending save when the page is backgrounded or closed — otherwise the last debounce
  // window of typing is lost on tab close, and reopening the (still-running) session would restore
  // a draft missing those keystrokes.
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

  useEffect(() => {
    if (!isApiMode || isSharedSession || submitted) return;
    if (!hasMountedRef.current) return;
    scheduleDraftSave();
  }, [annotations, codeAnnotations, globalAttachments, isApiMode, isSharedSession, scheduleDraftSave]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const restoreDraft = useCallback((): RestoredDraft => {
    const data = draftDataRef.current;
    setDraftBanner(null);
    draftDataRef.current = null;

    if (!data) return { annotations: [], codeAnnotations: [], globalAttachments: [], editedMarkdown: null, editedDocuments: [], savedFileChanges: [], documents: [] };

    return data;
  }, []);

  const dismissDraft = useCallback((): DraftDocumentCopy[] => {
    const offeredDocuments = draftDataRef.current?.documents ?? [];
    const deletedGeneration = draftGenerationRef.current + 1;
    draftGenerationRef.current = deletedGeneration;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDraftBanner(null);
    draftDataRef.current = null;

    getDraftTransport().remove(deletedGeneration, { keepalive: false }).catch(() => {});
    return offeredDocuments;
  }, []);

  return { draftBanner, restoreDraft, scheduleDraftSave, scheduleDraftSaveAfterSubmitFailure, getDraftGeneration, dismissDraft, flushPendingSave };
}
