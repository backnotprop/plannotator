/**
 * Code review's explicit "go to the forge" links still go to the forge with click to pin on (`utils/refCardClick`).
 * Code review hooks ref cards on its whole app root (`onlyWithData`), so these links sit inside the hooked region.
 *
 * What regresses: a plain click on "Open PR ↗" (the PR overview), "View #12 on GitHub" (the stack dropdown) or the PR
 * title (the summary) that opens a pinned card instead of following the link; a ref pasted in the PR description that
 * no longer opens its card on a click (the region went dead, so the links above prove nothing).
 *
 * Run with DOM_TESTS=1.
 */
import React, { act, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import type { PRContext, PRMetadata, PRStackInfo, PRStackTree } from '@plannotator/shared/pr-types';
import { useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { setRefCardTransport } from '@plannotator/ui/utils/refCard';
import { REF_CARD_PROSE_ATTR, setRefCardClick } from '@plannotator/ui/utils/refCardClick';
import { ReviewStateProvider, type ReviewState } from '../dock/ReviewStateContext';

const hasDom = typeof document !== 'undefined';
const overviewModule = hasDom ? await import('../dock/panels/ReviewPROverviewPanel') : null;
const summaryModule = hasDom ? await import('./PRSummaryTab') : null;
const stackModule = hasDom ? await import('./StackedPRLabel') : null;
// SAFETY: DOM-gated tests never render these when the dynamic imports are absent.
const ReviewPROverviewPanel = overviewModule?.ReviewPROverviewPanel as typeof import('../dock/panels/ReviewPROverviewPanel')['ReviewPROverviewPanel'];
const PRSummaryTab = summaryModule?.PRSummaryTab as typeof import('./PRSummaryTab')['PRSummaryTab'];
const StackedPRLabel = stackModule?.StackedPRLabel as typeof import('./StackedPRLabel')['StackedPRLabel'];

const PR = 'https://github.com/acme/widgets/pull/12';
const OTHER = 'https://github.com/acme/widgets/pull/14';

const metadata: PRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  number: 12,
  title: 'Make the widget picker faster',
  author: 'charlie-dunn',
  baseBranch: 'ada/base',
  headBranch: 'charlie/picker',
  baseSha: 'base',
  headSha: 'head',
  url: PR,
};

function context(overrides: Partial<PRContext> = {}): PRContext {
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

function state(ctx: PRContext): ReviewState {
  return {
    prMetadata: metadata,
    prContext: ctx,
    isPRContextLoading: false,
    prContextError: null,
    fetchPRContext: () => {},
    platformUser: null,
    isCompactTouchLayout: false,
    onAddCommentAnnotation: () => {},
    onAskAIForComment: undefined,
    commentScrollTarget: null,
    descriptionAnnotations: [],
    selectedDescriptionAnnotationId: null,
    onAddDescriptionAnnotation: () => {},
    onSelectDescriptionAnnotation: () => {},
    onAskAIForDescription: undefined,
  } as unknown as ReviewState;
}

function answer(number: number): ForgeRefCardResult {
  return {
    ok: true,
    fetchedAt: 0,
    data: {
      platform: 'github',
      kind: 'pull',
      repo: 'acme/widgets',
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      title: `Pull ${number}`,
      state: 'open',
      author: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      closedAt: null,
      labels: [],
      assignees: [],
      comments: 0,
      body: 'A picker for widgets.',
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };
}

/** The hooked region, as code review's app root: cards only with data. `root` overrides where it listens. */
function Region({ children, root }: { children: React.ReactNode; root?: React.RefObject<HTMLElement | null> }) {
  const own = useRef<HTMLDivElement | null>(null);
  const card = useRefHoverCards(root ?? own, { delayMs: 20, onlyWithData: true });
  return (
    <div>
      <div ref={own} data-region="">
        {children}
      </div>
      {card}
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Clicks that reached the window un-prevented: the link would have navigated. Each is prevented here, so nothing does. */
let followed: string[];
const onWindowClick = (e: Event) => {
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (a && !e.defaultPrevented) followed.push(a.href);
  e.preventDefault();
};

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function mount(tree: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(tree));
}

async function click(el: Element): Promise<{ followed: boolean }> {
  const before = followed.length;
  let now = false;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    now = followed.length > before;
  });
  return { followed: now };
}

const pinned = () => document.querySelector('[data-ref-card-pinned]');
const linkByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) => a.textContent?.includes(text)) ?? null;

