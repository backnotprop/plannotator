import { useState, useEffect, useCallback, useRef } from 'react';
import type { CodeAnnotation, Annotation, CommentAnnotation } from '../types';
import { getDraftTransport, type DraftTransport } from './useAnnotationDraft';

const DEBOUNCE_MS = 500;
export const TARGET_LOAD_TIMEOUT_MS = 5000;

export class DraftTargetChangedError extends Error {
  constructor() { super('Review draft target changed'); }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('draft load timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

interface DraftData {
  codeAnnotations: CodeAnnotation[];
  descriptionAnnotations?: Annotation[];
  commentAnnotations?: CommentAnnotation[];
  viewedFiles?: string[];
  autoViewSuppressed?: string[];
  draftGeneration?: number;
  patchChanged?: boolean;
  ts: number;
}

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

interface UseCodeAnnotationDraftOptions {
  transport?: DraftTransport;
  annotations: CodeAnnotation[];
  descriptionAnnotations?: Annotation[];
  commentAnnotations?: CommentAnnotation[];
  viewedFiles: Set<string>;
  autoViewSuppressed?: Set<string>;
  isApiMode: boolean;
  submitted: boolean;
  persistViewedFiles?: boolean;
  onDraftTargetMerge?: (items: CodeDraftMergeItems) => void;
  targetLoadTimeoutMs?: number;
}

export interface CodeDraftMergeItems {
  annotations: CodeAnnotation[];
  descriptionAnnotations: Annotation[];
  commentAnnotations: CommentAnnotation[];
  patchChanged: boolean;
}

export interface CodeDraftTargetState {
  found: boolean;
  draftGeneration: number | null;
}

interface UseCodeAnnotationDraftResult {
  flushBeforeSwitch: () => Promise<void>;
  draftTargetChanged: boolean;
  draftBanner: { count: number; viewedCount: number; timeAgo: string } | null;
  restoreDraft: () => { annotations: CodeAnnotation[]; descriptionAnnotations: Annotation[]; commentAnnotations: CommentAnnotation[]; viewedFiles: string[]; autoViewSuppressed: string[]; patchChanged: boolean };
  getDraftGeneration: () => number;
  dismissDraft: () => void;
  adoptDraftTarget: (state: CodeDraftTargetState | undefined, transport?: DraftTransport) => void;
}

export function useCodeAnnotationDraft({
  transport: transportOverride,
  annotations,
  descriptionAnnotations = [],
  commentAnnotations = [],
  viewedFiles,
  autoViewSuppressed,
  isApiMode,
  submitted,
  onDraftTargetMerge,
  targetLoadTimeoutMs = TARGET_LOAD_TIMEOUT_MS,
  persistViewedFiles = true,
}: UseCodeAnnotationDraftOptions): UseCodeAnnotationDraftResult {
  const transport = transportOverride ?? getDraftTransport();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  const switchPausedRef = useRef(false);
  const [draftTargetChanged, setDraftTargetChanged] = useState(false);
  const targetChangedRef = useRef(false);
  const [draftBanner, setDraftBanner] = useState<{ count: number; viewedCount: number; timeAgo: string } | null>(null);
  const draftDataRef = useRef<DraftData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const draftGenerationRef = useRef(0);
  const persistViewedRef = useRef(persistViewedFiles);
  persistViewedRef.current = persistViewedFiles;
  const hasHadAnnotationsRef = useRef(false);
  const switchSeqRef = useRef(0);
  const reportTargetChanged = (error: unknown, seq: number): boolean => {
    if (!(error instanceof DraftTargetChangedError)) return false;
    if (seq === switchSeqRef.current) {
      targetChangedRef.current = true;
      setDraftTargetChanged(true);
    }
    return true;
  };
  const awaitingTargetLoadRef = useRef(false);
  const skippedWhileAwaitingRef = useRef(false);
  const targetUnreadableRef = useRef(false);
  const retryTargetLoadRef = useRef<(() => void) | null>(null);
  const [saveNudge, setSaveNudge] = useState(0);
  const loadTimeoutRef = useRef(targetLoadTimeoutMs);
  loadTimeoutRef.current = targetLoadTimeoutMs;
  const onMergeRef = useRef(onDraftTargetMerge);
  onMergeRef.current = onDraftTargetMerge;
  const latestRef = useRef({ annotations, descriptionAnnotations, commentAnnotations });
  latestRef.current = { annotations, descriptionAnnotations, commentAnnotations };
  const removedIdsRef = useRef(new Set<string>());
  const seenIdsRef = useRef(new Set<string>());
  {
    const nowIds = new Set<string>([
      ...annotations.map((a) => a.id),
      ...descriptionAnnotations.map((a) => a.id),
      ...commentAnnotations.map((a) => a.id),
    ]);
    for (const id of seenIdsRef.current) if (!nowIds.has(id)) removedIdsRef.current.add(id);
    for (const id of nowIds) removedIdsRef.current.delete(id);
    seenIdsRef.current = nowIds;
  }

  useEffect(() => {
    if (!isApiMode) return;
    const seq = switchSeqRef.current;
    let cancelled = false;

    transportRef.current.load()
      .then(({ data, generation }) => {
        if (cancelled || seq !== switchSeqRef.current) return null;
        if (generation !== null) {
          draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        }
        return data as DraftData | null;
      })
      .then((data: DraftData | null) => {
        if (cancelled || seq !== switchSeqRef.current) return;
        draftDataRef.current = data;
        const generation = readDraftGeneration(data?.draftGeneration);
        if (generation !== null) {
          draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        }
        const annotationCount = (Array.isArray(data?.codeAnnotations) ? data.codeAnnotations.length : 0)
          + (Array.isArray(data?.descriptionAnnotations) ? data.descriptionAnnotations.length : 0)
          + (Array.isArray(data?.commentAnnotations) ? data.commentAnnotations.length : 0);
        const viewedCount = persistViewedRef.current && Array.isArray(data?.viewedFiles) ? data.viewedFiles.length : 0;
        if (annotationCount > 0 || viewedCount > 0) {
          draftDataRef.current = data;
          setDraftBanner({
            count: annotationCount,
            viewedCount,
            timeAgo: formatTimeAgo(data?.ts || 0),
          });
        }
        hasMountedRef.current = true;
      })
      .catch((error) => {
        if (!cancelled && seq === switchSeqRef.current) {
          reportTargetChanged(error, seq);
          hasMountedRef.current = true;
        }
      });
    return () => { cancelled = true; };
  }, [isApiMode]);

  useEffect(() => {
    const data = draftDataRef.current;
    if (!data) return;
    const count = (data.codeAnnotations?.length ?? 0)
      + (data.descriptionAnnotations?.length ?? 0) + (data.commentAnnotations?.length ?? 0);
    const viewedCount = persistViewedFiles ? data.viewedFiles?.length ?? 0 : 0;
    setDraftBanner(count || viewedCount ? { count, viewedCount, timeAgo: formatTimeAgo(data.ts || 0) } : null);
  }, [persistViewedFiles]);

  useEffect(() => {
    if (!isApiMode || submitted) return;
    if (!hasMountedRef.current) return;

    if (annotations.some((a) => !a.source) || descriptionAnnotations.length > 0 || commentAnnotations.length > 0) hasHadAnnotationsRef.current = true;

    const isEmpty = annotations.length === 0 && descriptionAnnotations.length === 0 && commentAnnotations.length === 0 && (!persistViewedFiles || viewedFiles.size === 0);
    if (isEmpty && !hasHadAnnotationsRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    const seq = switchSeqRef.current;
    const persist = async () => {
      if (targetChangedRef.current) return;
      if (awaitingTargetLoadRef.current) {
        skippedWhileAwaitingRef.current = true;
        return;
      }
      if (targetUnreadableRef.current) {
        skippedWhileAwaitingRef.current = true;
        retryTargetLoadRef.current?.();
        return;
      }
      const draftGeneration = draftGenerationRef.current + 1;
      draftGenerationRef.current = draftGeneration;

      if (isEmpty) {
        await transport.remove(draftGeneration, { keepalive: false });
        return;
      }

      const payload: DraftData = {
        codeAnnotations: annotations,
        descriptionAnnotations,
        commentAnnotations,
        ...(persistViewedFiles ? { viewedFiles: [...viewedFiles] } : {}),
        ...(persistViewedFiles && autoViewSuppressed && autoViewSuppressed.size > 0
          ? { autoViewSuppressed: [...autoViewSuppressed] }
          : {}),
        draftGeneration,
        ts: Date.now(),
      };

      await transport.save(payload, { keepalive: false });
    };
    const save = async () => {
      try { await persist(); } catch (error) {
        reportTargetChanged(error, seq);
        throw error;
      }
    };
    pendingSaveRef.current = save;
    timerRef.current = setTimeout(() => {
      if (switchPausedRef.current) return;
      pendingSaveRef.current = null;
      savingRef.current = save();
      savingRef.current.catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingSaveRef.current = null;
    };
  }, [annotations, descriptionAnnotations, commentAnnotations, viewedFiles, autoViewSuppressed, isApiMode, submitted, saveNudge, persistViewedFiles, transport]);

  const flushBeforeSwitch = useCallback(async () => {
    switchPausedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await savingRef.current?.catch(() => {});
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) await pending().catch(() => {});
    } finally {
      savingRef.current = null;
    }
  }, []);

  const restoreDraft = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingSaveRef.current = null;
    const data = draftDataRef.current;
    setDraftBanner(null);
    draftDataRef.current = null;
    return {
      annotations: data?.codeAnnotations ?? [],
      descriptionAnnotations: data?.descriptionAnnotations ?? [],
      commentAnnotations: data?.commentAnnotations ?? [],
      patchChanged: data?.patchChanged === true,
      viewedFiles: persistViewedRef.current ? data?.viewedFiles ?? [] : [],
      autoViewSuppressed: persistViewedRef.current ? data?.autoViewSuppressed ?? [] : [],
    };
  }, []);

