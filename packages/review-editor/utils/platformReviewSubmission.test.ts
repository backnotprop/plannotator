import { describe, expect, test } from 'bun:test';
import type { PRReviewSubmissionPartial } from '@plannotator/shared/pr-types';
import type {
  ReviewSubmission,
  SubmissionTarget,
} from '../components/ReviewSubmissionDialog';
import {
  submitPlatformReviewTarget,
  submitPlatformReviewTargets,
} from './platformReviewSubmission';
import {
  buildReviewSubmissionRecovery,
  loadReviewSubmissionRecovery,
  restoreReviewSubmission,
  saveReviewSubmissionRecovery,
  type ReviewRecoveryStorage,
} from './reviewSubmissionRecovery';

const comments = [
  { path: 'src/one.ts', line: 10, side: 'RIGHT' as const, body: 'One' },
  { path: 'src/two.ts', line: 20, side: 'RIGHT' as const, body: 'Two' },
  { path: 'src/three.ts', line: 30, side: 'LEFT' as const, body: 'Three' },
];

const baseTarget: SubmissionTarget = {
  prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
  prNumber: 7,
  prTitle: 'Reliable retry',
  prRepo: 'acme/widgets',
  fileComments: comments,
  fileScopedBody: '',
  fileCount: 3,
  annotationCount: 3,
  status: 'pending',
};

class MemoryStorage implements ReviewRecoveryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  corruptAll(value: string): void {
    for (const key of this.values.keys()) this.values.set(key, value);
  }
}

function partial(
  failedComments: typeof comments,
  postedFileCommentCount: number,
): PRReviewSubmissionPartial {
  return {
    status: 'partial',
    postedFileCommentCount,
    failedFileComments: failedComments.map((comment) => ({
      comment,
      error: `${comment.path}:${comment.line}: rejected`,
    })),
    reviewBodyPosted: postedFileCommentCount > 0,
    approval: 'not-requested',
    retry: { action: 'comment', fileComments: failedComments },
  };
}

function successResponse(submission: object): Response {
  return Response.json({ ok: true, submission });
}

