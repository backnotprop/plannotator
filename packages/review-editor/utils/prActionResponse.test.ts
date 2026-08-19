import { describe, expect, test } from 'bun:test';
import { parsePRActionSuccess, readPRActionError } from './prActionResponse';

const failedComment = {
  path: 'src/failing.ts',
  line: 19,
  side: 'RIGHT' as const,
  body: 'Handle this failure.',
};

describe('parsePRActionSuccess', () => {
  test('parses an all-success response', () => {
    expect(parsePRActionSuccess({
      ok: true,
      prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
      submission: { status: 'complete' },
    })).toEqual({
      prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
      submission: { status: 'complete' },
    });
  });

  test('rejects an all-failure error response', () => {
    const response = {
      error: 'Failed to post inline comments: src/failing.ts:19',
    };

    expect(parsePRActionSuccess(response)).toBeNull();
    expect(readPRActionError(response)).toBe(response.error);
  });

  test('parses a mixed response with its exact retry contract', () => {
    const response = {
      ok: true,
      submission: {
        status: 'partial',
        postedFileCommentCount: 1,
        failedFileComments: [
          {
            comment: failedComment,
            error: 'src/failing.ts:19: rejected',
          },
        ],
        reviewBodyPosted: true,
        approval: 'not-requested',
        recoveryFile: '/tmp/plannotator/failed-comments/review.json',
        retry: {
          action: 'comment',
          fileComments: [failedComment],
        },
      },
    };

    expect(parsePRActionSuccess(response)).toEqual({
      submission: response.submission,
    });
  });

  test('rejects a partial response that could cause an unsafe broad retry', () => {
    expect(parsePRActionSuccess({
      ok: true,
      submission: {
        status: 'partial',
        postedFileCommentCount: 1,
        failedFileComments: [],
        reviewBodyPosted: true,
        approval: 'not-requested',
      },
    })).toBeNull();
  });

  test('rejects a retry payload that includes an already-posted comment', () => {
    expect(parsePRActionSuccess({
      ok: true,
      submission: {
        status: 'partial',
        postedFileCommentCount: 1,
        failedFileComments: [{
          comment: failedComment,
          error: 'rejected',
        }],
        reviewBodyPosted: true,
        approval: 'not-requested',
        retry: {
          action: 'comment',
          fileComments: [
            failedComment,
            { ...failedComment, path: 'src/already-posted.ts' },
          ],
        },
      },
    })).toBeNull();
  });
});
