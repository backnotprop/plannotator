import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ReviewSubmissionDialog,
  type ReviewSubmission,
  type SubmissionTarget,
} from './ReviewSubmissionDialog';

const hasDom = typeof document !== 'undefined';

const failedComment = {
  path: 'src/failing.ts',
  line: 19,
  side: 'RIGHT' as const,
  body: 'Handle this failure.',
};

const baseTarget: SubmissionTarget = {
  prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
  prNumber: 7,
  prTitle: 'Make reviews reliable',
  prRepo: 'acme/widgets',
  fileComments: [failedComment],
  fileScopedBody: '',
  fileCount: 1,
  annotationCount: 1,
  status: 'pending',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderSubmission(
  submission: ReviewSubmission,
  generalComment = '',
  options: {
    isSubmitting?: boolean;
    onCancel?: () => void;
  } = {},
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ReviewSubmissionDialog
        isOpen
        action="comment"
        submission={submission}
        generalComment={generalComment}
        onGeneralCommentChange={() => {}}
        platformOpenPR={false}
        onPlatformOpenPRChange={() => {}}
        onConfirm={() => {}}
        onCancel={options.onCancel ?? (() => {})}
        isSubmitting={options.isSubmitting ?? false}
        recoveryPersistsRefresh
        mrLabel="MR"
        platformLabel="GitLab"
      />,
    );
  });
}

function actionButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Post Comments') ||
    button.textContent?.includes('Retry Failed') ||
    button.textContent?.includes('Retry Unposted')
  ) ?? null;
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('ReviewSubmissionDialog submission outcomes', () => {
  test.skipIf(!hasDom)('keeps the dialog inside the observed viewport and marks its primary input for mobile Safari', async () => {
    await renderSubmission({ targets: [baseTarget], orphans: [] });

    expect(document.querySelector('.pn-visible-viewport-overlay')).not.toBeNull();
    expect(document.querySelector('textarea')?.hasAttribute('data-pn-mobile-editable')).toBe(true);
    expect(actionButton()?.hasAttribute('data-pn-touch-target')).toBe(true);
  });

  test.skipIf(!hasDom)('ignores Escape while a platform submission is in flight', async () => {
    let cancelCount = 0;
    await renderSubmission(
      { targets: [baseTarget], orphans: [] },
      '',
      {
        isSubmitting: true,
        onCancel: () => { cancelCount += 1; },
      },
    );

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(cancelCount).toBe(0);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('renders all-success as complete and disables another submission', async () => {
    await renderSubmission({
      targets: [{ ...baseTarget, status: 'success' }],
      orphans: [],
    });

    expect(document.body.textContent).toContain('acme/widgets#7');
    expect(actionButton()?.disabled).toBe(true);
  });

  test.skipIf(!hasDom)('renders all-failure with its error and a retry action', async () => {
    await renderSubmission({
      targets: [{
        ...baseTarget,
        status: 'failed',
        error: 'Failed to post inline comments',
      }],
      orphans: [],
    });

    expect(document.body.textContent).toContain('Failed to post inline comments');
    expect(actionButton()?.textContent).toContain('Retry Failed');
    expect(actionButton()?.disabled).toBe(false);
  });

  test.skipIf(!hasDom)('renders mixed results with exact recovery and safe retry guidance', async () => {
    await renderSubmission({
      targets: [{
        ...baseTarget,
        status: 'partial',
        partial: {
          status: 'partial',
          postedFileCommentCount: 1,
          failedFileComments: [{
            comment: failedComment,
            error: 'src/failing.ts:19: rejected',
          }],
          reviewBodyPosted: true,
          approval: 'not-requested',
          recoveryFile: '/tmp/plannotator/failed-comments/review.json',
          retry: {
            action: 'comment',
            fileComments: [failedComment],
          },
        },
      }],
      orphans: [],
    }, 'Edited general comment');

    const content = document.body.textContent ?? '';
    expect(content).toContain('Review partially posted');
    expect(content).toContain('This attempt posted 1 inline comment and the general comment');
    expect(content).toContain('src/failing.ts:19');
    expect(content).toContain('Handle this failure.');
    expect(content).toContain('Retry sends only the 1 unposted inline comment');
    expect(content).toContain('/tmp/plannotator/failed-comments/review.json');
    expect(content).toContain('General comment locked because it may already be posted');
    expect(content).toContain('refresh this tab');
    const textarea = document.querySelector('textarea');
    expect(textarea?.disabled).toBe(true);
    expect(textarea?.value).toBe('Edited general comment');
    expect(actionButton()?.textContent).toContain('Retry Unposted');
    expect(actionButton()?.disabled).toBe(false);
  });
});