describe('platform review retry safety', () => {
  test('partial → close/reopen → retry stays narrowed across retry-of-a-retry', async () => {
    const requests: unknown[] = [];
    const responses = [
      successResponse(partial([comments[1], comments[2]], 1)),
      successResponse({ status: 'complete' }),
      successResponse(partial([comments[2]], 1)),
      successResponse({ status: 'complete' }),
    ];
    const fetchReview = async (_input: string, init: RequestInit): Promise<Response> => {
      if (typeof init.body !== 'string') throw new Error('Expected JSON request body');
      const request: unknown = JSON.parse(init.body);
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error('Unexpected extra request');
      return response;
    };

    const completedSibling: SubmissionTarget = {
      ...baseTarget,
      prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/8',
      prNumber: 8,
      status: 'pending',
    };
    const first = await submitPlatformReviewTargets({
      targets: [baseTarget, completedSibling],
      action: 'comment',
      generalComment: 'Overall review',
      bodyForTarget: () => 'Overall review',
      fetchReview,
    });
    expect(first.targets[0].status).toBe('partial');
    expect(first.targets[1].status).toBe('success');

    const storage = new MemoryStorage();
    const recovery = first.recovery;
    expect(recovery).not.toBeNull();
    saveReviewSubmissionRecovery(storage, baseTarget.prUrl, recovery);

    // Simulate Cancel/Close by discarding the dialog plan, then rebuilding it.
    const freshPlan: ReviewSubmission = {
      targets: [
        { ...baseTarget, status: 'pending' },
        completedSibling,
      ],
      orphans: [],
    };
    const reloaded = loadReviewSubmissionRecovery(storage, baseTarget.prUrl);
    if (!reloaded) throw new Error('Expected persisted recovery');
    const reopened = restoreReviewSubmission(freshPlan, reloaded);
    expect(reopened.targets[0].status).toBe('partial');
    expect(reopened.targets[1].status).toBe('success');

    const second = await submitPlatformReviewTargets({
      targets: reopened.targets,
      action: reloaded.action,
      generalComment: 'Overall review',
      bodyForTarget: () => 'This edit must not be posted',
      fetchReview,
    });
    expect(second.targets[0].status).toBe('partial');
    expect(second.targets[1].status).toBe('success');

    const third = await submitPlatformReviewTargets({
      targets: second.targets,
      action: 'comment',
      generalComment: 'Overall review',
      bodyForTarget: () => 'Still must not be posted',
      fetchReview,
    });
    expect(third.allComplete).toBe(true);
    expect(requests).toEqual([
      {
        action: 'comment',
        body: 'Overall review',
        fileComments: comments,
        targetPrUrl: baseTarget.prUrl,
      },
      {
        action: 'comment',
        body: 'Overall review',
        fileComments: comments,
        targetPrUrl: completedSibling.prUrl,
      },
      {
        action: 'comment',
        body: '',
        fileComments: [comments[1], comments[2]],
        targetPrUrl: baseTarget.prUrl,
      },
      {
        action: 'comment',
        body: '',
        fileComments: [comments[2]],
        targetPrUrl: baseTarget.prUrl,
      },
    ]);
  });

  test('a server-confirmed retry failure preserves the partial state', async () => {
    const narrowed = partial([comments[2]], 2);
    const result = await submitPlatformReviewTarget({
      target: { ...baseTarget, status: 'partial', partial: narrowed },
      action: 'comment',
      body: 'Ignored',
      fetchReview: async () => Response.json(
        { error: 'Retry failed before posting' },
        { status: 500 },
      ),
    });

    expect(result.target).toMatchObject({
      status: 'partial',
      partial: narrowed,
      error: 'Retry failed before posting',
    });
  });

  test('an unrecognized success blocks replay and survives reopen', async () => {
    let fetchCount = 0;
    const ambiguous = await submitPlatformReviewTarget({
      target: baseTarget,
      action: 'comment',
      body: 'Overall review',
      fetchReview: async () => {
        fetchCount += 1;
        return Response.json({ ok: true, submission: { status: 'newer-version' } });
      },
    });
    expect(ambiguous.target.status).toBe('blocked');

    const storage = new MemoryStorage();
    const recovery = buildReviewSubmissionRecovery(
      'comment',
      'Overall review',
      [ambiguous.target],
    );
    saveReviewSubmissionRecovery(storage, baseTarget.prUrl, recovery);
    const reloaded = loadReviewSubmissionRecovery(storage, baseTarget.prUrl);
    if (!reloaded) throw new Error('Expected blocked recovery');
    const reopened = restoreReviewSubmission(
      { targets: [baseTarget], orphans: [] },
      reloaded,
    );
    expect(reopened.targets[0].status).toBe('blocked');

    await submitPlatformReviewTarget({
      target: reopened.targets[0],
      action: 'comment',
      body: 'Must not post',
      fetchReview: async () => {
        fetchCount += 1;
        return successResponse({ status: 'complete' });
      },
    });
    expect(fetchCount).toBe(1);
  });

  test('an unreadable saved retry blocks a broad replay after refresh', () => {
    const storage = new MemoryStorage();
    const recoveryToCorrupt = buildReviewSubmissionRecovery(
      'comment',
      'Overall review',
      [{ ...baseTarget, status: 'success' }],
    );
    saveReviewSubmissionRecovery(
      storage,
      baseTarget.prUrl,
      recoveryToCorrupt,
    );
    storage.corruptAll('{not-json');

    const recovery = loadReviewSubmissionRecovery(storage, baseTarget.prUrl);
    if (!recovery) throw new Error('Expected corrupt recovery to fail closed');
    const reopened = restoreReviewSubmission(
      { targets: [baseTarget], orphans: [] },
      recovery,
    );

    expect(reopened.targets[0]).toMatchObject({
      status: 'blocked',
      error: expect.stringContaining('could not read its retry contract'),
    });
  });
});
