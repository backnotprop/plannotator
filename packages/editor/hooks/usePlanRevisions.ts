/**
 * Revised plans pushed into an open plan review.
 *
 * A host whose plan review does not block the agent (Pi) keeps the review
 * server open while the agent revises the plan, and pushes each revision
 * into the server. The server advertises this by sending `planRevision` on
 * `/api/plan`; this hook then polls `/api/plan/revision` and, when a newer
 * revision exists, loads `/api/plan` and hands it to `onApply`. Servers that
 * never revise send no `planRevision` and the hook does nothing.
 *
 * A revision is held back while applying it would lose the reviewer's work
 * or yank the view: while the source editor is open or holds unsent direct
 * edits (those are a diff against the version on screen), and while a linked
 * document or archived plan is open (the root plan is stashed). It loads as
 * soon as that clears.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';

export interface PlanRevisionSnapshot {
  plan: string;
  previousPlan: string | null;
  versionInfo: VersionInfo | null;
  planRevision: number;
}

export type PlanRevisionBlocker = 'edits' | 'linked-document' | null;

/** Why a pending revision cannot load right now, or null when it can. */
export function planRevisionBlocker(state: {
  isEditing: boolean;
  hasDirectEdits: boolean;
  linkedDocActive: boolean;
}): PlanRevisionBlocker {
  if (state.isEditing || state.hasDirectEdits) return 'edits';
  if (state.linkedDocActive) return 'linked-document';
  return null;
}

export const PLAN_REVISION_POLL_MS = 2000;

export interface UsePlanRevisionsOptions {
  /** `planRevision` from the initial `/api/plan`; null when the server never revises. */
  initialRevision: number | null;
  /** False once the reviewer decided: stop polling. */
  active: boolean;
  blocker: PlanRevisionBlocker;
  onApply: (snapshot: PlanRevisionSnapshot) => void;
  /** Called once per revision that is waiting on `blocker`. */
  onBlocked?: (revision: number, blocker: Exclude<PlanRevisionBlocker, null>) => void;
  intervalMs?: number;
}

export interface UsePlanRevisionsResult {
  /** The revision on screen, to echo on approve/deny; null when unsupported. */
  currentRevision: () => number | null;
  /** Check now (e.g. after the server refused a decision as stale). */
  refreshNow: () => void;
}

export function usePlanRevisions(options: UsePlanRevisionsOptions): UsePlanRevisionsResult {
  const { initialRevision, active, blocker, intervalMs = PLAN_REVISION_POLL_MS } = options;
  const appliedRef = useRef<number | null>(initialRevision);
  const latestRef = useRef<number | null>(initialRevision);
  const blockedNoticeRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const onApplyRef = useRef(options.onApply);
  onApplyRef.current = options.onApply;
  const onBlockedRef = useRef(options.onBlocked);
  onBlockedRef.current = options.onBlocked;

  // The initial payload arrives after mount.
  useEffect(() => {
    if (initialRevision === null) return;
    if (appliedRef.current === null || initialRevision > appliedRef.current) appliedRef.current = initialRevision;
    if (latestRef.current === null || initialRevision > latestRef.current) latestRef.current = initialRevision;
  }, [initialRevision]);

  const tryApply = useCallback(async () => {
    const applied = appliedRef.current;
    const latest = latestRef.current;
    if (applied === null || latest === null || latest <= applied || loadingRef.current) return;
    const currentBlocker = blockerRef.current;
    if (currentBlocker) {
      if (blockedNoticeRef.current !== latest) {
        blockedNoticeRef.current = latest;
        onBlockedRef.current?.(latest, currentBlocker);
      }
      return;
    }
    loadingRef.current = true;
    try {
      const res = await fetch('/api/plan');
      if (!res.ok) return;
      const data = (await res.json()) as Partial<PlanRevisionSnapshot>;
      if (typeof data.plan !== 'string' || typeof data.planRevision !== 'number') return;
      // Re-check: the reviewer may have started editing while this loaded.
      if (blockerRef.current) return;
      const current = appliedRef.current;
      if (current !== null && data.planRevision <= current) return;
      appliedRef.current = data.planRevision;
      if (latestRef.current === null || data.planRevision > latestRef.current) latestRef.current = data.planRevision;
      onApplyRef.current({
        plan: data.plan,
        previousPlan: data.previousPlan ?? null,
        versionInfo: data.versionInfo ?? null,
        planRevision: data.planRevision,
      });
    } catch {
      // The next poll retries.
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const check = useCallback(async () => {
    if (appliedRef.current === null) return;
    try {
      const res = await fetch('/api/plan/revision');
      if (!res.ok) return;
      const data = (await res.json()) as { revision?: unknown };
      if (typeof data.revision === 'number' && (latestRef.current === null || data.revision > latestRef.current)) {
        latestRef.current = data.revision;
      }
    } catch {
      return;
    }
    await tryApply();
  }, [tryApply]);

  useEffect(() => {
    if (initialRevision === null || !active) return;
    const timer = setInterval(() => {
      void check();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [initialRevision, active, intervalMs, check]);

  // A held-back revision loads as soon as its blocker clears.
  useEffect(() => {
    if (!active || blocker) return;
    void tryApply();
  }, [active, blocker, tryApply]);

  return {
    currentRevision: useCallback(() => appliedRef.current, []),
    refreshNow: useCallback(() => {
      void check();
    }, [check]),
  };
}
