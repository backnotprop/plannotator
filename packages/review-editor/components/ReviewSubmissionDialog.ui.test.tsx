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
  fileLevelComments: [],
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
    action?: 'approve' | 'comment' | 'request_changes';
    onActionChange?: (action: 'comment' | 'request_changes') => void;
    requestChangesUnavailableReason?: string;
  } = {},
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ReviewSubmissionDialog
        isOpen
        action={options.action ?? 'comment'}
        onActionChange={options.onActionChange}
        requestChangesUnavailableReason={options.requestChangesUnavailableReason}
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

  test.skipIf(!hasDom)('keeps the action footer outside the scrollable form body', async () => {
    await renderSubmission({ targets: [baseTarget], orphans: [] });

    const scrollableBody = document.querySelector('textarea')?.closest('.overflow-y-auto');

    expect(scrollableBody).not.toBeNull();
    expect(scrollableBody?.contains(actionButton())).toBe(false);
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

// #1611: the dialog is where Comment vs Request changes is chosen.
describe('ReviewSubmissionDialog review event choice', () => {
  const radio = (value: 'comment' | 'request_changes') =>
    document.querySelector<HTMLInputElement>(`[data-review-event-choice] input[value="${value}"]`);

  test.skipIf(!hasDom)('offers no choice unless the caller asks for one (the primary Post Comments flow)', async () => {
    await renderSubmission({ targets: [baseTarget], orphans: [] });
    expect(document.querySelector('[data-review-event-choice]')).toBeNull();
  });

  test.skipIf(!hasDom)('reports the picked event and reflects the preselected one', async () => {
    const picked: string[] = [];
    await renderSubmission({ targets: [baseTarget], orphans: [] }, '', {
      action: 'request_changes',
      onActionChange: (next) => picked.push(next),
    });
    expect(radio('request_changes')?.checked).toBe(true);
    // Frozen copy (maintainer-approved): the confirm names the event it posts.
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Request Changes')).toBe(true);
    await act(async () => radio('comment')!.click());
    expect(picked).toEqual(['comment']);
  });

  test.skipIf(!hasDom)('disables Request changes with the reason where it cannot be posted', async () => {
    await renderSubmission({ targets: [baseTarget], orphans: [] }, '', {
      onActionChange: () => {},
      requestChangesUnavailableReason: 'SENTINEL_REASON',
    });
    const option = radio('request_changes')!;
    expect(option.disabled).toBe(true);
    // Sentinel: the reason is wired to the disabled option, whatever its copy.
    expect(document.getElementById(option.getAttribute('aria-describedby')!)?.textContent).toBe('SENTINEL_REASON');
    expect(radio('comment')?.disabled).toBe(false);
  });

  test.skipIf(!hasDom)('locks the choice once any target may have been posted, so a retry keeps the event', async () => {
    const second = { ...baseTarget, prUrl: `${baseTarget.prUrl}-2`, prNumber: 8 };
    await renderSubmission({
      targets: [{ ...baseTarget, status: 'success' }, { ...second, status: 'failed', error: 'boom' }],
      orphans: [],
    }, '', { action: 'request_changes', onActionChange: () => {} });
    expect(radio('comment')?.disabled).toBe(true);
    expect(radio('request_changes')?.disabled).toBe(true);
    expect(radio('request_changes')?.checked).toBe(true);
  });

  test.skipIf(!hasDom)('after a plain failure nothing was posted, so the event can still change', async () => {
    await renderSubmission({
      targets: [{ ...baseTarget, status: 'failed', error: 'refused' }],
      orphans: [],
    }, '', { action: 'request_changes', onActionChange: () => {} });
    expect(radio('comment')?.disabled).toBe(false);
  });
});
