import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PRContext, PRMetadata } from '@plannotator/shared/pr-types';
import { ReviewStateProvider, type ReviewState } from '../ReviewStateContext';

const hasDom = typeof document !== 'undefined';
const overviewModule = hasDom ? await import('./ReviewPROverviewPanel') : null;
// SAFETY: DOM-gated tests never render this component when the dynamic import is absent.
const ReviewPROverviewPanel = overviewModule?.ReviewPROverviewPanel as
  typeof import('./ReviewPROverviewPanel')['ReviewPROverviewPanel'];
let root: Root | null = null;
let host: HTMLElement | null = null;

const metadata: PRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  number: 12,
  title: 'Make mobile review useful',
  author: 'reviewer',
  baseBranch: 'main',
  headBranch: 'mobile-review',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://github.com/acme/widgets/pull/12',
};

function makeContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    body: '',
    state: 'OPEN',
    isDraft: false,
    labels: [],
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    linkedIssues: [],
    ...overrides,
  };
}

async function renderOverview(context: PRContext, compact: boolean): Promise<void> {
  const state = {
    prMetadata: metadata,
    prContext: context,
    isPRContextLoading: false,
    prContextError: null,
    fetchPRContext: () => {},
    platformUser: null,
    isCompactTouchLayout: compact,
    onAddCommentAnnotation: () => {},
    onAskAIForComment: undefined,
    commentScrollTarget: null,
  } as unknown as ReviewState;

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <ReviewStateProvider value={state}>
      <ReviewPROverviewPanel {...({} as IDockviewPanelProps)} />
    </ReviewStateProvider>,
  ));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('ReviewPROverviewPanel responsive composition', () => {
  test.skipIf(!hasDom)('omits the empty comments region on desktop', async () => {
    await renderOverview(makeContext(), false);

    expect(document.body.textContent).toContain('Summary');
    expect(document.body.textContent).not.toContain('Comments');
    expect(document.querySelectorAll('section')).toHaveLength(1);
  });

  test.skipIf(!hasDom)('shows one PR context region at a time on compact touch layouts', async () => {
    await renderOverview(makeContext({
      comments: [{
        id: 'comment-1',
        author: 'alex',
        body: 'Please keep the mobile shell focused.',
        createdAt: '2026-08-12T12:00:00Z',
        url: 'https://github.com/acme/widgets/pull/12#issuecomment-1',
      }],
    }), true);

    const commentsButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Comments · 1'));
    expect(commentsButton).not.toBeUndefined();
    expect(document.querySelectorAll('section')).toHaveLength(1);

    await act(async () => commentsButton?.click());
    expect(document.body.textContent).toContain('Please keep the mobile shell focused.');
    expect(document.querySelectorAll('section')).toHaveLength(1);
  });
});
