/**
 * Auto-save code review annotation drafts to the server.
 *
 * Similar to useAnnotationDraft but stores CodeAnnotation[] directly
 * (they're already compact — no tuple conversion needed).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CodeAnnotation, Annotation, CommentAnnotation } from '../types';
import { getDraftTransport } from './useAnnotationDraft';

const DEBOUNCE_MS = 500;

interface DraftData {
  codeAnnotations: CodeAnnotation[];
  descriptionAnnotations?: Annotation[];
  commentAnnotations?: CommentAnnotation[];
  viewedFiles?: string[];
  /**
   * Files the reviewer manually un-viewed, which auto-mark-viewed must never
   * re-check (the "come back to this" contract). Additive and optional: a
   * draft written before this field restores fine, and a draft carrying it is
   * ignored gracefully by an older build.
   *
   * Deliberately absent from `isEmpty` and from the engagement signal — a
   * session whose only state is suppression is still an empty draft and is
   * still cleared, keeping #948's clear-everything semantics untouched.
   */
  autoViewSuppressed?: string[];
  draftGeneration?: number;
  /**
   * Set by the review server (never by the client) when a PR draft is served
   * through the PR's target key for a patch different from the one it was
   * saved on (#1590). The host re-checks line comments' anchors on restore.
   */
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
  annotations: CodeAnnotation[];
  descriptionAnnotations?: Annotation[];
  commentAnnotations?: CommentAnnotation[];
  viewedFiles: Set<string>;
  autoViewSuppressed?: Set<string>;
  isApiMode: boolean;
  submitted: boolean;
  /** Receives the unsent items found on a target the session switched onto
   *  in place (#1590), already filtered to ids the session neither holds nor
   *  deleted. The host adds them to its state; autosave then saves the merge.
   *  Called synchronously before autosave resumes. */
  onDraftTargetMerge?: (items: CodeDraftMergeItems) => void;
}

/** Items auto-merged from a switched-onto target's draft. */
export interface CodeDraftMergeItems {
  annotations: CodeAnnotation[];
  descriptionAnnotations: Annotation[];
  commentAnnotations: CommentAnnotation[];
  /** The server served the draft for a patch other than it was saved on. */
  patchChanged: boolean;
}

/** Draft state a review server reports after an in-place target switch
 *  (PR switch / PR diff-scope switch, #1590). */
export interface CodeDraftTargetState {
  found: boolean;
  draftGeneration: number | null;
}

interface UseCodeAnnotationDraftResult {
  draftBanner: { count: number; viewedCount: number; timeAgo: string } | null;
  /** `patchChanged` is true when the server served the draft for a patch other
   *  than the one it was saved on (the host re-checks line anchors). */
  restoreDraft: () => { annotations: CodeAnnotation[]; descriptionAnnotations: Annotation[]; commentAnnotations: CommentAnnotation[]; viewedFiles: string[]; autoViewSuppressed: string[]; patchChanged: boolean };
  getDraftGeneration: () => number;
  dismissDraft: () => void;
  /** Call with the server's `draftState` after an in-place target switch.
   *  Raises the generation counter to the new target's floor (so saves are
   *  not rejected against an old tombstone there) and, when that target holds
   *  a draft, loads it and hands its new items to `onDraftTargetMerge`. Until
   *  that one load settles (success, failure, or a newer switch) autosave does
   *  not write under the new target, so the switch cannot overwrite a draft
   *  it has not read yet; nothing else ever waits. */
  adoptDraftTarget: (state: CodeDraftTargetState | undefined) => void;
}

