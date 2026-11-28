/**
 * Hide a pull request (hiddenPulls.ts): the board's select bar (Hide N), a tile's popover, and Reviews' row menu and
 * Hidden fold. What regresses:
 *  - a hidden PR staying on the board (or in its "need you" count) until the next read;
 *  - Hide asking the forge for anything, or several PRs sent as several writes;
 *  - no toast, or a toast with no Undo; Undo showing anything but what that Hide hid;
 *  - a refused write leaving the PRs gone;
 *  - Reviews' row menu hiding something other than the row's own open PRs (a merged layer included), or its body not
 *    being the list's (the bands must stay `.ib-lbody`'s children); Hidden's Show again not reaching the page, losing
 *    focus, or a hidden PR's thread out of reach;
 *  - the Inbox list's Hide (a thread row's menu, the picks) sending anything but the threads, or an Undo that shows
 *    other PRs than the ones it hid;
 *  - a hidden PR losing its review thread in a thread's PR list.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh: the window's fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { boardInProject } from '../prs/sheetModel';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullHidden, InboxPullsAnswer, InboxReviewRow } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import type { SheetPageProps } from '../prs/SheetPage';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('../prs/SheetPage') : {}) as typeof import('../prs/SheetPage');
const { ReviewsList, ReviewsMenu, reviewLinksOf, rowPulls } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');
const { pullReviewLinks } = (hasDom ? await import('../threadPulls/model') : {}) as typeof import('../threadPulls/model');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const hidden = (hasDom ? await import('./hiddenPulls') : {}) as typeof import('./hiddenPulls');
const { reviewsOfPulls } = (hasDom ? await import('./reviewsTestState') : {}) as typeof import('./reviewsTestState');

const NOW = Date.parse('2026-11-17T12:00:00Z');

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/ledger';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'jun',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    head_sha: String(number).padStart(40, 'a'),
    additions: number,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: ['dana'],
    checks: 'success',
    conflicts: false,
    updated_at: '2026-11-16T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

// ledger: #7 and #8 ask for the person's review, #9 is theirs; web: #20 asks for it too.
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-17T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(7), pull(8), pull(9, { mine: true, requested: false, review: 'approved' }), pull(20, { repo: 'northwind/web' })],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'], 'github.com/northwind/web': ['prj_web'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
  hidden: [],
};
const key = (n: number, repo = 'northwind/ledger') => `github.com/${repo}#${n}`;
const WEB20 = key(20, 'northwind/web');

/** Every write to the window's routes, in order, each answered when the test says. */
let sent: { url: string; body: Record<string, unknown>; answer: (status: number, body: Record<string, unknown>) => void }[] = [];
let toasts: { toast: Omit<InboxToastModel, 'id'>; ms: number }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  sent = [];
  toasts = [];
  hidden.forgetHiddenChanges();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({});
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Promise<Response>((resolve) => {
      sent.push({ url: String(url), body, answer: (status, answer) => resolve(Response.json(answer, { status })) });
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  hidden.forgetHiddenChanges();
});

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const click = (el: HTMLElement) => act(() => el.click());
const tile = (k: string) => $(`[data-pr-tile="${k}"]`);
const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox">{node}</div>));
}

/** The board over the list as useSheetPulls hands it: what was hidden here already left. */
function Board(over: Partial<SheetPageProps>) {
  const changes = hidden.useHiddenChanges();
  const props: SheetPageProps = {
    mode: 'pane',
    model: hidden.pullsShown(MODEL, changes),
    error: null,
    loading: false,
    phone: false,
    view: 'open',
    risk: {},
    now: NOW,
    layout: 'grid',
    onLayout: () => {},
    onView: () => {},
    onOpenPull: () => {},
    onOpenStack: () => {},
    onMerged: () => {},
    onToast: (toast, ms) => toasts.push({ toast, ms }),
    ...over,
  };
  return (
    <SidebarProvider>
      <SheetPage {...props} />
    </SidebarProvider>
  );
}

