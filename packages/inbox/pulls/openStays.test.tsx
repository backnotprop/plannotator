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
 *  - a PR the person hid (in any window) kept open; a deep link to a PR never seen saying anything new;
 *  - a reload (or a restart of the Inbox) on a PR the list no longer names: the page must reopen on it, its diff and
 *    state there (the raw list's copy, else the server's read of it: routePull.ts), and a layer opened from a held
 *    stack's page must open on that stack;
 *  - a PR merged or closed elsewhere (the forge says so at the diff's read, or the server's read) still marked open;
 *  - the forge not answering (offline, down) read as "gone": the page must stay as last read with one line saying so,
 *    and ask again when the window gets its focus back or the browser is back online;
 *  - a merged PR reloaded with only a kept draft comment turning read-only;
 *  - a merged or closed PR's header showing only its small mark (none at all on a phone): it says "Merged" or
 *    "Closed" beside it, its Reviews row's word;
 *  - the launchpad held on a teammate's PR whose ship merged (it left every list) still saying open beside a Reviews
 *    row that says Merged.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer, InboxPullStack } from '@plannotator/core/inbox-types';
import type { InboxShipView } from '@plannotator/core/inbox-pull-handoff';
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
    default: function Reader({ comments }: { comments?: unknown }) {
      const [words, setWords] = useState('');
      return (
        // `data-stub-takes-comments`: the reader was given the comments (it draws them and takes new ones), not read-only.
        <div data-stub-reader="" data-stub-takes-comments={comments ? 'yes' : 'no'} style={{ overflow: 'auto', height: 100 }}>
          <textarea data-stub-comment="" value={words} onChange={(event) => setWords(event.target.value)} />
        </div>
      );
    },
  }));
  // The real Post dialog (its chunk), for Approve.
  await (await import('./platformPostSeam')).realPlatformPost();
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { StackPage } = (hasDom ? await import('../prs/StackPage') : {}) as typeof import('../prs/StackPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { forgetPullThreadStarts } = (hasDom ? await import('./threadStarts') : {}) as typeof import('./threadStarts');
const { resetShipsForTests, shipEvents } = (hasDom ? await import('../data/ships') : {}) as typeof import('../data/ships');
const { learnPullMachines, pullMachine, resetPullMachines } = (hasDom ? await import('./pullMachines') : {}) as typeof import('./pullMachines');

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
/** What the forge says now: the diff read's state, and the server's read of one PR (`/pulls/pull`) by key. */
let forgeState: Record<string, 'merged' | 'closed'> = {};
let serverPull: Record<string, InboxPull> = {};
/** The forge does not answer the server's read of one PR (`unreadable`); `pullReads`: how many times the page asked. */
let forgeQuiet = false;
let pullReads = 0;
/** The forge answers that it has no such PR now (`missing`: deleted, or no longer visible to the person). */
let forgeMissing = false;
/** The diff read fails too (the forge is down and no patch was read since the page opened). */
let diffDown = false;
/** This Inbox's ships (`GET /api/inbox/ships`): what the Reviews row's "Merged <time>" reads. */
let ships: InboxShipView[] = [];
/** What this Inbox answers for a linked computer's read of one PR (asleep, too old, unlinked). */
let farAnswer: { status: number; body: unknown } | null = null;
/** What `POST /api/inbox/pulls/review` answers (Post, Approve); null: it went. */
let reviewAnswer: { status: number; body: unknown } | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  forgetPullThreadStarts();
  resetShipsForTests();
  forgeState = {};
  serverPull = {};
  forgeQuiet = false;
  pullReads = 0;
  forgeMissing = false;
  diffDown = false;
  ships = [];
  farAnswer = null;
  reviewAnswer = null;
  resetPullMachines();
  globalThis.fetch =(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST' && url.pathname.endsWith('/pulls/review') && reviewAnswer) return Response.json(reviewAnswer.body, { status: reviewAnswer.status });
    if (init?.method === 'POST') return Response.json({ ok: true });
    if (url.pathname.endsWith('/api/inbox/ships')) return Response.json({ serverSession: 's', ships, projects: {} });
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: url.searchParams.get('key'), description: null, labels: [], reviewers: [], checks: [], comments: [] });
    if (url.pathname.endsWith('/pulls/diff')) {
      const key = url.searchParams.get('key')!;
      if (diffDown) return Response.json({ error: 'gh could not read the diff.', code: 'pull_diff_failed' }, { status: 502 });
      const patch = 'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -12 +12 @@\n-a\n+b\n';
      return Response.json({ serverSession: 's', key, scope: 'layer', base: 'main', head: 'y', patch, head_sha: SHA, state: forgeState[key] ?? 'open', merged_at: null });
    }
    // A linked computer's read of one PR, through this Inbox (`/api/inbox/m/<id>/pulls/pull`).
    if (url.pathname.startsWith('/api/inbox/m/') && url.pathname.endsWith('/pulls/pull') && farAnswer) return Response.json(farAnswer.body, { status: farAnswer.status });
    if (url.pathname.endsWith('/pulls/pull')) {
      pullReads += 1;
      return Response.json({ serverSession: 's', pull: serverPull[url.searchParams.get('key')!] ?? null, ...(forgeQuiet ? { unreadable: true } : forgeMissing ? { missing: true } : {}) });
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

for (const [what, next, forge, mark] of [
  ['someone merged it and the list no longer names it', () => without(theirs.key), 'merged', 'merged'],
  ['a read comes back without it (a gh blip)', () => ({ ...without(theirs.key), pulls: [] }), null, 'open'],
] as const) {
  test.skipIf(!hasDom)(`the diff stays when ${what}: rail, reader, the comment being written and the scroll`, async () => {
    const before = await openDiff(theirs);
    if (forge) serverPull[theirs.key] = { ...theirs, state: forge, checks: null };
    await act(async () => read(next()));
    await settle();
    expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
    expect($('[data-pull-review]') === before.section && $('[data-stub-reader]') === before.reader).toBe(true);
    expect($<HTMLTextAreaElement>('[data-stub-comment]')!.value).toBe('Cap the backoff at');
    expect(before.reader.scrollTop).toBe(240);
    expect($('.ib-rrail')!.textContent).toBe(before.rail);
    expect(!!$('[data-pull-review-title]')).toBe(true);
    // Merged elsewhere: the server's read of it says so, with the mark it gets everywhere. A blip: nothing new is said.
    expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe(mark);
  });
}

test.skipIf(!hasDom)('merged elsewhere while the list still names it open: the diff read says merged, and the header does', async () => {
  // A PR whose diff this window has not read yet (a diff read a moment ago is drawn again, not read).
  const other = pull(881, { repo: 'northwind/web-app', mine: false, requested: true, author: 'tomas', head: 'ltr', head_sha: SHA });
  forgeState[other.key] = 'merged';
  mount(<PullReview model={{ ...base, pulls: [...base.pulls, other] }} modelError={null} stackId={other.key} layerKey={other.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
});

test.skipIf(!hasDom)('a reload on a merged PR no stack holds reopens its page: the raw list’s copy, else the server’s', async () => {
  // The person's own, merged: still in the raw list.
  mount(<PullReview model={merged(mine.key)} modelError={null} stackId={mine.key} layerKey={mine.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  act(() => root?.unmount());
  host?.remove();
  // A teammate's, merged: no list has it; the server reads it from the forge.
  serverPull[theirs.key] = { ...theirs, state: 'merged', checks: null };
  mount(<PullReview model={without(theirs.key)} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(!!$('[data-stub-reader]')).toBe(true);
  expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
});

const refState = () => $('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state');
async function fire(event: 'focus' | 'online') {
  await act(async () => window.dispatchEvent(new Event(event)));
  await settle();
}

test.skipIf(!hasDom)('the forge not answering: the page stays as last read with one line, asked again on focus and back online', async () => {
  const before = await openDiff(theirs);
  // GitHub down for longer than the sign-in keep: the list stops naming it, and the server's read of it gets no answer.
  forgeQuiet = true;
  serverPull[theirs.key] = { ...theirs, checks: null };
  await act(async () => read(without(theirs.key)));
  await settle();
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
  expect($('[data-stub-reader]') === before.reader && $<HTMLTextAreaElement>('[data-stub-comment]')!.value === 'Cap the backoff at').toBe(true);
  expect(document.querySelectorAll('[data-pull-review-unread]').length).toBe(1);
  expect($('[data-pull-review-unread]')!.textContent).toContain('GitHub');
  // On its own line above the diff, never in the header bar (where a note is cut to fit).
  expect(!!$('.ib-vhead [data-pull-review-unread]')).toBe(false);
  expect(!!$('.ib-gbody > [data-pull-review-unread]')).toBe(true);
  const asked = pullReads;
  await fire('focus');
  expect(pullReads).toBe(asked + 1);
  await fire('online');
  expect(pullReads).toBe(asked + 2);
  // GitHub answers again: merged. The line goes, the header says so, and a focus asks no more.
  forgeQuiet = false;
  serverPull[theirs.key] = { ...theirs, state: 'merged', checks: null };
  await fire('focus');
  expect(!!$('[data-pull-review-unread]')).toBe(false);
  expect(refState()).toBe('merged');
  const answered = pullReads;
  await fire('focus');
  expect(pullReads).toBe(answered);
});

test.skipIf(!hasDom)('a reload while the forge does not answer reopens the page on the server’s kept copy, with the line', async () => {
  forgeQuiet = true;
  serverPull[theirs.key] = { ...theirs, checks: null };
  mount(<PullReview model={without(theirs.key)} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(!!$('[data-stub-reader]')).toBe(true);
  expect(!!$('[data-pull-review-unread]')).toBe(true);
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
});

test.skipIf(!hasDom)('a reload on a merged PR whose only comment is a kept draft: the reader still takes comments, never read-only', async () => {
  // Written here before the merge, not posted, on lines the diff no longer shows as they were.
  const draft = { id: 'c_draft', type: 'comment', scope: 'line', filePath: 'src/retry.ts', lineStart: 12, lineEnd: 12, side: 'new', text: 'Cap the backoff at 30 s', createdAt: 1, outdated: true };
  window.localStorage.setItem(`plannotator-inbox-pull-review:${theirs.key}:layer:${SHA}`, JSON.stringify({ comments: [draft], viewed: [] }));
  serverPull[theirs.key] = { ...theirs, state: 'merged', checks: null };
  mount(<PullReview model={without(theirs.key)} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(refState()).toBe('merged');
  expect($('[data-stub-reader]')!.getAttribute('data-stub-takes-comments')).toBe('yes');
  expect(document.body.textContent!.includes('Cap the backoff at 30 s')).toBe(true);
});

test.skipIf(!hasDom)('merged: everything stays and the header mark says merged, the mark it has everywhere', async () => {
  const before = await openDiff(mine);
  await act(async () => read(merged(mine.key)));
  await settle();
  expect($('[data-stub-reader]') === before.reader && $<HTMLTextAreaElement>('[data-stub-comment]')!.value === 'Cap the backoff at').toBe(true);
  expect($('[data-pull-review-title] .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
  // Its comments stay open with the one being written (the reader not turned read-only); only Post goes.
  expect(!!$('.ib-vcomments')).toBe(true);
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

test.skipIf(!hasDom)('a layer opened from a held stack’s page opens on that stack, not "no longer in the list"', async () => {
  mount(<Stack id={theirs.key} />);
  await settle();
  await act(async () => read(without(theirs.key)));
  await settle();
  expect(!!$('[data-pr-stack-page]')).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  // The layer's own page: the list lacks it and the server has nothing either (a forge blip).
  mount(<PullReview model={without(theirs.key)} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  expect(!!$('[data-stub-reader]')).toBe(true);
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
});

test.skipIf(!hasDom)('a page whose copy is the server’s open one asks again at each list read until it says merged, then no more', async () => {
  // The window's list never named #880 (it has not read since the PR came in): the server's copy, open, is the page's.
  serverPull[theirs.key] = { ...theirs, checks: null };
  let model = without(theirs.key);
  function Page() {
    const [shown, setShown] = useState(model);
    read = setShown;
    return <PullReview model={shown} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
  }
  mount(<Page />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(refState()).toBe('open');
  // Its author merges it; the window reads its list again (still without it).
  serverPull[theirs.key] = { ...theirs, state: 'merged', checks: null };
  model = { ...model };
  await act(async () => read(model));
  await settle();
  expect(refState()).toBe('merged');
  // Merged is final: the next list read asks nothing.
  const asked = pullReads;
  await act(async () => read({ ...model }));
  await settle();
  expect(pullReads).toBe(asked);
});

test.skipIf(!hasDom)('opened while GitHub does not answer (an offline restart), then back online: the page stays and says merged', async () => {
  // The Inbox restarted offline: its list names nothing, its kept copy is the page's, the diff cannot be read.
  forgeQuiet = true;
  diffDown = true;
  serverPull[theirs.key] = { ...theirs, state: 'merged', checks: null };
  const offline: InboxPullsAnswer = { ...base, pulls: [] };
  function Page() {
    const [shown, setShown] = useState(offline);
    read = setShown;
    return <PullReview model={shown} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
  }
  mount(<Page />);
  await settle(20);
  expect(!!$('[data-pull-review-unread]')).toBe(true);
  expect(refState()).toBe('merged');
  // Back online: the window's list reads again (signed in, the PR still gone from it), and a focus.
  forgeQuiet = false;
  diffDown = false;
  await act(async () => read({ ...base, pulls: base.pulls.filter((p) => p.key !== theirs.key) }));
  await fire('focus');
  await settle(20);
  expect(!!$('[data-pull-review-unread]')).toBe(false);
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
  expect(refState()).toBe('merged');
});

test.skipIf(!hasDom)('the forge saying it has no such PR any more: the page stays as its last read and says so', async () => {
  serverPull[theirs.key] = { ...theirs, checks: null };
  let model = without(theirs.key);
  function Page() {
    const [shown, setShown] = useState(model);
    read = setShown;
    return <PullReview model={shown} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
  }
  mount(<Page />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(!!$('[data-pull-review-missing]')).toBe(false);
  expect(!!$('[data-review-posts]')).toBe(true);
  await write('[data-stub-comment]', 'Cap the backoff at');
  // Its repository deleted (or the person lost access): the forge answers 404, and the server kept nothing for it.
  forgeMissing = true;
  delete serverPull[theirs.key];
  model = { ...model };
  await act(async () => read(model));
  await settle(20);
  expect(!!$('[data-stub-reader]')).toBe(true);
  expect(document.body.textContent!.includes('no longer in the list')).toBe(false);
  expect($('[data-pull-review-missing]')?.textContent).toContain('GitHub');
  expect(!!$('[data-pull-review-unread]')).toBe(false);
  // Only a last read now: no Post, no Approve, though the copy shown still says open.
  expect(!!$('[data-review-posts]')).toBe(false);
  // Its comments stay the person's: the reader still takes them, the one being written too.
  expect($('[data-stub-reader]')!.getAttribute('data-stub-takes-comments')).toBe('yes');
  expect($<HTMLTextAreaElement>('[data-stub-comment]')!.value).toBe('Cap the backoff at');
});

test.skipIf(!hasDom)('closed elsewhere, then reopened: Closed without Post, then open with Post back, though the diff read before still said closed', async () => {
  // Closed on GitHub: no list names it; the page's read of it and its diff's read say closed (a reload: nothing held).
  forgeState[theirs.key] = 'closed';
  serverPull[theirs.key] = { ...theirs, state: 'closed', checks: null };
  let model = without(theirs.key);
  function Page() {
    const [shown, setShown] = useState(model);
    read = setShown;
    return <PullReview model={shown} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
  }
  mount(<Page />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(refState()).toBe('closed');
  expect(!!$('[data-review-posts]')).toBe(false);
  // Reopened, still in no list (a teammate's no longer asked of the person): closed is not final, so the next list
  // read asks again, and the forge's answer now (open) outranks the diff read's closed.
  serverPull[theirs.key] = { ...theirs, checks: null };
  model = { ...model };
  await act(async () => read(model));
  await settle(20);
  expect(refState()).toBe('open');
  expect(!!$('[data-review-posts]')).toBe(true);
  // Closed again and back in the list, open (reopened once more): the list's word, whatever the diff read said.
  serverPull[theirs.key] = { ...theirs, state: 'closed', checks: null };
  await act(async () => read({ ...model }));
  await settle(20);
  expect(refState()).toBe('closed');
  await act(async () => read(base));
  await settle(20);
  expect(refState()).toBe('open');
  expect(!!$('[data-review-posts]')).toBe(true);
});

/** A teammate's PR no page here has drawn or read before (the pages' held stacks and read patches last the module). */
const unseen = (n: number) => pull(n, { repo: 'northwind/web-app', mine: false, requested: true, author: 'tomas', head: `branch-${n}`, head_sha: SHA });

const dialogButton = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === words)!;

test.skipIf(!hasDom)('Approve on a held copy merged elsewhere since: refused, and the page says Merged with no Post', async () => {
  const held = unseen(894);
  serverPull[held.key] = { ...held, checks: null };
  mount(<PullReview model={base} modelError={null} stackId={held.key} layerKey={held.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  await settle();
  expect(refState()).toBe('open');
  // Its author merges it now: the server asks the forge before posting, and refuses.
  serverPull[held.key] = { ...held, state: 'merged', merged_at: '2026-11-03T10:00:00.000Z', checks: null };
  reviewAnswer = { status: 409, body: { error: 'That pull request is no longer open.', code: 'pull_closed' } };
  await act(async () => $('[data-review-posts] [data-decision-primary]')!.click());
  await settle();
  // The summary the person wrote for it: kept when the dialog goes with Post, as a comment of the review's own.
  await write('[role="dialog"] textarea', 'Ship it once the retry cap lands.');
  await act(async () => dialogButton('Approve').click());
  await settle(20);
  expect(refState()).toBe('merged');
  expect(!!$('[data-review-posts]')).toBe(false);
  expect(!!$('[role="dialog"]')).toBe(false);
  const kept = JSON.parse(window.localStorage.getItem(`plannotator-inbox-pull-review:${held.key}:layer:${SHA}`) ?? '{"comments":[]}') as { comments: { scope?: string; text: string }[] };
  expect(kept.comments.map((c) => [c.scope, c.text])).toEqual([['general', 'Ship it once the retry cap lands.']]);
  expect(!!$('[aria-label="Comments, 1"]')).toBe(true);
});

test.skipIf(!hasDom)('the forge not answering and no patch of it ever read here: the diff’s own error, and no line claiming a last read', async () => {
  const fresh = unseen(891);
  forgeQuiet = true;
  diffDown = true;
  serverPull[fresh.key] = { ...fresh, state: 'merged', checks: null };
  mount(<PullReview model={base} modelError={null} stackId={fresh.key} layerKey={fresh.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  await settle(20);
  expect(refState()).toBe('merged');
  expect(!!$('[data-pull-diff-error]')).toBe(true);
  expect(!!$('[data-pull-review-unread]')).toBe(false);
});

for (const [what, answer, want] of [
  ['the linked computer that lists it is asleep', { status: 503, body: { error: 'Mac mini cannot be reached now.', code: 'machine_offline' } }, 'Mac mini cannot be reached now.'],
  ['the linked computer cannot be reached (502)', { status: 502, body: { error: 'Could not reach Mac mini: connection refused. Is its Inbox running?', code: 'machine_unreachable' } }, 'Could not reach Mac mini: connection refused. Is its Inbox running?'],
  ['the linked computer runs an older Inbox without this read', { status: 404, body: { error: 'Not a door route.', code: 'not_found' } }, 'This pull request is no longer in the list.'],
  ['the linked computer was unlinked since: this computer answers', { status: 404, body: { error: 'That machine is not linked.', code: 'machine_not_linked' } }, 'This pull request is no longer in the list.'],
] as const) {
  test.skipIf(!hasDom)(`no copy to show and ${what}: the page comes to rest with words, never reading for ever`, async () => {
    const far = unseen(892);
    // That computer's board named it once (this window remembers whose it is); none names it now.
    learnPullMachines({ ...base, pulls: [{ ...far, machine: 'ibx_01JZ0000000000000000000000' }] });
    farAnswer = answer;
    mount(<PullReview model={base} modelError={null} stackId={far.key} layerKey={far.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
    await settle(20);
    expect($('.ib-pr-empty')!.textContent).toBe(want);
    if (answer.body.code === 'machine_not_linked') expect(pullMachine(far.key)).toBeNull();
  });
}

test.skipIf(!hasDom)('no copy to show and the forge not answering: the list’s own line for it, asked again on focus', async () => {
  const quiet = unseen(893);
  forgeQuiet = true;
  mount(<PullReview model={base} modelError={null} stackId={quiet.key} layerKey={quiet.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  await settle(20);
  expect($('.ib-pr-empty')!.textContent).toBe("GitHub didn't answer; its pull requests aren't shown.");
  const asked = pullReads;
  await fire('focus');
  expect(pullReads).toBe(asked + 1);
});

/** A phone's window for `run` (usePhone's media queries), the desktop's again after. */
async function onPhone(run: () => Promise<void>) {
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  try {
    await run();
  } finally {
    window.matchMedia = saved;
  }
}

/** The header's state word and the mark beside it, as the person sees them (`where`: the desktop's title or a phone's). */
const headerState = (where: string) => ({ word: $(`${where} [data-pull-review-state]`)?.textContent?.replace(/[\s·]+$/, '') ?? null, mark: $(`${where} .ib-refmark`)?.getAttribute('data-ref-state') ?? null });

test.skipIf(!hasDom)('merged or closed: the header says so in words beside its mark, its Reviews row’s word, a phone’s header too; an open PR’s says nothing new', async () => {
  const closed = (key: string): InboxPullsAnswer => ({ ...base, pulls: base.pulls.map((p) => (p.key === key ? { ...p, state: 'closed' } : p)) });
  for (const [model, want] of [
    [merged(mine.key), 'Merged'],
    [closed(mine.key), 'Closed'],
  ] as const) {
    mount(<PullReview model={model} modelError={null} stackId={mine.key} layerKey={mine.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
    for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
    expect(headerState('[data-pull-review-title]')).toEqual({ word: want, mark: want.toLowerCase() });
    // A screen reader hears it first, as the eye reads it.
    expect($('[data-pull-review-title]')!.getAttribute('aria-label')!.startsWith(`${want}, `)).toBe(true);
    act(() => root?.unmount());
    host?.remove();
  }
  await onPhone(async () => {
    mount(<PullReview model={merged(mine.key)} modelError={null} stackId={mine.key} layerKey={mine.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
    for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
    expect(headerState('[data-pull-details-button]')).toEqual({ word: 'Merged', mark: 'merged' });
    act(() => root?.unmount());
    host?.remove();
    // Open on a phone: no mark and no word, as before.
    mount(<PullReview model={base} modelError={null} stackId={mine.key} layerKey={mine.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
    for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
    expect(headerState('[data-pull-details-button]')).toEqual({ word: null, mark: null });
  });
  act(() => root?.unmount());
  host?.remove();
  mount(<PullReview model={base} modelError={null} stackId={mine.key} layerKey={mine.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />);
  for (let i = 0; i < 40 && !$('[data-stub-reader]'); i += 1) await settle(2);
  expect(headerState('[data-pull-review-title]')).toEqual({ word: null, mark: 'open' });
});

test.skipIf(!hasDom)('a teammate’s PR whose ship merged, gone from every list: its held launchpad says Merged, as its Reviews row does', async () => {
  mount(<Reviews stackId={theirs.key} />);
  await settle();
  expect($('[data-launchpad] .ib-lp-bar .ib-refmark')!.getAttribute('data-ref-state')).toBe('open');
  expect(!!$('[data-launch-state]')).toBe(false);
  // The agent shipping it merged it: the ship's record says merged (the row's "Merged <time>"), and no list names it.
  const at = new Date(Date.now() - 120_000).toISOString();
  ships = [{ id: 'shp_880', key: theirs.key, url: theirs.url, title: theirs.title, number: 880, repo: theirs.repo, host: 'github.com', thread_id: 'thr_880', project_id: 'prj_2', agent: { host: 'claude-code', session: 'ses_web', name: 'Claude Code' }, started_at: at, state: 'merged', reason: null, ended_at: at, merged_at: at } as InboxShipView];
  await act(async () => read(without(theirs.key)));
  // This Inbox says its ships changed (`event: ships`): the window reads them again.
  await act(async () => shipEvents.emit());
  await settle();
  expect(!!$('[data-launchpad]')).toBe(true);
  expect($('[data-launchpad] .ib-lp-bar .ib-refmark')!.getAttribute('data-ref-state')).toBe('merged');
  expect($('[data-launch-state]')!.textContent).toBe('Merged');
});
