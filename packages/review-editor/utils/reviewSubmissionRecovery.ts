import type { PRReviewSubmissionPartial } from '@plannotator/shared/pr-types';
import type {
  ReviewSubmission,
  SubmissionTarget,
} from '../components/ReviewSubmissionDialog';
import { parsePRReviewSubmissionPartial } from './prActionResponse';

const STORAGE_KEY_PREFIX = 'plannotator-pr-review-recovery-v1:';

/** Minimal session-storage capability used by review recovery. */
export interface ReviewRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RetainedTargetBase {
  prUrl: string;
  prNumber: number;
  prTitle: string;
  prRepo: string;
  fileCount: number;
  annotationCount: number;
}

type RetainedSubmissionTarget =
  | (RetainedTargetBase & { status: 'success' })
  | (RetainedTargetBase & {
      status: 'partial';
      partial: PRReviewSubmissionPartial;
      error?: string;
    })
  | (RetainedTargetBase & {
      status: 'blocked';
      error: string;
      partial?: PRReviewSubmissionPartial;
    });

/** Retry-safe progress retained for one root PR review within a browser tab. */
export interface ReviewSubmissionRecovery {
  action: 'approve' | 'comment';
  generalComment: string;
  targets: RetainedSubmissionTarget[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseRetainedTarget(value: unknown): RetainedSubmissionTarget | null {
  if (!isRecord(value)) return null;
  const prNumber = parseNonNegativeInteger(value.prNumber);
  const fileCount = parseNonNegativeInteger(value.fileCount);
  const annotationCount = parseNonNegativeInteger(value.annotationCount);
  if (
    typeof value.prUrl !== 'string' ||
    typeof value.prTitle !== 'string' ||
    typeof value.prRepo !== 'string' ||
    prNumber === null ||
    fileCount === null ||
    annotationCount === null
  ) {
    return null;
  }

  const base: RetainedTargetBase = {
    prUrl: value.prUrl,
    prNumber,
    prTitle: value.prTitle,
    prRepo: value.prRepo,
    fileCount,
    annotationCount,
  };
  if (value.status === 'success') return { ...base, status: 'success' };
  if (value.status === 'blocked' && typeof value.error === 'string') {
    if (value.partial === undefined) {
      return { ...base, status: 'blocked', error: value.error };
    }
    if (!isRecord(value.partial)) return null;
    const partial = parsePRReviewSubmissionPartial(value.partial);
    return partial
      ? { ...base, status: 'blocked', error: value.error, partial }
      : null;
  }
  if (value.status !== 'partial' || !isRecord(value.partial)) return null;
  const partial = parsePRReviewSubmissionPartial(value.partial);
  if (!partial || (value.error !== undefined && typeof value.error !== 'string')) {
    return null;
  }
  return {
    ...base,
    status: 'partial',
    partial,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function parseRecovery(value: unknown): ReviewSubmissionRecovery | null {
  if (
    !isRecord(value) ||
    (value.action !== 'approve' && value.action !== 'comment') ||
    typeof value.generalComment !== 'string' ||
    !Array.isArray(value.targets)
  ) {
    return null;
  }
  const targets = value.targets.map(parseRetainedTarget);
  if (targets.some((target) => target === null)) return null;
  return {
    action: value.action,
    generalComment: value.generalComment,
    targets: targets.filter(
      (target): target is RetainedSubmissionTarget => target !== null,
    ),
  };
}

function storageKey(rootPrUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(rootPrUrl)}`;
}

function blockedCorruptRecovery(rootPrUrl: string): ReviewSubmissionRecovery {
  return {
    action: 'comment',
    generalComment: '',
    targets: [{
      prUrl: rootPrUrl,
      prNumber: 0,
      prTitle: 'Saved retry state unavailable',
      prRepo: 'Platform review',
      fileCount: 0,
      annotationCount: 0,
      status: 'blocked',
      error: 'Plannotator found saved review progress but could not read its retry contract. Automatic replay is blocked to avoid duplicate comments; inspect the platform review before starting again.',
    }],
  };
}

/** Load retry-safe progress for one root PR URL from tab-scoped storage. */
export function loadReviewSubmissionRecovery(
  storage: ReviewRecoveryStorage,
  rootPrUrl: string,
): ReviewSubmissionRecovery | null {
  try {
    const raw = storage.getItem(storageKey(rootPrUrl));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return blockedCorruptRecovery(rootPrUrl);
    }
    return parseRecovery(parsed.recovery) ?? blockedCorruptRecovery(rootPrUrl);
  } catch {
    return blockedCorruptRecovery(rootPrUrl);
  }
}

/**
 * Persist or clear retry-safe progress for one root PR URL.
 * Returns whether tab-scoped refresh recovery is available.
 */
export function saveReviewSubmissionRecovery(
  storage: ReviewRecoveryStorage,
  rootPrUrl: string,
  recovery: ReviewSubmissionRecovery | null,
): boolean {
  try {
    if (recovery && recovery.targets.length > 0) {
      storage.setItem(
        storageKey(rootPrUrl),
        JSON.stringify({ version: 1, recovery }),
      );
    } else {
      storage.removeItem(storageKey(rootPrUrl));
    }
    return true;
  } catch {
    // A storage failure must not broaden a live in-memory retry. The dialog
    // still retains its current target state until the tab is refreshed.
    return false;
  }
}

/**
 * Retain only states that prove a remote mutation or make replay ambiguous.
 * Plain failures are omitted because the original request is safe to retry.
 */
export function buildReviewSubmissionRecovery(
  action: 'approve' | 'comment',
  generalComment: string,
  targets: SubmissionTarget[],
): ReviewSubmissionRecovery | null {
  const retainedTargets = targets.flatMap((target): RetainedSubmissionTarget[] => {
    const base: RetainedTargetBase = {
      prUrl: target.prUrl,
      prNumber: target.prNumber,
      prTitle: target.prTitle,
      prRepo: target.prRepo,
      fileCount: target.fileCount,
      annotationCount: target.annotationCount,
    };
    if (target.status === 'success') return [{ ...base, status: 'success' }];
    if (target.status === 'blocked') {
      return [{
        ...base,
        status: 'blocked',
        error: target.error ?? 'Retry blocked because the platform result is ambiguous.',
        ...(target.partial ? { partial: target.partial } : {}),
      }];
    }
    if (target.status === 'partial' && target.partial) {
      return [{
        ...base,
        status: 'partial',
        partial: target.partial,
        ...(target.error ? { error: target.error } : {}),
      }];
    }
    return [];
  });
  return retainedTargets.length > 0
    ? { action, generalComment, targets: retainedTargets }
    : null;
}

function restoreTarget(
  freshTarget: SubmissionTarget | undefined,
  retained: RetainedSubmissionTarget,
): SubmissionTarget {
  const base: SubmissionTarget = freshTarget ?? {
    prUrl: retained.prUrl,
    prNumber: retained.prNumber,
    prTitle: retained.prTitle,
    prRepo: retained.prRepo,
    fileComments: retained.status === 'partial'
      ? retained.partial.retry.fileComments
      : [],
    fileScopedBody: '',
    fileCount: retained.fileCount,
    annotationCount: retained.annotationCount,
    status: 'pending',
  };
  if (retained.status === 'success') {
    return { ...base, status: 'success', error: undefined, partial: undefined };
  }
  if (retained.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      error: retained.error,
      partial: retained.partial,
    };
  }
  return {
    ...base,
    status: 'partial',
    partial: retained.partial,
    error: retained.error,
  };
}

/** Merge retained progress into a freshly rebuilt annotation submission. */
export function restoreReviewSubmission(
  freshSubmission: ReviewSubmission,
  recovery: ReviewSubmissionRecovery,
): ReviewSubmission {
  const freshByUrl = new Map(
    freshSubmission.targets.map((target) => [target.prUrl, target]),
  );
  const retainedByUrl = new Map(
    recovery.targets.map((target) => [target.prUrl, target]),
  );
  const restoredTargets = freshSubmission.targets.map((target) => {
    const retained = retainedByUrl.get(target.prUrl);
    return retained ? restoreTarget(target, retained) : target;
  });
  for (const retained of recovery.targets) {
    if (!freshByUrl.has(retained.prUrl)) {
      restoredTargets.push(restoreTarget(undefined, retained));
    }
  }
  return { ...freshSubmission, targets: restoredTargets };
}
