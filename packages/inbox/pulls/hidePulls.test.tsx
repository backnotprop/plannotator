/**
 * Hide a pull request (hiddenPulls.ts): the board's select bar (Hide N), a tile's popover, and Reviews' row menu and
 * Hidden fold. What regresses:
 *  - a hidden PR staying on the board (or in its "need you" count) until the next read;
 *  - Hide asking the forge for anything, or several PRs sent as several writes;
 *  - no toast, or a toast with no Undo; Undo showing anything but what that Hide hid;
 *  - a refused write leaving the PRs gone;
 *  - Reviews' row menu hiding something other than the row's own open PRs; Hidden's Show again not reaching the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No gh: the window's fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullHidden, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import type { SheetPageProps } from '../prs/SheetPage';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('../prs/SheetPage') : {}) as typeof import('../prs/SheetPage');
const { ReviewsList } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');
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
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  expect(hide.textContent).toBe('Hide 2');
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
  expect(toasts[0]!.toast).toMatchObject({ lead: 'Hid 2 pull requests', detail: 'Still open on GitHub', noKey: true });
  // The picks it hid let go; Undo shows exactly those again.
  act(() => toasts[0]!.toast.onUndo!());
  expect(sent[1]!.body).toMatchObject({ hide: [], show: [key(7), WEB20] });
  sent[1]!.answer(200, { hidden: [] });
  await settle();
  expect(tile(key(7))).not.toBeNull();
  expect(tile(WEB20)).not.toBeNull();
  expect(toasts.at(-1)!.toast.lead).toBe('Showing 2 again');
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
  expect(toasts.at(-1)!.toast).toMatchObject({ icon: 'warn', lead: 'Couldn’t hide' });
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

test("Reviews: a row's menu hides the row's open PRs; Hidden lists what is hidden, and Show again reaches the page", async () => {
  if (!hasDom) return;
  const answer = { ...reviewsOfPulls(MODEL), hidden: [{ key: key(5), title: 'Old change', url: pull(5).url, at: '2026-11-16T10:00:00.000Z' }] satisfies InboxPullHidden[] };
  const hid: InboxPull[][] = [];
  const shown: string[] = [];
  mount(
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
      onHide={(pulls) => hid.push(pulls)}
      onShowAgain={(h) => shown.push(h.key)}
    />,
  );
  const row = answer.rows.find((r) => r.pull_keys.includes(key(8)))!;
  await act(async () => {
    $(`[data-reviews-row="${row.id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
  const item = $('[data-reviews-hide]')!;
  expect(item.textContent).toBe('Hide pull request');
  await act(async () => item.click());
  expect(hid.map((pulls) => pulls.map((p) => p.key))).toEqual([[key(8)]]);

  // Hidden: closed at first, at the end of the list.
  const fold = $('[data-pulls-hidden-toggle]')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(fold.textContent).toContain('Hidden');
  click(fold);
  const hiddenRow = $(`[data-pulls-hidden-row="${key(5)}"]`)!;
  expect(hiddenRow.textContent).toContain('#5');
  expect(hiddenRow.textContent).toContain('Old change');
  click($(`[data-pulls-show-again="${key(5)}"]`)!);
  expect(shown).toEqual([key(5)]);
});
