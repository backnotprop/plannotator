import { SERVER_SESSION_MISMATCH_CODE } from '@plannotator/shared/server-session';
import { markServerSessionReplaced, withServerSession } from '@plannotator/ui/utils/serverSession';
import type { PRReviewAction } from '@plannotator/shared/pr-types';
import type { SubmissionTarget } from '../components/ReviewSubmissionDialog';
import { buildPRActionRequest } from '../components/ReviewSubmissionDialog';
import { parsePRActionSuccess, readPRActionError } from './prActionResponse';
import {
  buildReviewSubmissionRecovery,
  type ReviewSubmissionRecovery,
} from './reviewSubmissionRecovery';

const UNKNOWN_RESULT_ERROR =
  'The platform may have accepted part of this review, but Plannotator could not confirm the result. Automatic retry is blocked to avoid duplicate comments. Inspect the pull request or merge request before starting another review.';

export type PlatformReviewFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface PlatformReviewTargetResult {
  target: SubmissionTarget;
  prUrl?: string;
  postedAs?: 'comment';
}

export interface PlatformReviewAttemptResult {
  targets: SubmissionTarget[];
  allComplete: boolean;
  recovery: ReviewSubmissionRecovery | null;
  openUrls: string[];
  postedAs?: 'comment';
}

export function markPlatformReviewSafeFailure(
  target: SubmissionTarget,
  error: string,
): SubmissionTarget {
  return target.partial
    ? { ...target, status: 'partial', error }
    : { ...target, status: 'failed', error, partial: undefined };
}

export function markPlatformReviewAmbiguous(
  target: SubmissionTarget,
  error = UNKNOWN_RESULT_ERROR,
): SubmissionTarget {
  return { ...target, status: 'blocked', error };
}

export async function submitPlatformReviewTarget(options: {
  target: SubmissionTarget;
  action: PRReviewAction;
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
      body: JSON.stringify(withServerSession(buildPRActionRequest(action, body, target))),
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
    if (response.status === 409 && (rawResponse as { code?: unknown } | null)?.code === SERVER_SESSION_MISMATCH_CODE) {
      markServerSessionReplaced();
    }
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
  const postedAs = parsed.submission.postedAs ?? target.partial?.postedAs;
  return {
    target: {
      ...target,
      status: 'success',
      error: undefined,
      partial: undefined,
    },
    ...(parsed.prUrl ? { prUrl: parsed.prUrl } : {}),
    ...(postedAs ? { postedAs } : {}),
  };
}

export async function submitPlatformReviewTargets(options: {
  targets: SubmissionTarget[];
  action: PRReviewAction;
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
  let postedAs: 'comment' | undefined;
  const updatedTargets = results.map((result, index) => {
    if (result.status === 'rejected') {
      return markPlatformReviewAmbiguous(targets[index]);
    }
    if (result.value.prUrl) openUrls.push(result.value.prUrl);
    if (result.value.postedAs) postedAs = result.value.postedAs;
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
    ...(postedAs ? { postedAs } : {}),
  };
}
