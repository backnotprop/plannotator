/**
 * What is open stays open (the owner, 2026-11-23: "If I'm ever in a thread, if I ever create a thread for any PR … it
 * should never disappear on me no matter what … that my diff while I'm viewing diffs or refresh it just goes away").
 * The PR pages hold the last stack they drew (keptStack.ts), with the Inbox's doors stubbed at `fetch` and the diff
 * reader stubbed by one that keeps its own half-written comment and scroll. What regresses:
 *
 *  - a list read that no longer names the open PR (someone merged it, a gh blip) replacing its diff, rail and comments
 *    with "This pull request is no longer in the list.": the comment being written and the scroll go with them;
 *  - the PR merged or closed and the page not saying so in place, with the state mark it gets everywhere else;
 *  - the Reviews pane falling back to "Pick a review to open it." or the board, its "Start a thread" words lost;
 *  - a stack's own page turning into "This stack isn't open any more";
 *  - a PR the person hid (in any window) kept open; a deep link to a PR never seen saying anything new.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer, InboxPullStack } from '@plannotator/core/inbox-types';
import { pull } from './pullReviewFixtures';
import { pullsStateOf } from './reviewsTestState';
import type { PullsPageProps } from './PullsPage';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const seam: string = '../guide/PullChangesTree.tsx';
  const { PullChangesTree } = (await import(seam)) as Record<string, unknown>;
  mock.module('#guide-reader', () => ({
    PullChangesTree,
    // The reader: what the person is writing in it and where they scrolled are its own, so they last as long as it does.
    default: function Reader() {
      const [words, setWords] = useState('');
      return (
        <div data-stub-reader="" style={{ overflow: 'auto', height: 100 }}>
          <textarea data-stub-comment="" value={words} onChange={(event) => setWords(event.target.value)} />
        </div>
      );
    },
  }));
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { StackPage } = (hasDom ? await import('../prs/StackPage') : {}) as typeof import('../prs/StackPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { forgetPullThreadStarts } = (hasDom ? await import('./threadStarts') : {}) as typeof import('./threadStarts');

const SHA = 'a'.repeat(40);
/** Someone else's PR the person was asked to review: once merged, no search of theirs lists it any more. */
const theirs = pull(880, { repo: 'northwind/web-app', mine: false, requested: true, author: 'tomas', head: 'rtl', head_sha: SHA });
/** The person's own: merged, it stays in the raw list (author:@me merged), out of every stack. */
const mine = pull(412, { head: 'retry/schedule', head_sha: SHA });
const base: InboxPullsAnswer = {
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [theirs, mine],
  links: {},
  projects: { 'github.com/northwind/billing-svc': ['prj_1'], 'github.com/northwind/web-app': ['prj_2'] },
  cards: {},
};
const without = (key: string, model = base): InboxPullsAnswer => ({ ...model, pulls: model.pulls.filter((p) => p.key !== key) });
const merged = (key: string, model = base): InboxPullsAnswer => ({ ...model, pulls: model.pulls.map((p) => (p.key === key ? { ...p, state: 'merged', merged_at: '2026-11-03T10:00:00.000Z' } : p)) });
const hidden = (p: InboxPull, model = base): InboxPullsAnswer => ({ ...without(p.key, model), hidden: [{ key: p.key, title: p.title, url: p.url, at: '2026-11-03T10:00:00.000Z' }] });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  forgetPullThreadStarts();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') return Response.json({ ok: true });
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: url.searchParams.get('key'), description: null, labels: [], reviewers: [], checks: [], comments: [] });
    if (url.pathname.endsWith('/pulls/diff')) {
      const key = url.searchParams.get('key')!;
      const patch = 'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -12 +12 @@\n-a\n+b\n';
      return Response.json({ serverSession: 's', key, scope: 'layer', base: 'main', head: 'y', patch, head_sha: SHA });
    }
    if (url.pathname.endsWith('/api/inbox/sessions')) {
      return Response.json({
        serverSession: 's',
        home: '/home/dana',
        projects: [{ project: { id: 'prj_2', name: 'web-app', root: '/home/dana/web-app' }, sessions: [{ session: 'ses_web', host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:29:00.000Z', busy: false, idle_since: null, last_thread: null }] }],
        launch: { agents: [], projects: [] },
      });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">{node}</div>
      </SidebarProvider>,
    );
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
/** The list as the window last read it: `read` is the next read landing. */
let read: (next: InboxPullsAnswer) => void = () => {};

async function write(selector: string, value: string) {
  const field = $<HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function Review({ layer }: { layer: InboxPull }) {
  const [model, setModel] = useState(base);
  read = setModel;
  return <PullReview model={model} modelError={null} stackId={layer.key} layerKey={layer.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
}

/** A PR's diff open, a comment half written, scrolled down: what the page holds before the next read. */
async function openDiff(layer: InboxPull) {
  mount(<Review layer={layer} />);
  // The reader is a chunk loaded on first use.
  for (let i = 0; i < 40 && !$('[data-stub-comment]'); i += 1) await settle(2);
  expect(!!$('[data-stub-comment]')).toBe(true);
  await write('[data-stub-comment]', 'Cap the backoff at');
  const reader = $('[data-stub-reader]')!;
  reader.scrollTop = 240;
  return { reader, section: $('[data-pull-review]')!, rail: $('.ib-rrail')!.textContent };
}

for (const [what, next] of [
  ['someone merged it and the list no longer names it', () => without(theirs.key)],
  ['a read comes back without it (a gh blip)', () => ({ ...without(theirs.key), pulls: [] })],
] as const) {
  test.skipIf(!hasDom)(`the diff stays when ${what}: rail, reader, the comment being written and the scroll`, async () => {
    const before = await openDiff(theirs);
    await act(async () => read(next()));
    await settle();
    expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
    expect($('[data-pull-review]') === before.section && $('[data-stub-reader]') === before.reader).toBe(true);
    expect($<HTMLTextAreaElement>('[data-stub-comment]')!.value).toBe('Cap the backoff at');
    expect(before.reader.scrollTop).toBe(240);
    expect($('.ib-rrail')!.textContent).toBe(before.rail);
    expect(!!$('[data-pull-review-title]')).toBe(true);
    // Nothing new is said: the mark is the open PR's as it was.
    expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('open');
  });
}

test.skipIf(!hasDom)('merged: everything stays and the header mark says merged, the mark it has everywhere', async () => {
  const before = await openDiff(mine);
  await act(async () => read(merged(mine.key)));
  await settle();
  expect($('[data-stub-reader]') === before.reader && $<HTMLTextAreaElement>('[data-stub-comment]')!.value === 'Cap the backoff at').toBe(true);
  expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
});

test.skipIf(!hasDom)('hidden in another window: the review closes as Hide does; a PR never seen keeps today’s words', async () => {
  await openDiff(theirs);
  await act(async () => read(hidden(theirs)));
  await settle();
  expect(!!$('[data-stub-reader]')).toBe(false);
  act(() => root?.unmount());
  host?.remove();
  root = null;
  mount(<PullReview model={base} modelError={null} stackId="github.com/northwind/web-app#999" layerKey="github.com/northwind/web-app#999" scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  await settle();
  expect($('.ib-pr-empty')!.textContent).toBe('This pull request is no longer in the list.');
});

function Reviews({ stackId }: { stackId: string }) {
  const [model, setModel] = useState(base);
  read = setModel;
  const props: PullsPageProps = {
    state: pullsStateOf(model),
    stackId,
    project: null,
    filter: 'all',
    projects: [],
    projectNames: new Map(),
    phone: false,
    onOpenStack: () => {},
    onScope: () => {},
    onReview: () => {},
    onOpenThread: () => {},
    onNew: () => {},
    onNewReview: () => {},
  };
  return <PullsPage {...props} />;
}

test.skipIf(!hasDom)('Reviews: the open PR stays in its pane, its Start a thread words too, and says merged in its bar', async () => {
  mount(<Reviews stackId={theirs.key} />);
  await settle();
  expect(!!$('[data-launchpad]')).toBe(true);
  await act(async () => $('[data-launch-go="start-thread"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  await write('[data-pull-thread-start] textarea', 'Why does the picker flip in RTL?');
  const pane = $('[data-pull-thread-start]');
  // Merged by its author: the person's searches no longer return it.
  await act(async () => read(without(theirs.key)));
  await settle();
  expect(!!$('[data-pulls-pane-empty]') || document.body.textContent!.includes('Pick a review')).toBe(false);
  expect($('[data-pull-thread-start]') === pane && $<HTMLTextAreaElement>('[data-pull-thread-start] textarea')!.value === 'Why does the picker flip in RTL?').toBe(true);
  // The person's own PR, merged: the launchpad stays and its bar's mark turns merged.
  act(() => root?.unmount());
  host?.remove();
  root = null;
  mount(<Reviews stackId={mine.key} />);
  await settle();
  expect(!!$('[data-launchpad]')).toBe(true);
  await act(async () => read(merged(mine.key)));
  await settle();
  expect(!!$('[data-launchpad]')).toBe(true);
  expect($('[data-launchpad] .ib-lp-bar .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  expect(!!$('[data-pulls-pane-empty]')).toBe(false);
});

function Stack({ id }: { id: string }) {
  const [model, setModel] = useState(base);
  read = setModel;
  const stacks: InboxPullStack[] = [];
  for (const p of model.pulls) if (p.state === 'open') stacks.push({ id: p.key, platform: p.platform, host: p.host, repo: p.repo, layers: [p], parents: {}, base: p.base, open_base: p.base } as InboxPullStack);
  const stack = stacks.find((s) => s.id === id) ?? null;
  return <StackPage stack={stack} id={id} loading={false} board={model} repoLabel={stack ? stack.repo : null} phone={false} onBack={() => {}} onOpenLayer={() => {}} />;
}

test.skipIf(!hasDom)('a stack’s own page stays with its layers when they merge, never "isn’t open any more"', async () => {
  mount(<Stack id={mine.key} />);
  await settle();
  const page = $('[data-pr-stack-page]');
  expect(page!.getAttribute('data-pr-stack-page')).toBe(mine.key);
  await act(async () => read(merged(mine.key)));
  await settle();
  expect(document.body.textContent!.includes('open any more')).toBe(false);
  expect($('[data-pr-stack-page]') === page).toBe(true);
  expect($(`[data-pr-layer="${CSS.escape(mine.key)}"]`)!.getAttribute('data-state')).toBe('merged');
  expect($('.ib-prst-repo')!.textContent).toBe('/ northwind/billing-svc');
});