export function useCodeAnnotationDraft({
  annotations,
  descriptionAnnotations = [],
  commentAnnotations = [],
  viewedFiles,
  autoViewSuppressed,
  isApiMode,
  submitted,
  onDraftTargetMerge,
}: UseCodeAnnotationDraftOptions): UseCodeAnnotationDraftResult {
  const [draftBanner, setDraftBanner] = useState<{ count: number; viewedCount: number; timeAgo: string } | null>(null);
  const draftDataRef = useRef<DraftData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const draftGenerationRef = useRef(0);
  // True once the user has actually had annotations this session. Used to decide
  // whether an empty state is a real "cleared everything" edit (persist it) vs a
  // fresh/unengaged session (leave the server alone). Keyed on annotations only —
  // see the autosave effect for why viewedFiles must not count.
  const hasHadAnnotationsRef = useRef(false);
  // In-place switch bookkeeping (#1590). Every adoptDraftTarget call starts a
  // new switch id; a load that resolves for an older id is ignored. While the
  // current switch's draft load is in flight, autosave skips writing (it
  // would overwrite a draft it has not merged yet) and remembers that it did,
  // so settling — success, failure, or supersede — always resumes saving.
  const switchSeqRef = useRef(0);
  const awaitingTargetLoadRef = useRef(false);
  const skippedWhileAwaitingRef = useRef(false);
  const [saveNudge, setSaveNudge] = useState(0);
  const onMergeRef = useRef(onDraftTargetMerge);
  onMergeRef.current = onDraftTargetMerge;
  const latestRef = useRef({ annotations, descriptionAnnotations, commentAnnotations });
  latestRef.current = { annotations, descriptionAnnotations, commentAnnotations };
  // Ids the reviewer removed during this session, so a later merge offer
  // (switching back onto a target saved before the removal) never brings a
  // deleted comment back. Re-adding an id (undo) clears it again.
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

  // Load draft on mount
  useEffect(() => {
    if (!isApiMode) return;

    getDraftTransport().load()
      .then(({ data, generation }) => {
        if (generation !== null) {
          draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        }
        return data as DraftData | null;
      })
      .then((data: DraftData | null) => {
        const generation = readDraftGeneration(data?.draftGeneration);
        if (generation !== null) {
          draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        }
        const annotationCount = (Array.isArray(data?.codeAnnotations) ? data.codeAnnotations.length : 0)
          + (Array.isArray(data?.descriptionAnnotations) ? data.descriptionAnnotations.length : 0)
          + (Array.isArray(data?.commentAnnotations) ? data.commentAnnotations.length : 0);
        const viewedCount = Array.isArray(data?.viewedFiles) ? data.viewedFiles.length : 0;
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
      .catch(() => {
        hasMountedRef.current = true;
      });
  }, [isApiMode]);

  // Debounced auto-save on annotation/viewed changes
  useEffect(() => {
    if (!isApiMode || submitted) return;
    if (!hasMountedRef.current) return;

    // Track engagement on USER-AUTHORED annotations only. Two things that arrive
    // without user action must NOT count as "had content", or a later empty state
    // would look like the user deleted everything and wrongly delete the draft:
    //   - viewedFiles are seeded from GitHub's already-viewed state on mount
    //     (review App.tsx) before the user does anything.
    //   - external/SSE annotations (source-tagged, e.g. an eslint plugin) arrive
    //     via `allAnnotations` and have their own lifecycle, separate from the draft.
    if (annotations.some((a) => !a.source) || descriptionAnnotations.length > 0 || commentAnnotations.length > 0) hasHadAnnotationsRef.current = true;

    const isEmpty = annotations.length === 0 && descriptionAnnotations.length === 0 && commentAnnotations.length === 0 && viewedFiles.size === 0;
    // Leave the server alone for an empty state until the user has actually had
    // annotations this session. This preserves an unrestored draft sitting on disk
    // at mount (the draft-recovery banner can still offer it).
    if (isEmpty && !hasHadAnnotationsRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      // The switched-onto target's draft is still loading: writing now would
      // overwrite it unread. Settling the load re-runs this effect.
      if (awaitingTargetLoadRef.current) {
        skippedWhileAwaitingRef.current = true;
        return;
      }
      const draftGeneration = draftGenerationRef.current + 1;
      draftGenerationRef.current = draftGeneration;

      if (isEmpty) {
        // The user cleared everything (#948). Delete the draft with a generation
        // tombstone so it can't resurface on refresh and a late save can't revive
        // it. Mirrors useAnnotationDraft.persistNow — routed through the draft
        // transport seam so a host backend tombstones its own stored draft too.
        getDraftTransport().remove(draftGeneration, { keepalive: false }).catch(() => {});
        return;
      }

      const payload: DraftData = {
        codeAnnotations: annotations,
        descriptionAnnotations,
        commentAnnotations,
        viewedFiles: [...viewedFiles],
        ...(autoViewSuppressed && autoViewSuppressed.size > 0
          ? { autoViewSuppressed: [...autoViewSuppressed] }
          : {}),
        draftGeneration,
        ts: Date.now(),
      };

      getDraftTransport().save(payload, { keepalive: false }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [annotations, descriptionAnnotations, commentAnnotations, viewedFiles, autoViewSuppressed, isApiMode, submitted, saveNudge]);

  const restoreDraft = useCallback(() => {
    // Cancel any pending autosave so it can't fire with pre-restore state and
    // overwrite what we're about to restore.
    if (timerRef.current) clearTimeout(timerRef.current);
    const data = draftDataRef.current;
    setDraftBanner(null);
    draftDataRef.current = null;
    return {
      annotations: data?.codeAnnotations ?? [],
      descriptionAnnotations: data?.descriptionAnnotations ?? [],
      commentAnnotations: data?.commentAnnotations ?? [],
      viewedFiles: data?.viewedFiles ?? [],
      autoViewSuppressed: data?.autoViewSuppressed ?? [],
      patchChanged: data?.patchChanged === true,
    };
  }, []);

  const getDraftGeneration = useCallback(() => draftGenerationRef.current + 1, []);

  const dismissDraft = useCallback(() => {
    // Cancel any pending autosave so a late save can't revive the draft the user
    // just dismissed.
    if (timerRef.current) clearTimeout(timerRef.current);
    const deletedGeneration = draftGenerationRef.current + 1;
    draftGenerationRef.current = deletedGeneration;
    setDraftBanner(null);
    draftDataRef.current = null;
    getDraftTransport().remove(deletedGeneration, { keepalive: false }).catch(() => {});
  }, []);

  const adoptDraftTarget = useCallback((state: CodeDraftTargetState | undefined) => {
    if (!isApiMode) return;
    // Every switch starts clean: a previous switch's load (if still in
    // flight) is superseded, and any write it held back resumes below.
    const seq = ++switchSeqRef.current;
    const settle = () => {
      if (switchSeqRef.current !== seq || !awaitingTargetLoadRef.current) return;
      awaitingTargetLoadRef.current = false;
      if (skippedWhileAwaitingRef.current) {
        skippedWhileAwaitingRef.current = false;
        setSaveNudge((n) => n + 1);
      }
    };
    const wasAwaiting = awaitingTargetLoadRef.current;
    awaitingTargetLoadRef.current = false;
    if (!state) {
      if (wasAwaiting && skippedWhileAwaitingRef.current) {
        skippedWhileAwaitingRef.current = false;
        setSaveNudge((n) => n + 1);
      }
      return;
    }
    const floor = readDraftGeneration(state.draftGeneration);
    if (floor !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, floor);
    if (!state.found) {
      if (wasAwaiting && skippedWhileAwaitingRef.current) {
        skippedWhileAwaitingRef.current = false;
        setSaveNudge((n) => n + 1);
      }
      return;
    }
    awaitingTargetLoadRef.current = true;
    getDraftTransport().load()
      .then(({ data, generation }) => {
        if (switchSeqRef.current !== seq) return; // a newer switch owns the keys now
        if (generation !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, generation);
        const draft = data as DraftData | null;
        if (draft) {
          const loadedGeneration = readDraftGeneration(draft.draftGeneration);
          if (loadedGeneration !== null) draftGenerationRef.current = Math.max(draftGenerationRef.current, loadedGeneration);
          // Only what the session neither holds nor deleted: the target may
          // carry this session's own blob from before a switch away and back.
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
        }
        settle();
      })
      .catch(() => {
        if (switchSeqRef.current !== seq) return;
        settle();
      });
  }, [isApiMode]);

  return { draftBanner, restoreDraft, getDraftGeneration, dismissDraft, adoptDraftTarget };
}
