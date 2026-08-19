import type { SubmissionTarget } from '../components/ReviewSubmissionDialog';
import { buildPRActionRequest } from '../components/ReviewSubmissionDialog';
import { parsePRActionSuccess, readPRActionError } from './prActionResponse';
import {
  buildReviewSubmissionRecovery,
  type ReviewSubmissionRecovery,
} from './reviewSubmissionRecovery';

const UNKNOWN_RESULT_ERROR =
  'The platform may have accepted part of this review, but Plannotator could not confirm the result. Automatic retry is blocked to avoid duplicate comments. Inspect the pull request or merge request before starting another review.';

/** Fetch-compatible capability used to submit one platform review target. */
export type PlatformReviewFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Caller-visible result of submitting one target through `/api/pr-action`. */
export interface PlatformReviewTargetResult {
  target: SubmissionTarget;
  prUrl?: string;
}

/** Result of one complete multi-target platform submission attempt. */
export interface PlatformReviewAttemptResult {
  targets: SubmissionTarget[];
  allComplete: boolean;
  recovery: ReviewSubmissionRecovery | null;
  openUrls: string[];
}

/**
 * Preserve an existing narrowed retry after a server-confirmed safe failure.
 * A first-attempt failure has no known mutation and remains broadly retryable.
 */
export function markPlatformReviewSafeFailure(
  target: SubmissionTarget,
  error: string,
): SubmissionTarget {
  return target.partial
    ? { ...target, status: 'partial', error }
    : { ...target, status: 'failed', error, partial: undefined };
}

/** Block replay when the platform may have mutated but no result was confirmed. */
export function markPlatformReviewAmbiguous(
  target: SubmissionTarget,
  error = UNKNOWN_RESULT_ERROR,
): SubmissionTarget {
  return { ...target, status: 'blocked', error };
}

/**
 * Submit one platform target and translate the HTTP boundary into a retry-safe
 * target state. Network loss and unrecognized 2xx payloads block automatic
 * replay because the remote mutation outcome is unknowable.
 */
export async function submitPlatformReviewTarget(options: {
  target: SubmissionTarget;
  action: 'approve' | 'comment';
  body: string;
  fetchReview?: PlatformReviewFetch;
}): Promise<PlatformReviewTargetResult> {
  const { target, action, body, fetchReview = fetch } = options;
  if (target.status === 'success' || target.status === 'blocked') {
    return { target };
  }

  let response: Response;
  try {
    response = await fetchReview('/api/pr-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPRActionRequest(action, body, target)),
    });
  } catch {
    return { target: markPlatformReviewAmbiguous(target) };
  }

  let rawResponse: unknown;
  try {
    rawResponse = await response.json();
  } catch {
    return {
      target: response.ok
        ? markPlatformReviewAmbiguous(target)
        : markPlatformReviewSafeFailure(target, 'Failed to submit review'),
    };
  }

  if (!response.ok) {
    return {
      target: markPlatformReviewSafeFailure(
        target,
        readPRActionError(rawResponse) ?? 'Failed to submit review',
      ),
    };
  }

  const parsed = parsePRActionSuccess(rawResponse);
  if (!parsed) {
    return { target: markPlatformReviewAmbiguous(target) };
  }
  if (parsed.submission.status === 'partial') {
    return {
      target: {
        ...target,
        status: 'partial',
        error: undefined,
        partial: parsed.submission,
      },
      ...(parsed.prUrl ? { prUrl: parsed.prUrl } : {}),
    };
  }
  return {
    target: {
      ...target,
      status: 'success',
      error: undefined,
      partial: undefined,
    },
    ...(parsed.prUrl ? { prUrl: parsed.prUrl } : {}),
  };
}

/**
 * Execute the multi-target submission step used by `handlePlatformAction` and
 * derive the exact progress record that must survive dialog close or refresh.
 */
export async function submitPlatformReviewTargets(options: {
  targets: SubmissionTarget[];
  action: 'approve' | 'comment';
  generalComment: string;
  bodyForTarget: (target: SubmissionTarget) => string;
  fetchReview?: PlatformReviewFetch;
}): Promise<PlatformReviewAttemptResult> {
  const {
    targets,
    action,
    generalComment,
    bodyForTarget,
    fetchReview,
  } = options;
  const results = await Promise.allSettled(
    targets.map(async (target) => submitPlatformReviewTarget({
      target,
      action,
      body: bodyForTarget(target),
      ...(fetchReview ? { fetchReview } : {}),
    })),
  );
  const openUrls: string[] = [];
  const updatedTargets = results.map((result, index) => {
    if (result.status === 'rejected') {
      return markPlatformReviewAmbiguous(targets[index]);
    }
    if (result.value.prUrl) openUrls.push(result.value.prUrl);
    return result.value.target;
  });
  const allComplete = updatedTargets.every((target) => target.status === 'success');
  return {
    targets: updatedTargets,
    allComplete,
    recovery: allComplete
      ? null
      : buildReviewSubmissionRecovery(action, generalComment, updatedTargets),
    openUrls,
  };
}