test('Hide N: every pick leaves the board and its "need you" at once, in one write that asks nothing of the forge; the toast has Undo', async () => {
  if (!hasDom) return;
  mount(<Board />);
  expect($('[data-pr-summary]')!.textContent).toContain('3 need you');
  click($('[data-pr-select="select"]')!);
  for (const k of [key(7), WEB20]) click(tile(k)!);
  const hide = $('[data-pr-hide]')!;
  expect(hide.textContent).toContain('2');
  click(hide);
  // Gone before the write is even answered.
  expect(tile(key(7))).toBeNull();
  expect(tile(WEB20)).toBeNull();
  expect($('[data-pr-summary]')!.textContent).toContain('1 need you');
  expect(sent.map((s) => [new URL(s.url, 'http://x').pathname, s.body.hide, s.body.show])).toEqual([
    [
      '/api/inbox/pulls/hidden',
      [
        { key: key(7), title: 'Change 7', url: pull(7).url },
        { key: WEB20, title: 'Change 20', url: pull(20, { repo: 'northwind/web' }).url },
      ],
      [],
    ],
  ]);
  sent[0]!.answer(200, { hidden: [] });
  await settle();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast).toMatchObject({ icon: 'check', noKey: true });
  expect(toasts[0]!.toast.lead).toContain('2');
  expect(toasts[0]!.toast.detail).toContain('GitHub');
  // Nothing is left picked: select mode ends with the Hide.
  expect($('[data-pr-select="select"]')).not.toBeNull();
  expect($('[data-pr-hide]')).toBeNull();
  // The picks it hid let go; Undo shows exactly those again.
  act(() => toasts[0]!.toast.onUndo!());
  expect(sent[1]!.body).toMatchObject({ hide: [], show: [key(7), WEB20] });
  sent[1]!.answer(200, { hidden: [] });
  await settle();
  expect(tile(key(7))).not.toBeNull();
  expect(tile(WEB20)).not.toBeNull();
  expect(toasts.at(-1)!.toast).toMatchObject({ icon: 'check' });
  expect(toasts.at(-1)!.toast.lead).toContain('2');
});

test('a refused Hide puts the PRs back and says why', async () => {
  if (!hasDom) return;
  mount(<Board />);
  click($('[data-pr-select="select"]')!);
  click(tile(key(8))!);
  click($('[data-pr-hide]')!);
  expect(tile(key(8))).toBeNull();
  sent[0]!.answer(409, { error: 'Code review is off.', code: 'code_review_off' });
  await settle();
  expect(tile(key(8))).not.toBeNull();
  expect(toasts.at(-1)!.toast).toMatchObject({ icon: 'warn' });
});

test("a tile's popover hides that PR only (a phone's sheet)", async () => {
  if (!hasDom) return;
  mount(<Board phone />);
  click(tile(key(9))!);
  click($('[data-pr-pop-hide]')!);
  expect(sent.map((s) => s.body.hide)).toEqual([[{ key: key(9), title: 'Change 9', url: pull(9).url }]]);
  expect($('[data-pr-pop]')).toBeNull();
  expect(tile(key(9))).toBeNull();
  expect(tile(key(7))).not.toBeNull();
});

