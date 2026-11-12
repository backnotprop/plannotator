import { useCallback, useEffect, useRef } from 'react';
import type { VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';

export interface PlanRevisionSnapshot {
  plan: string;
  previousPlan: string | null;
  versionInfo: VersionInfo | null;
  planRevision: number;
  planPath?: string | null;
  planFilePath?: string | null;
}

export type PlanRevisionBlocker = 'edits' | 'linked-document' | 'composer' | null;

export const PLAN_REVISION_COMPOSER_SELECTOR =
  '[data-comment-popover="true"], .annotation-toolbar, [data-diagram-composer], [data-decision-note-input], [data-decision-note-composer]';

export function isPlanRevisionComposerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(PLAN_REVISION_COMPOSER_SELECTOR) !== null;
}

export const PLAN_REVISION_COMPOSER_RETRY_MS = 400;

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
  initialRevision: number | null;
  active: boolean;
  blocker: PlanRevisionBlocker;
  onApply: (snapshot: PlanRevisionSnapshot) => void;
  onBlocked?: (revision: number, blocker: Exclude<PlanRevisionBlocker, null>) => void;
  isComposerOpen?: () => boolean;
  intervalMs?: number;
}

export interface UsePlanRevisionsResult {
  currentRevision: () => number | null;
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
  const isComposerOpenRef = useRef(options.isComposerOpen ?? isPlanRevisionComposerOpen);
  isComposerOpenRef.current = options.isComposerOpen ?? isPlanRevisionComposerOpen;
  const activeRef = useRef(active);
  activeRef.current = active;
  const composerRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentBlocker = (): PlanRevisionBlocker =>
    blockerRef.current ?? (isComposerOpenRef.current() ? 'composer' : null);

  useEffect(() => {
    if (initialRevision === null) return;
    if (appliedRef.current === null || initialRevision > appliedRef.current) appliedRef.current = initialRevision;
    if (latestRef.current === null || initialRevision > latestRef.current) latestRef.current = initialRevision;
  }, [initialRevision]);

  const tryApply = useCallback(async () => {
    const applied = appliedRef.current;
    const latest = latestRef.current;
    if (applied === null || latest === null || latest <= applied || loadingRef.current) return;
    const blockedBy = currentBlocker();
    if (blockedBy) {
      if (blockedNoticeRef.current !== latest) {
        blockedNoticeRef.current = latest;
        onBlockedRef.current?.(latest, blockedBy);
      }
      if (blockedBy === 'composer' && composerRetryRef.current === null) {
        composerRetryRef.current = setTimeout(() => {
          composerRetryRef.current = null;
          if (activeRef.current) void tryApplyRef.current();
        }, PLAN_REVISION_COMPOSER_RETRY_MS);
      }
      return;
    }
    loadingRef.current = true;
    try {
      const res = await fetch('/api/plan');
      if (!res.ok) return;
      const data = (await res.json()) as Partial<PlanRevisionSnapshot>;
      if (typeof data.plan !== 'string' || typeof data.planRevision !== 'number') return;
      if (currentBlocker()) {
        if (isComposerOpenRef.current() && composerRetryRef.current === null) {
          composerRetryRef.current = setTimeout(() => {
            composerRetryRef.current = null;
            if (activeRef.current) void tryApplyRef.current();
          }, PLAN_REVISION_COMPOSER_RETRY_MS);
        }
        return;
      }
      const current = appliedRef.current;
      if (current !== null && data.planRevision <= current) return;
      appliedRef.current = data.planRevision;
      if (latestRef.current === null || data.planRevision > latestRef.current) latestRef.current = data.planRevision;
      onApplyRef.current({
        plan: data.plan,
        previousPlan: data.previousPlan ?? null,
        versionInfo: data.versionInfo ?? null,
        planRevision: data.planRevision,
        planPath: typeof data.planPath === 'string' ? data.planPath : null,
        planFilePath: typeof data.planFilePath === 'string' ? data.planFilePath : null,
      });
    } catch {
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const tryApplyRef = useRef(tryApply);
  tryApplyRef.current = tryApply;
  useEffect(() => () => {
    if (composerRetryRef.current !== null) clearTimeout(composerRetryRef.current);
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