  const getDraftGeneration = useCallback(() => draftGenerationRef.current + 1, []);

  const dismissDraft = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingSaveRef.current = null;
    const deletedGeneration = draftGenerationRef.current + 1;
    draftGenerationRef.current = deletedGeneration;
    setDraftBanner(null);
    draftDataRef.current = null;
    const seq = switchSeqRef.current;
    transportRef.current.remove(deletedGeneration, { keepalive: false }).catch(error => {
      reportTargetChanged(error, seq);
    });
  }, []);

  useEffect(() => () => { switchSeqRef.current += 1; }, []);

  const adoptDraftTarget = useCallback((state: CodeDraftTargetState | undefined, nextTransport?: DraftTransport) => {
    if (!isApiMode) return;
    if (state) {
      targetChangedRef.current = false;
      setDraftTargetChanged(false);
    }
    if (switchPausedRef.current) {
      switchPausedRef.current = false;
      setSaveNudge(n => n + 1);
    }
    if (!state) return;
    hasMountedRef.current = true;
    const targetTransport = nextTransport ?? transportRef.current;
    const seq = ++switchSeqRef.current;
    const resumeHeldWrite = () => {
      if (skippedWhileAwaitingRef.current) {
        skippedWhileAwaitingRef.current = false;
        setSaveNudge((n) => n + 1);
      }
    };
    awaitingTargetLoadRef.current = false;
    targetUnreadableRef.current = false;
    retryTargetLoadRef.current = null;
    const floor = readDraftGeneration(state.draftGeneration);
    if (floor !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, floor);
    if (!state.found) { resumeHeldWrite(); return; }

    const applyDraft = (data: unknown, generation: number | null) => {
      if (generation !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
      const draft = data as DraftData | null;
      if (!draft) return;
      const loadedGeneration = readDraftGeneration(draft.draftGeneration);
      if (loadedGeneration !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, loadedGeneration);
      const current = latestRef.current;
      const skip = new Set<string>([
        ...current.annotations.map((a) => a.id),
        ...current.descriptionAnnotations.map((a) => a.id),
        ...current.commentAnnotations.map((a) => a.id),
        ...removedIdsRef.current,
      ]);
      const fresh = <T extends { id: string }>(items: T[] | undefined) =>
        (Array.isArray(items) ? items : []).filter((item) => !skip.has(item.id));
      const items: CodeDraftMergeItems = {
        annotations: fresh(draft.codeAnnotations),
        descriptionAnnotations: fresh(draft.descriptionAnnotations),
        commentAnnotations: fresh(draft.commentAnnotations),
        patchChanged: draft.patchChanged === true,
      };
      if (items.annotations.length + items.descriptionAnnotations.length + items.commentAnnotations.length > 0) {
        onMergeRef.current?.(items);
      }
    };

    const read = () => {
      if (switchSeqRef.current !== seq || awaitingTargetLoadRef.current) return;
      awaitingTargetLoadRef.current = true;
      const attempt = (remaining: number): void => {
        if (switchSeqRef.current !== seq) return;
        withTimeout(targetTransport.load(), loadTimeoutRef.current)
          .then(({ data, generation }) => {
            if (switchSeqRef.current !== seq) return;
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
              skippedWhileAwaitingRef.current = true;
            }
            applyDraft(data, generation);
            awaitingTargetLoadRef.current = false;
            targetUnreadableRef.current = false;
            resumeHeldWrite();
          })
          .catch((error) => {
            if (switchSeqRef.current !== seq) return;
            if (reportTargetChanged(error, seq)) {
              awaitingTargetLoadRef.current = false;
              return;
            }
            if (remaining > 0) { attempt(remaining - 1); return; }
            awaitingTargetLoadRef.current = false;
            targetUnreadableRef.current = true;
          });
      };
      attempt(1);
    };
    retryTargetLoadRef.current = read;
    read();
  }, [isApiMode]);

  return { draftBanner, draftTargetChanged, restoreDraft, getDraftGeneration, dismissDraft, adoptDraftTarget, flushBeforeSwitch };
}