test("Hide repository, from a Grid section's header and from a Table group's header: the repository leaves the board and its head line at once, in one write naming it; Undo shows it again", async () => {
  if (!hasDom) return;
  for (const layout of ['grid', 'table'] as const) {
    sent.length = 0;
    toasts.length = 0;
    mount(<Board layout={layout} />);
    expect($('[data-pr-summary]')!.textContent).toContain('in 2 repositories');
    click($('[data-pr-repo-hide="github.com/northwind/ledger"]')!);
    expect($('[data-pr-repo="github.com/northwind/ledger"]')).toBeNull();
    expect($('[data-pr-repo="github.com/northwind/web"]')).not.toBeNull();
    expect($('[data-pr-summary]')!.textContent).toContain('1 open in 1 repository');
    expect(sent.map((s) => [new URL(s.url, 'http://x').pathname, s.body.hide_repos])).toEqual([['/api/inbox/pulls/hidden', [{ key: 'github.com/northwind/ledger', label: 'ledger' }]]]);
    sent[0]!.answer(200, { hidden: [], hid: [], threads_left: [] });
    await settle();
    expect(toasts).toHaveLength(1);
    // It names the repository only: a repository's hide takes no thread out of the Inbox list.
    expect(toasts[0]!.toast.lead).toContain('ledger');
    expect(toasts[0]!.toast.lead).not.toContain('thread');
    act(() => toasts[0]!.toast.onUndo!());
    expect(sent[1]!.body).toMatchObject({ show_repos: ['github.com/northwind/ledger'] });
    sent[1]!.answer(200, { hidden: [] });
    await settle();
    expect($('[data-pr-repo="github.com/northwind/ledger"]')).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    hidden.forgetHiddenChanges();
  }
});

test("Reviews' project filter: picks the board no longer shows are let go, and do not come back when the filter is cleared", () => {
  if (!hasDom) return;
  let setProject: (project: string | null) => void = () => {};
  function Filtered() {
    const [project, set] = useState<string | null>(null);
    setProject = set;
    const changes = hidden.useHiddenChanges();
    return <Board project={project} model={boardInProject(hidden.pullsShown(MODEL, changes)!, project)} />;
  }
  mount(<Filtered />);
  click($('[data-pr-select="select"]')!);
  for (const k of [key(7), WEB20]) click(tile(k)!);
  expect($('[data-pr-hide]')!.textContent).toContain('2');
  act(() => setProject('prj_web'));
  expect(tile(key(7))).toBeNull();
  expect($('[data-pr-hide]')!.textContent).toContain('1');
  act(() => setProject(null));
  expect(tile(key(7))).not.toBeNull();
  expect($('[data-pr-hide]')!.textContent).toContain('1');
  expect(tile(key(7))!.getAttribute('aria-checked')).toBe('false');
});

test("Reviews' Hidden lists a hidden repository, and its Show again shows that repository", () => {
  if (!hasDom) return;
  const repos: string[] = [];
  const answer = { ...reviewsOfPulls(MODEL), hidden_repos: [{ key: 'github.com/northwind/web', label: 'web', at: '2026-11-17T10:00:00.000Z' }] };
  mount(
    <div className="ib-lbody">
      <ReviewsList answer={answer} model={MODEL} rows={answer.rows} filter="all" projectNames={new Map()} selected={null} phone={false} onOpen={() => {}} onNew={() => {}} onShowAgain={() => {}} onShowRepo={(repo) => repos.push(repo.key)} />
    </div>,
  );
  expect($('[data-pulls-hidden]')!.getAttribute('data-pulls-hidden')).toBe('1');
  click($('[data-pulls-hidden-toggle]')!);
  expect($('[data-pulls-hidden-repo="github.com/northwind/web"]')!.textContent).toContain('web');
  click($(`[data-pulls-show-again="${hidden.repoChangeKey('github.com/northwind/web')}"]`)!);
  expect(repos).toEqual(['github.com/northwind/web']);
});

