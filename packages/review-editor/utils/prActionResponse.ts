import type {
  PRReviewCommentFailure,
  PRReviewFileComment,
  PRReviewRetry,
  PRReviewSubmissionPartial,
  PRReviewSubmissionResult,
} from '@plannotator/shared/pr-types';

/** Parsed success payload returned by the review server's platform endpoint. */
export interface PRActionSuccess {
  prUrl?: string;
  submission: PRReviewSubmissionResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseFileComment(value: unknown): PRReviewFileComment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.path !== 'string' ||
    typeof value.line !== 'number' ||
    !Number.isInteger(value.line) ||
    (value.side !== 'LEFT' && value.side !== 'RIGHT') ||
    typeof value.body !== 'string'
  ) {
    return null;
  }

  const startLine = value.start_line;
  const startSide = value.start_side;
  if (
    (startLine !== undefined && (
      typeof startLine !== 'number' ||
      !Number.isInteger(startLine)
    )) ||
    (startSide !== undefined && startSide !== 'LEFT' && startSide !== 'RIGHT')
  ) {
    return null;
  }

  return {
    path: value.path,
    line: value.line,
    side: value.side,
    body: value.body,
    ...(startLine !== undefined ? { start_line: startLine } : {}),
    ...(startSide !== undefined ? { start_side: startSide } : {}),
  };
}

function parseRetry(value: unknown): PRReviewRetry | null {
  if (
    !isRecord(value) ||
    (value.action !== 'approve' && value.action !== 'comment') ||
    !Array.isArray(value.fileComments)
  ) {
    return null;
  }
  const fileComments = value.fileComments.map(parseFileComment);
  if (fileComments.some((comment) => comment === null)) return null;
  return {
    action: value.action,
    fileComments: fileComments.filter(
      (comment): comment is PRReviewFileComment => comment !== null,
    ),
  };
}

function parseCommentFailure(value: unknown): PRReviewCommentFailure | null {
  if (!isRecord(value) || typeof value.error !== 'string') return null;
  const comment = parseFileComment(value.comment);
  return comment ? { comment, error: value.error } : null;
}

function sameFileComment(
  left: PRReviewFileComment,
  right: PRReviewFileComment,
): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    left.side === right.side &&
    left.body === right.body &&
    left.start_line === right.start_line &&
    left.start_side === right.start_side
  );
}

/** Parse one server-issued partial submission and its exact retry contract. */
export function parsePRReviewSubmissionPartial(
  value: Record<string, unknown>,
): PRReviewSubmissionPartial | null {
  if (
    typeof value.postedFileCommentCount !== 'number' ||
    !Number.isInteger(value.postedFileCommentCount) ||
    value.postedFileCommentCount < 0 ||
    !Array.isArray(value.failedFileComments) ||
    typeof value.reviewBodyPosted !== 'boolean' ||
    (
      value.approval !== 'not-requested' &&
      value.approval !== 'succeeded' &&
      value.approval !== 'failed'
    )
  ) {
    return null;
  }

  const failedFileComments = value.failedFileComments.map(parseCommentFailure);
  if (failedFileComments.some((failure) => failure === null)) return null;
  const retry = parseRetry(value.retry);
  const approvalError = optionalString(value.approvalError);
  const recoveryFile = optionalString(value.recoveryFile);
  if (!retry || approvalError === null || recoveryFile === null) return null;
  const failures = failedFileComments.filter(
    (failure): failure is PRReviewCommentFailure => failure !== null,
  );
  const retryMatchesFailures =
    retry.fileComments.length === failures.length &&
    retry.fileComments.every((comment, index) =>
      sameFileComment(comment, failures[index].comment)
    );
  const retryActionMatchesApproval =
    value.approval === 'failed'
      ? retry.action === 'approve' && approvalError !== undefined
      : retry.action === 'comment' && approvalError === undefined;
  if (
    !retryMatchesFailures ||
    !retryActionMatchesApproval ||
    (failures.length === 0 && value.approval !== 'failed')
  ) {
    return null;
  }

  return {
    status: 'partial',
    postedFileCommentCount: value.postedFileCommentCount,
    failedFileComments: failures,
    reviewBodyPosted: value.reviewBodyPosted,
    approval: value.approval,
    ...(approvalError !== undefined ? { approvalError } : {}),
    ...(recoveryFile !== undefined ? { recoveryFile } : {}),
    retry,
  };
}

/**
 * Parse the success response from `/api/pr-action`.
 *
 * Returns `null` when the payload does not satisfy the current API contract.
 */
export function parsePRActionSuccess(value: unknown): PRActionSuccess | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.submission)) {
    return null;
  }
  const prUrl = optionalString(value.prUrl);
  if (prUrl === null) return null;

  let submission: PRReviewSubmissionResult;
  if (value.submission.status === 'complete') {
    submission = { status: 'complete' };
  } else if (value.submission.status === 'partial') {
    const partial = parsePRReviewSubmissionPartial(value.submission);
    if (!partial) return null;
    submission = partial;
  } else {
    return null;
  }

  return {
    ...(prUrl !== undefined ? { prUrl } : {}),
    submission,
  };
}

/** Read a safe server error message from an unsuccessful platform response. */
export function readPRActionError(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === 'string'
    ? value.error
    : undefined;
}
