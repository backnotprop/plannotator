import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import type { PullsPageProps } from '../pulls/PullsPage';
import type { SheetPageProps } from './SheetPage';
import { pullsStateOf } from '../pulls/reviewsTestState';

const hasDom = typeof document !== 'undefined';
const { PullsPage } = (hasDom ? await import('../pulls/PullsPage') : {}) as typeof import('../pulls/PullsPage');
const { SheetPage, MERGED_SHOWN_MS } = (hasDom ? await import('./SheetPage') : {}) as typeof import('./SheetPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const REPO = 'northwind/ledger';
const NOW = Date.parse('2026-11-09T12:00:00Z');

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  return {
    key: `github.com/${REPO}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `Change ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: REPO,
    head_sha: 'a'.repeat(40),
    additions: 1,
    deletions: 1,
    files: 1,
    review: 'approved',
    approved_by: 'jun',
    reviewers: ['jun'],
    checks: 'success',
    conflicts: false,
    updated_at: '2026-11-08T09:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(1), pull(2, { mine: false, requested: true, author: 'tomas', review: null }), pull(3)],
  links: {},
  projects: { [`github.com/${REPO}`]: ['prj_ledger'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const KEY = `github.com/${REPO}#1`;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let merges: Record<string, unknown>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  merges = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/pulls/merge')) {
      merges.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Response.json({ ok: true, key: KEY, method: 'squash', url: 'https://github.com/northwind/ledger/pull/1' });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><SidebarProvider>{node}</SidebarProvider></div>));
}

function drawSheet(over: Partial<SheetPageProps> = {}) {
  const merged: number[] = [];
  mount(
    <SheetPage
      mode="pane"
      model={MODEL}
      error={null}
      loading={false}
      phone={false}
      view="open"
      risk={{}}
      now={NOW}
      onView={() => {}}
      onOpenPull={() => {}}
      onOpenStack={() => {}}
      onMerged={() => merged.push(Date.now())}
      {...over}
    />,
  );
  return { merged };
}

async function pinOpen(key: string) {
  await act(async () => {
    $(`[data-pr-tile="${key}"]`)!.click();
  });
  await settle();
}

async function hoverOpen(key: string) {
  await act(async () => {
    $(`[data-pr-tile="${key}"]`)!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
  });
  await wait(320);
}

async function press(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await settle();
}

test('Confirm merge is the same button in the same slot, as wide as its widest word; the hint is under the buttons', async () => {
  if (!hasDom) return;
  drawSheet();
  await pinOpen(KEY);
  const acts = $('[data-pr-pop] .ib-prpop-acts')!;
  const slot = $('[data-pr-pop-mslot]')!;
  const at = [...acts.children].indexOf(slot);
  expect($$('[data-pr-pop-mslot] .ib-prpop-msize').map((s) => s.textContent)).toEqual(['Merge', 'Confirm merge', 'Merging…', 'Merged']);
  const button = $('[data-pr-pop-merge]')!;
  expect(button.textContent).toBe('Merge');

  await press(button);
  expect($('[data-pr-pop-merge]')).toBe(button);
  expect(button.textContent).toBe('Confirm merge');
  expect(button.parentElement).toBe(slot);
  expect([...acts.children].indexOf(slot)).toBe(at);
  const hint = $('.ib-prpop-hint')!;
  expect(hint.textContent).toContain('Click again to merge #1 into main');
  expect(acts.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(merges).toEqual([]);
});

test('on a phone the confirm hint goes above the buttons: the bottom sheet grows up and the buttons stay put', async () => {
  if (!hasDom) return;
  drawSheet({ phone: true, mode: 'page' });
  await pinOpen(KEY);
  const button = $('[data-pr-pop-merge]')!;
  await press(button);
  expect($('[data-pr-pop-merge]')).toBe(button);
  const acts = $('[data-pr-pop] .ib-prpop-acts')!;
  expect(acts.compareDocumentPosition($('.ib-prpop-hint')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
});

test('Merged stays readable for about 1.5 s, whatever the pointer does; then the popover closes and the PR leaves Open', async () => {
  if (!hasDom) return;
  const { merged } = drawSheet();
  await hoverOpen(KEY);
  expect($(`[data-pr-pop="${KEY}"]`)).not.toBeNull();
  await press($('[data-pr-pop-merge]')!);
  await press($('[data-pr-pop-merge]')!);
  expect(merges).toEqual([expect.objectContaining({ key: KEY, head_sha: 'a'.repeat(40), confirmed: true })]);
  expect($('[data-pr-pop-merged]')?.textContent).toContain('Merged');
  expect($('[data-pr-pop-merged]')!.parentElement).toBe($('[data-pr-pop-mslot]'));

  await act(async () => {
    $('[data-pr-pop]')!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
    $(`[data-pr-tile="github.com/${REPO}#3"]`)!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
  });
  await wait(MERGED_SHOWN_MS - 500);
  expect($(`[data-pr-pop="${KEY}"]`)).not.toBeNull();
  expect($('[data-pr-pop-merged]')).not.toBeNull();
  expect(merged).toEqual([]);

  await wait(700);
  expect($('[data-pr-pop]')).toBeNull();
  expect(merged).toHaveLength(1);
  expect(MODEL.pulls.find((p) => p.key === KEY)!.state).toBe('open');
  expect($(`[data-pr-tile="${KEY}"]`)).toBeNull();
  expect($(`[data-pr-tile="github.com/${REPO}#3"]`)).not.toBeNull();
  expect($('[data-pr-summary]')?.textContent).toContain('2 open');
});

const AT = '2026-11-01T09:00:00.000Z';
const PROJECTS = [{ id: 'prj_ledger', key: 'ledger', name: 'ledger', root: '/home/dana/ledger', created_at: AT, threads: 1, unread: 0 }] as unknown as ProjectFolder[];

function drawReviews(over: Partial<PullsPageProps> = {}) {
  const opened: string[] = [];
  const props: PullsPageProps = {
    state: pullsStateOf(MODEL),
    stackId: null,
    project: null,
    filter: 'all',
    projects: PROJECTS,
    projectNames: new Map([['prj_ledger', 'ledger']]),
    phone: false,
    onNew: () => {},
    onOpenStack: () => {},
    onScope: () => {},
    onReview: () => {},
    onOpenThread: () => {},
    onNewReview: () => {},
    prBoard: <div data-test-board="" />,
    prsSummary: { open: 3, needYou: 1 },
    onPullRequests: () => opened.push('prs'),
    ...over,
  };
  mount(<PullsPage {...props} />);
  return { opened };
}

test('Reviews: the board fills the right pane while nothing is open there; an open stack takes the pane', async () => {
  if (!hasDom) return;
  drawReviews();
  await settle();
  expect($('[data-pulls-list]')).not.toBeNull();
  expect($('[data-test-board]')).not.toBeNull();
  expect($('[data-pulls-pane-empty]')).toBeNull();
  expect($('[data-prs-entry]')).toBeNull();

  act(() => root?.unmount());
  host?.remove();
  drawReviews({ stackId: KEY });
  await settle();
  expect($(`[data-pulls-stack]`)).not.toBeNull();
  expect($('[data-test-board]')).toBeNull();
});

test('Reviews on a phone: no pane, a "Pull requests" row with its counts at the top of the list opens the board', async () => {
  if (!hasDom) return;
  const { opened } = drawReviews({ phone: true });
  await settle();
  expect($('[data-test-board]')).toBeNull();
  const row = $('[data-prs-entry]')!;
  expect(row.textContent).toContain('Pull requests');
  expect(row.textContent).toContain('3 open');
  expect(row.textContent).toContain('1 need you');
  expect(row.compareDocumentPosition($('[data-pulls-row]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await press(row);
  expect(opened).toEqual(['prs']);
});

test('a face by every name: the popover pictures the author and who it waits on; a row never shows the same face twice', async () => {
  if (!hasDom) return;
  const waits = pull(4, { mine: false, author: 'tomas', review: null, approved_by: null, reviewers: ['nina-k'] });
  drawSheet({ model: { ...MODEL, pulls: [...MODEL.pulls, waits] } });
  await hoverOpen(waits.key);
  const pop = $(`[data-pr-pop="${waits.key}"]`)!;
  expect(pop.querySelector('.ib-prpop-meta [data-person="tomas"] [data-face="tomas"]')).not.toBeNull();
  const status = pop.querySelector<HTMLElement>('.ib-prpop-status')!;
  expect(status.textContent).toBe('Waits on nina-k');
  expect(status.querySelector('[data-person="nina-k"] [data-face="nina-k"]')).not.toBeNull();

  act(() => root?.unmount());
  host?.remove();
  drawReviews();
  await settle();
  const row = $(`[data-pulls-row="github.com/${REPO}#2"]`)!;
  expect(row.querySelector('.ib-lead [data-pulls-author="tomas"]')).not.toBeNull();
  const words = row.querySelector<HTMLElement>('[data-reviews-status]')!;
  expect(words.textContent).toBe("Review requested · tomas's PR");
  expect(words.querySelector('[data-person="tomas"]')).not.toBeNull();
  expect(words.querySelector('[data-face]')).toBeNull();
});