test("Reviews: a row's menu hides the row's open PRs; Hidden lists what is hidden, and Show again reaches the page", async () => {
  if (!hasDom) return;
  const answer = { ...reviewsOfPulls(MODEL), hidden: [{ key: key(5), title: 'Old change', url: pull(5).url, at: '2026-11-16T10:00:00.000Z', thread_id: 'thr_old' }] satisfies InboxPullHidden[] };
  const hid: InboxPull[][] = [];
  const shown: string[] = [];
  const threads: string[] = [];
  mount(
    <ReviewsMenu className="ib-lbody" rows={answer.rows} links={reviewLinksOf(MODEL, answer)} phone={false} onTarget={() => {}} onHide={(pulls) => hid.push(pulls)}>
      <ReviewsList
        answer={answer}
        model={MODEL}
        rows={answer.rows}
        filter="all"
        projectNames={new Map()}
        selected={null}
        phone={false}
        onOpen={() => {}}
        onNew={() => {}}
        onShowAgain={(h) => shown.push(h.key)}
        onOpenThread={(id) => threads.push(id)}
      />
    </ReviewsMenu>,
  );
  // The menu's trigger is the list's body itself: every band and the Hidden fold are its own children.
  const groups = [...document.querySelectorAll<HTMLElement>('.ib-group')];
  expect(groups.length).toBeGreaterThan(1);
  for (const group of groups) expect(group.parentElement!.classList.contains('ib-lbody')).toBe(true);

  const row = answer.rows.find((r) => r.pull_keys.includes(key(8)))!;
  await act(async () => {
    $(`[data-reviews-row="${row.id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
  await act(async () => $('[data-reviews-hide]')!.click());
  expect(hid.map((pulls) => pulls.map((p) => p.key))).toEqual([[key(8)]]);

  // Hidden: closed at first, at the end of the list; a hidden PR with a thread opens it.
  const fold = $('[data-pulls-hidden-toggle]')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  click(fold);
  const hiddenRow = $(`[data-pulls-hidden-row="${key(5)}"]`)!;
  expect(hiddenRow.textContent).toContain('#5');
  expect(hiddenRow.textContent).toContain('Old change');
  click($('[data-pulls-hidden-thread="thr_old"]')!);
  expect(threads).toEqual(['thr_old']);
  const again = $(`[data-pulls-show-again="${key(5)}"]`)!;
  // Its name holds the words it shows (WCAG 2.5.3).
  expect(again.getAttribute('aria-label')!).toContain(again.textContent!);
  click(again);
  expect(shown).toEqual([key(5)]);
});

test("a row's Hide takes its open PRs only: a merged layer of its stack is not hidden again", () => {
  if (!hasDom) return;
  const merged = pull(30, { state: 'merged', merged_at: '2026-11-16T10:00:00.000Z' });
  const open = pull(31, { base: 'b30' });
  const row = { pull_keys: [merged.key, open.key], stacks: [{ layers: [merged, open] }] } as unknown as InboxReviewRow;
  expect(rowPulls(row).map((p) => p.key)).toEqual([open.key]);
});

test('Show again: focus goes to the next hidden PR, then to the fold once none is left', async () => {
  if (!hasDom) return;
  const records: InboxPullHidden[] = [5, 6].map((n) => ({ key: key(n), title: `Old ${n}`, url: pull(n).url, at: `2026-11-16T1${n}:00:00.000Z` }));
  function Hidden() {
    const changes = hidden.useHiddenChanges();
    const answer = hidden.reviewsShown({ ...reviewsOfPulls(MODEL), hidden: records }, changes)!;
    return (
      <div className="ib-lbody">
        <ReviewsList answer={answer} model={MODEL} rows={answer.rows} filter="all" projectNames={new Map()} selected={null} phone={false} onOpen={() => {}} onNew={() => {}} onShowAgain={(h) => void hidden.showPulls([h.key])} />
      </div>
    );
  }
  mount(<Hidden />);
  click($('[data-pulls-hidden-toggle]')!);
  const first = $(`[data-pulls-show-again="${key(6)}"]`)!;
  first.focus();
  click(first);
  await settle(50);
  expect(document.activeElement).toBe($(`[data-pulls-show-again="${key(5)}"]`));
  click($(`[data-pulls-show-again="${key(5)}"]`)!);
  await settle(50);
  // The fold left with its last PR: the list's own heading would take focus in the page; here nothing is left to take it.
  expect($('[data-pulls-hidden-toggle]')).toBeNull();
});

test("the Inbox list's Hide: one write naming the threads, one toast, and Undo shows exactly what it hid", async () => {
  if (!hasDom) return;
  const done = hidden.hideThreadsWithUndo(['thr_a', 'thr_b'], (toast, ms) => toasts.push({ toast, ms }));
  await settle();
  expect(sent.map((s) => [new URL(s.url, 'http://x').pathname, s.body.threads, s.body.hide])).toEqual([['/api/inbox/pulls/hidden', ['thr_a', 'thr_b'], []]]);
  sent[0]!.answer(200, { hidden: [{ key: key(7), title: 'Change 7', url: pull(7).url, at: '2026-11-17T12:00:00.000Z', thread_id: 'thr_a' }, { key: WEB20, title: 'Change 20', url: pull(20).url, at: '2026-11-17T12:00:00.000Z', thread_id: 'thr_b' }], hid: [key(7), WEB20] });
  expect(await done).toBe(true);
  // Reviews and the board drop them at once.
  expect(hidden.pullsShown(MODEL, hidden.hiddenChangesNow())!.pulls.map((p) => p.key)).toEqual([key(8), key(9)]);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast.lead).toContain('2');
  act(() => toasts[0]!.toast.onUndo!());
  await settle();
  expect(sent[1]!.body).toMatchObject({ hide: [], threads: [], show: [key(7), WEB20] });
});

test("the Inbox list's Hide with nothing left to hide says so; one that takes threads out says that too", async () => {
  if (!hasDom) return;
  const none = hidden.hideThreadsWithUndo(['thr_a'], (toast, ms) => toasts.push({ toast, ms }));
  await settle();
  sent[0]!.answer(200, { hidden: [], hid: [], threads_left: [] });
  expect(await none).toBe(false);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.toast.onUndo).toBeUndefined();
  const two = hidden.hideThreadsWithUndo(['thr_a', 'thr_b'], (toast, ms) => toasts.push({ toast, ms }));
  await settle();
  sent[1]!.answer(200, { hidden: [], hid: [key(7), key(8)], threads_left: ['thr_a', 'thr_b'] });
  expect(await two).toBe(true);
  expect(toasts[1]!.toast.lead).not.toBe(toasts[0]!.toast.lead);
  expect(toasts[1]!.toast.lead).toContain('2 threads');
  expect(toasts[1]!.toast.onUndo).toBeDefined();
});

test("the Inbox list's Hide on a thread that came back hides the thread again; its Undo lets that thread back and shows no PR", async () => {
  if (!hasDom) return;
  const again = hidden.hideThreadsWithUndo(['thr_a'], (toast, ms) => toasts.push({ toast, ms }));
  await settle();
  sent[0]!.answer(200, { hidden: [], hid: [], rehid: ['thr_a'], threads_left: ['thr_a'] });
  expect(await again).toBe(true);
  expect(toasts).toHaveLength(1);
  act(() => toasts[0]!.toast.onUndo!());
  await settle();
  expect(sent.slice(1).map((s) => s.body)).toEqual([{ hide: [], threads: [], show: [], show_threads: ['thr_a'] }]);
  sent[1]!.answer(200, { hidden: [] });
  await settle();
  expect(toasts.at(-1)!.toast.icon).toBe('check');
});

test("a hidden PR keeps its review thread in a thread's PR list", () => {
  if (!hasDom) return;
  const model = { ...MODEL, pulls: MODEL.pulls.filter((p) => p.key !== key(7)), hidden: [{ key: key(7), title: 'Change 7', url: pull(7).url, at: '2026-11-17T12:00:00.000Z', thread_id: 'thr_review' }] };
  const linkOf = pullReviewLinks(model, null);
  expect(linkOf({ pull: key(7), state: 'open' }, 'thr_other')).toMatchObject({ kind: 'thread', threadId: 'thr_review' });
  // Not on its own thread, nor once it merged.
  expect(linkOf({ pull: key(7), state: 'open' }, 'thr_review')).toBeNull();
  expect(linkOf({ pull: key(7), state: 'merged' }, 'thr_other')).toBeNull();
});