/** A plain click on `a` follows its link and pins no card. */
async function expectFollows(a: HTMLAnchorElement | null) {
  expect(a).not.toBeNull();
  expect(a!.href).toBe(PR);
  expect((await click(a!)).followed).toBe(true);
  await settle(10);
  expect(pinned()).toBeNull();
  expect(followed).toEqual([PR]);
}

beforeEach(() => {
  if (!hasDom) return;
  followed = [];
  setRefCardTransport(async (href) => answer(Number(href.split('/').pop())));
  setRefCardClick(true);
  window.addEventListener('click', onWindowClick);
});

afterEach(async () => {
  if (!hasDom) return;
  window.removeEventListener('click', onWindowClick);
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  setRefCardTransport(null);
  setRefCardClick(false);
});

describe.if(hasDom)("code review's explicit forge links follow on a plain click, with click to pin on", () => {
  test('"Open PR ↗" in the PR overview', async () => {
    await mount(
      <Region>
        <ReviewStateProvider value={state(context())}>
          <ReviewPROverviewPanel {...({} as IDockviewPanelProps)} />
        </ReviewStateProvider>
      </Region>,
    );
    await expectFollows(linkByText(container!.querySelector('[data-region]')!, 'Open PR'));
  });

  test('"View #12 on GitHub" in the stack dropdown', async () => {
    const stackInfo: PRStackInfo = { isStacked: true, baseBranch: 'ada/base', defaultBranch: 'main', label: 'Stacked', source: 'github-native' };
    const stackTree: PRStackTree = {
      nodes: [
        { branch: 'main', isCurrent: false, isDefaultBranch: true },
        { branch: 'ada/base', number: 11, title: 'The base', url: 'https://github.com/acme/widgets/pull/11', isCurrent: false, isDefaultBranch: false, state: 'open' },
        { branch: 'charlie/picker', number: 12, title: metadata.title, url: PR, isCurrent: true, isDefaultBranch: false, state: 'open' },
      ],
    };
    // The dropdown is portalled to the body, outside the app root code review hooks: the region here is the whole
    // body, so the link is guarded even if the dropdown one day draws inside the hooked root.
    const body = { current: document.body };
    await mount(
      <Region root={body}>
        <StackedPRLabel
          metadata={metadata}
          mrNumberLabel="#12"
          stackInfo={stackInfo}
          stackTree={stackTree}
          scope="layer"
          scopeOptions={[]}
          isSwitchingScope={false}
          onSelectScope={() => {}}
          onNavigatePR={() => {}}
        />
      </Region>,
    );
    const trigger = container!.querySelector<HTMLButtonElement>('button[title^="Stack:"]')!;
    await act(async () => trigger.click());
    await settle(10);
    const view = linkByText(document.body, 'View #12 on GitHub');
    expect(view).not.toBeNull();
    await expectFollows(view);
  });

  test('the PR title in the summary; a PR URL pasted in its description opens its card pinned', async () => {
    await mount(
      <Region>
        <ReviewStateProvider value={state(context({ body: `Stacked on ${OTHER} and #14.` }))}>
          <PRSummaryTab context={context({ body: `Stacked on ${OTHER} and #14.` })} metadata={metadata} />
        </ReviewStateProvider>
      </Region>,
    );
    const region = container!.querySelector('[data-region]')!;
    const title = linkByText(region, metadata.title);
    expect(title?.hasAttribute(REF_CARD_PROSE_ATTR)).toBe(false);
    await expectFollows(title);

    // The region is live: the ref written in the description is marked, and a plain click on it pins its card.
    const pasted = region.querySelector<HTMLAnchorElement>(`a[href="${OTHER}"]`);
    expect(pasted?.hasAttribute(REF_CARD_PROSE_ATTR)).toBe(true);
    expect((await click(pasted!)).followed).toBe(false);
    await settle(10);
    expect(pinned()?.hasAttribute('data-ref-card')).toBe(true);
    expect(pinned()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 14');
    expect(followed).toEqual([PR]);
  });
});
