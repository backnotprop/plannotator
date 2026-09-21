import { describe, expect, test } from 'bun:test';
import {
  buildPRActionRequest,
  buildPlatformReviewBody,
  buildReviewSubmission,
  type SubmissionTarget,
} from './ReviewSubmissionDialog';
import type { CodeAnnotation } from '@plannotator/ui/types';

const inlineComment: SubmissionTarget['fileComments'][number] = {
  path: 'src/example.ts',
  line: 12,
  side: 'RIGHT',
  body: 'Handle the error here.',
};

describe('buildPlatformReviewBody', () => {
  test('contains only user-authored top-level feedback when present', () => {
    expect(buildPlatformReviewBody('comment', 'github', 'Overall feedback', {
      fileComments: [inlineComment],
      fileScopedBody: '**src/example.ts:** File-level feedback',
    })).toBe('Overall feedback\n\n**src/example.ts:** File-level feedback');
  });

  test('uses a neutral GitHub body for an inline-only comment review', () => {
    expect(buildPlatformReviewBody('comment', 'github', '   ', {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('See inline comments.');
  });

  test('does not manufacture a GitLab note for inline-only comments', () => {
    expect(buildPlatformReviewBody('comment', 'gitlab', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });

  test('does not manufacture an approval body', () => {
    expect(buildPlatformReviewBody('approve', 'github', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });
});

describe('buildPRActionRequest', () => {
  const target: SubmissionTarget = {
    prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
    prNumber: 7,
    prTitle: 'Reliable comments',
    prRepo: 'acme/widgets',
    fileComments: [inlineComment, { ...inlineComment, path: 'src/posted.ts', line: 30 }],
    fileScopedBody: '',
    fileCount: 2,
    annotationCount: 2,
    status: 'pending',
  };

  test('uses the complete original payload before any platform mutation', () => {
    expect(buildPRActionRequest('comment', 'Overall review', target)).toEqual({
      action: 'comment',
      body: 'Overall review',
      fileComments: target.fileComments,
      targetPrUrl: target.prUrl,
    });
  });

  test('uses only the server-authorized retry after a partial submission', () => {
    const partialTarget: SubmissionTarget = {
      ...target,
      status: 'partial',
      partial: {
        status: 'partial',
        postedFileCommentCount: 1,
        failedFileComments: [{
          comment: inlineComment,
          error: 'rejected',
        }],
        reviewBodyPosted: true,
        approval: 'succeeded',
        retry: {
          action: 'comment',
          fileComments: [inlineComment],
        },
      },
    };

    expect(buildPRActionRequest('approve', 'Do not repost this', partialTarget)).toEqual({
      action: 'comment',
      body: '',
      fileComments: [inlineComment],
      targetPrUrl: target.prUrl,
    });
  });

  test('refuses a partial target without a server-authorized retry', () => {
    expect(() => buildPRActionRequest('comment', 'Do not post', {
      ...target,
      status: 'partial',
    })).toThrow('missing its server-authorized retry');
  });
});

describe('Call Flow platform comments', () => {
  test('posts one inline comment whose body retains every selected call site', () => {
    const annotation: CodeAnnotation = {
      id: 'flow-1',
      type: 'comment',
      scope: 'line',
      filePath: 'src/order.ts',
      lineStart: 10,
      lineEnd: 10,
      side: 'new',
      text: 'Keep these calls in one transaction.',
      createdAt: 1,
      callFlowTargets: [{
        treePath: 'checkout:0/save:0',
        entry: 'checkout()',
        label: 'saveOrder()',
        filePath: 'src/order.ts',
        lineStart: 10,
        lineEnd: 10,
        side: 'new',
      }, {
        treePath: 'checkout:0/publish:1',
        entry: 'checkout()',
        label: 'publishReceipt()',
        filePath: 'src/events.ts',
        lineStart: 22,
        lineEnd: 22,
        side: 'new',
      }],
    };

    const submission = buildReviewSubmission(
      [annotation],
      [],
      'https://github.com/acme/widgets/pull/42',
      new Set(['src/order.ts', 'src/events.ts']),
      { number: 42, title: 'Flow', repo: 'acme/widgets' },
    );

    expect(submission.targets).toHaveLength(1);
    expect(submission.targets[0].fileComments).toHaveLength(1);
    expect(submission.targets[0].fileComments[0].body).toContain('src/order.ts:L10');
    expect(submission.targets[0].fileComments[0].body).toContain('src/events.ts:L22');
  });

  test('posts out-of-hunk Call Flow feedback in the review body, not as a fake inline comment', () => {
    const annotation: CodeAnnotation = {
      id: 'flow-outside',
      type: 'comment',
      scope: 'file',
      filePath: 'src/order.ts',
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      text: 'This existing call is part of the problem.',
      createdAt: 1,
      callFlowTargets: [{
        treePath: 'checkout:0/existing:0',
        entry: 'checkout()',
        label: 'existingCall()',
        filePath: 'src/order.ts',
        lineStart: 200,
        lineEnd: 200,
        side: 'new',
      }],
    };

    const submission = buildReviewSubmission(
      [annotation],
      [],
      'https://github.com/acme/widgets/pull/42',
      new Set(['src/order.ts']),
      { number: 42, title: 'Flow', repo: 'acme/widgets' },
    );

    expect(submission.targets[0].fileComments).toHaveLength(0);
    expect(submission.targets[0].fileScopedBody).toContain('This existing call is part of the problem.');
    expect(submission.targets[0].fileScopedBody).toContain('src/order.ts:L200');
  });

  test('posts a source-less Call Flow step in the review body', () => {
    const annotation: CodeAnnotation = {
      id: 'flow-structural',
      type: 'comment',
      scope: 'general',
      filePath: '',
      lineStart: 0,
      lineEnd: 0,
      side: 'new',
      text: 'This branch is the important part.',
      createdAt: 1,
      callFlowTargets: [{
        treePath: 'checkout:0/branch:0',
        entry: 'checkout()',
        label: 'if (authorized)',
        side: 'new',
      }],
    };

    const submission = buildReviewSubmission(
      [annotation],
      [],
      'https://github.com/acme/widgets/pull/42',
      new Set(),
      { number: 42, title: 'Flow', repo: 'acme/widgets' },
    );

    expect(submission.targets[0].fileComments).toHaveLength(0);
    expect(submission.targets[0].fileScopedBody).toContain('This branch is the important part.');
    expect(submission.targets[0].fileScopedBody).toContain('inferred step');
  });
});
