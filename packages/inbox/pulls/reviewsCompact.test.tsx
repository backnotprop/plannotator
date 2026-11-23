/**
 * Reviews' compact rows (approval "inbox-reviews-compact-list", part 1). What regresses:
 *  - a closed row growing a second line, or the open row losing it (number, repository, agent, the status words in
 *    their tone, a Medium or Low mark), or the second line staying on a row after another opens;
 *  - the groups losing their order, counts or folding, or a group label drawn as a filled band again;
 *  - an unread review's title not bold, or a listed PR's bold;
 *  - one row with everything at once (High, failing checks, the agent, a three-digit stack count, an old age) losing
 *    any of it, or the count's button nested in the row's;
 *  - a long unbroken title losing the end that tells it apart, or a right-to-left title split;
 *  - a layer's row opening the whole stack, not showing selected when its layer is open, out of Tab's reach, or
 *    missing from the right-click menu;
 *  - the list remembering on its own which layer was opened (an old layer selected on a fresh way to the stack): the
 *    layer shown selected is the address's, PullsPage's `selectedLayer`;
 *  - a screen reader hearing a closed row's agent twice, or its parts out of order;
 *  - a title's tooltip measured on the hidden full title or on rounding;
 *  - a phone row without its second line (status words in their tone, Medium or Low, repository and number), the
 *    desktop's open-row line drawn there too, or a phone row heard with a part twice or the age before the rest.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No fetch: the list is drawn from props.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull, type InboxPullsAnswer, type InboxReviewRow, type InboxReviewThread, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { RiskJudgments } from './risk';
import { relativeWords } from '../relativeTime';

const hasDom = typeof document !== 'undefined';
const { ReviewsList, ReviewsMenu, menuTargets } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');
const { titleIsCut, titleParts } = (hasDom ? await import('./titleCut') : {}) as typeof import('./titleCut');

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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
    author: 'ada-novak',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    head_sha: String(number).padStart(40, 'a'),
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: ago(3 * 3_600_000),
    merged_at: null,
    ...fields,
  };
}

const review = (thread: string, title: string): InboxReviewThread =>
  ({
    thread_id: thread,
    project_id: 'prj_ledger',
    subject: null,
    first_review_id: `msg_${thread}`,
    latest_review_id: `msg_${thread}`,
    round: 1,
    title,
    files: 1,
    additions: 1,
    deletions: 1,
    agent: { host: 'claude-code', session: null, name: 'Claude Code' },
    source: null,
    verdict: null,
    answered: null,
    reviewed_at: ago(DAY),
    updated_at: ago(DAY),
  }) as InboxReviewThread;

/** A PR row nobody reviewed: one stack, its open layers. */
function listed(pulls: InboxPull[], move: InboxReviewRow['move'], reason: InboxReviewRow['reason']): InboxReviewRow {
  const stack = inboxPullStacks(pulls)[0]!;
  return { id: stack.id, reviewed: false, move, reason, thread_id: null, review: null, stacks: [stack], pull_keys: pulls.map((p) => p.key), link: null, pull_reason: null, landed: [], updated_at: pulls[pulls.length - 1]!.updated_at };
}

/** A review thread an agent sent, about these PRs. */
function reviewed(thread: string, pulls: InboxPull[], fields: Partial<InboxReviewRow> = {}): InboxReviewRow {
  const stack = inboxPullStacks(pulls)[0]!;
  return { id: thread, reviewed: true, move: 'on_you', reason: 'review_ready', thread_id: thread, review: review(thread, 'Review'), stacks: [stack], pull_keys: pulls.map((p) => p.key), link: null, pull_reason: null, landed: [], updated_at: ago(DAY), ...fields };
}

// A stack of 120 layers, each on the one under it.
const TALL = Array.from({ length: 120 }, (_, i) => pull(500 + i, { base: i === 0 ? 'main' : `b${499 + i}`, author: 'bob-tully', checks: i === 7 ? 'failure' : 'success', updated_at: ago(330 * DAY) }));
const ROWS: InboxReviewRow[] = [
  // On you: everything at once on one line.
  reviewed('thr_all', TALL, { updated_at: ago(330 * DAY) }),
  reviewed('thr_mid', [pull(41, { author: 'charlie-dunn' })], { reason: 'changes', review: { ...review('thr_mid', 'Mid'), verdict: null } }),
  // With your agents.
  reviewed('thr_agent', [pull(42)], { move: 'agents', reason: 'curating' }),
  // Ready to land, waiting, not reviewed.
  listed([pull(43, { mine: true, requested: false, title: 'fix/guide-global-comment-keep-words-when-adding-fails' })], 'ready', 'approved'),
  listed([pull(44, { title: 'إصلاح عرض قائمة المراجعات الطويلة جدا_بدون_مسافات_على_الإطلاق' })], 'waiting', 'forge_review'),
  listed([pull(45, { title: '🚀 Ship the 🧪 compact list' })], 'not_reviewed', 'not_reviewed'),
  listed([pull(46, { author: null })], 'not_reviewed', 'not_reviewed'),
];
const MODEL: InboxPullsAnswer = {
  fetched_at: ago(60_000),
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [...TALL, pull(41), pull(42), pull(43), pull(44), pull(45), pull(46, { author: null })],
  links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'] },
  cards: {},
} as InboxPullsAnswer;
const ANSWER: InboxReviewsAnswer = { fetched_at: MODEL.fetched_at, hosts: MODEL.hosts, rows: ROWS, projects: MODEL.projects };
const JUDGMENTS: RiskJudgments = { [TALL[3]!.key]: { level: 'high', why: 'It changes charges.' }, [pull(41).key]: { level: 'medium', why: 'It may reach charges.' } } as RiskJudgments;

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => window.localStorage?.clear());
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const opened: string[] = [];
const openedLayers: string[] = [];
const hid: string[][] = [];
function draw(selected: string | null, selectedLayer: string | null = null, phone = false, rows: InboxReviewRow[] = ROWS) {
  const node = (
    <ReviewsMenu className="ib-lbody" rows={rows} links={{}} phone={false} onTarget={() => {}} onHide={(pulls) => hid.push(pulls.map((p) => p.key))}>
      <ReviewsList
        answer={{ ...ANSWER, rows }}
        model={MODEL}
        rows={rows}
        filter="all"
        judgments={JUDGMENTS}
        projectNames={new Map()}
        selected={selected}
        selectedLayer={selectedLayer}
        phone={phone}
        onOpen={(row) => opened.push(row.id)}
        onOpenLayer={(row, layer) => openedLayers.push(`${row.id} ${layer.key}`)}
        onNew={() => {}}
      />
    </ReviewsMenu>
  );
  if (root) return act(() => root!.render(node));
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const row = (id: string) => $(`[data-reviews-row="${id}"]`)!;

/**
 * What a screen reader hears from an element: its text, without what is hidden from it. An aria-label counts only on
 * an element with a role (an image, a button): on a plain span some screen readers never read it. An element with
 * nothing to say is named by its `title`, as a browser names it.
 */
function spoken(el: Element): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent;
    else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') {
      const said = (node.hasAttribute('role') || node.tagName === 'BUTTON' ? node.getAttribute('aria-label') : null) ?? spoken(node);
      out += said.trim() === '' ? (node.getAttribute('title') ?? said) : said;
    }
  }
  return out;
}

test.skipIf(!hasDom)("closed rows are one line; the open row's second line says its number, repository, agent, status in its tone and Medium", () => {
  draw('thr_mid');
  for (const el of document.querySelectorAll<HTMLElement>('[data-reviews-row]')) {
    expect(el.querySelectorAll('.ib-rvr-l1')).toHaveLength(1);
    expect(el.querySelector('[data-reviews-line2]') !== null).toBe(el.getAttribute('aria-current') === 'true');
  }
  const line2 = row('thr_mid').querySelector<HTMLElement>('[data-reviews-line2]')!;
  expect(line2.querySelector('.ib-pr-l3')!.textContent).toBe('#41 · ledger · Claude Code, Changes requested');
  // The agent, named once, as text a screen reader reads (a plain span's aria-label is not).
  expect(spoken(row('thr_mid')).split('Claude Code')).toHaveLength(2);
  expect(spoken(line2)).toContain('Claude Code, Changes requested');
  expect(line2.querySelector('[data-reviews-status]')!.getAttribute('data-tone')).toBe('warn');
  expect(line2.querySelector('[data-pulls-author="charlie-dunn"]')).not.toBeNull();
  expect(line2.querySelector('[data-pull-risk]')!.getAttribute('data-pull-risk')).toBe('medium');
  // Medium is not on the line itself.
  expect(row('thr_mid').querySelector('.ib-rvr-l1 [data-pull-risk]')).toBeNull();
  // Another row opens: the second line moves with it.
  draw('thr_agent');
  expect(row('thr_mid').querySelector('[data-reviews-line2]')).toBeNull();
  expect(row('thr_agent').querySelector('[data-reviews-status]')!.textContent).toBe('Curating…');
  expect(document.querySelectorAll('[data-reviews-line2]')).toHaveLength(1);
});

test.skipIf(!hasDom)("groups: today's order and counts under plain labels; the folded ones keep their chevron and fold", () => {
  draw(null);
  const groups = [...document.querySelectorAll<HTMLElement>('[data-pulls-group]')];
  expect(groups.map((g) => g.getAttribute('data-pulls-group'))).toEqual(['on_you', 'agents', 'ready', 'waiting', 'not_reviewed']);
  expect(groups.map((g) => g.querySelector('.ib-n')!.textContent)).toEqual(['2', '1', '1', '1', '2']);
  expect(document.querySelector('.ib-band')).toBeNull();
  for (const name of ['on_you', 'agents', 'ready']) expect($(`[data-pulls-group="${name}"] > .ib-rvr-gl`)).not.toBeNull();
  const fold = $('[data-reviews-fold="waiting"]')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(fold.querySelector('svg')).not.toBeNull();
  expect($('[data-pulls-group="waiting"] [data-reviews-row]')).toBeNull();
  act(() => fold.click());
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect($('[data-pulls-group="waiting"] [data-reviews-row]')).not.toBeNull();
  expect(JSON.parse(window.localStorage.getItem('plannotator-inbox-reviews-folds')!)).toEqual({ waiting: true, not_reviewed: false, local: false });
});

test.skipIf(!hasDom)("an unread review's title is bold; a listed PR's is not", () => {
  draw(null);
  expect(row('thr_mid').classList.contains('ib-u')).toBe(true);
  expect(row(ROWS[3]!.id).classList.contains('ib-u')).toBe(false);
});

test.skipIf(!hasDom)('everything at once on one line: High, failing checks, the agent, a three-digit count and an old age', () => {
  draw(null);
  const line = row('thr_all').querySelector<HTMLElement>('.ib-rvr-l1')!;
  expect(line.querySelector('[data-pull-risk="high"]')).not.toBeNull();
  expect(line.querySelector('[data-reviews-checks="failure"]')).not.toBeNull();
  expect(line.querySelector('[data-reviews-agent="claude-code"]')).not.toBeNull();
  expect(line.querySelector('.ib-rvr-age [aria-hidden]')!.textContent).toBe('11mo');
  expect(line.querySelector('.ib-rvr-cnt-room')!.textContent).toBe('120');
  // The count is its own button beside the row, never one inside it.
  const toggle = $('[data-reviews-stack-toggle="thr_all"]')!;
  expect(toggle.textContent).toBe('120');
  expect(toggle.closest('[data-reviews-row]')).toBeNull();
  expect(row('thr_all').querySelector('button')).toBeNull();
  opened.length = 0;
  openedLayers.length = 0;
  act(() => toggle.click());
  // Unfolding opens nothing; the layers are listed from the base up, and a layer's row opens that layer, not the stack.
  expect(opened).toEqual([]);
  expect([...document.querySelectorAll('[data-reviews-stack="thr_all"] [data-reviews-layer]')].map((l) => l.getAttribute('data-reviews-layer'))).toEqual(TALL.map((p) => p.key));
  act(() => $(`[data-reviews-layer="${TALL[9]!.key}"]`)!.click());
  expect(opened).toEqual([]);
  expect(openedLayers).toEqual([`thr_all ${TALL[9]!.key}`]);
  // The layer whose checks fail says so on its own row.
  expect($(`[data-reviews-layer="${TALL[7]!.key}"] [data-reviews-checks="failure"]`)).not.toBeNull();
  expect($(`[data-reviews-layer="${TALL[6]!.key}"] [data-reviews-checks]`)).toBeNull();
});

test.skipIf(!hasDom)('a long unbroken title keeps its end; a right-to-left one and one with emoji stay whole', () => {
  draw(null);
  const title = row(ROWS[3]!.id).querySelector<HTMLElement>('.ib-rvr-t')!;
  expect(title.hasAttribute('data-reviews-title-split')).toBe(true);
  expect(title.querySelector('.ib-rvr-tt')!.textContent).toBe('adding-fails');
  expect(title.querySelector('.ib-sr')!.textContent).toBe('fix/guide-global-comment-keep-words-when-adding-fails');
  act(() => $('[data-reviews-fold="waiting"]')!.click());
  act(() => $('[data-reviews-fold="not_reviewed"]')!.click());
  const rtl = row(ROWS[4]!.id).querySelector<HTMLElement>('.ib-rvr-t')!;
  expect(rtl.hasAttribute('data-reviews-title-split')).toBe(false);
  expect(rtl.getAttribute('dir')).toBe('auto');
  expect(row(ROWS[5]!.id).querySelector('.ib-rvr-t')!.textContent).toBe('🚀 Ship the 🧪 compact list');
});

test.skipIf(!hasDom)("a deleted account's PR, open: a grey person leads its second line, no picture asked for", () => {
  window.localStorage.setItem('plannotator-inbox-reviews-folds', JSON.stringify({ waiting: false, not_reviewed: true }));
  draw(ROWS[6]!.id);
  const ghost = row(ROWS[6]!.id).querySelector<HTMLElement>('[data-reviews-line2] [data-pulls-ghost]')!;
  expect(ghost.getAttribute('aria-label')).toBe('A deleted account');
  expect(ghost.querySelector('svg')).not.toBeNull();
  expect(ghost.querySelector('img')).toBeNull();
});


/** The list drawn anew, as App draws it after a screen in front of it closes. */
function redraw(selected: string | null, selectedLayer: string | null = null, rows: InboxReviewRow[] = ROWS, phone = false) {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  draw(selected, selectedLayer, phone, rows);
}

test.skipIf(!hasDom)("back to a stack from a layer's diff: the layer's row is the selected one, with its second line", () => {
  // The address carries the layer the diff closed from (`Route.backLayer`), PullsPage's `selectedLayer`.
  draw('thr_all', TALL[3]!.key);
  const layer = $(`[data-reviews-layer="${TALL[3]!.key}"]`)!;
  expect(layer.getAttribute('aria-current')).toBe('true');
  expect(layer.classList.contains('ib-sel')).toBe(true);
  expect(layer.querySelector('[data-reviews-line2] [data-pulls-author="bob-tully"]')).not.toBeNull();
  // Its High is on its own line.
  expect(layer.querySelector('.ib-rvr-l1 [data-pull-risk="high"]')).not.toBeNull();
  expect(row('thr_all').getAttribute('aria-current')).toBeNull();
  expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  // Then a layer opened from the stack's own page, and back: that layer, not the first.
  redraw('thr_all', TALL[4]!.key);
  expect($(`[data-reviews-layer="${TALL[4]!.key}"]`)!.getAttribute('aria-current')).toBe('true');
  expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
});

test.skipIf(!hasDom)("the top layer, whose key is the stack's id, shows on its own row", () => {
  draw('thr_all', TALL[119]!.key);
  expect($(`[data-reviews-layer="${TALL[119]!.key}"]`)!.getAttribute('aria-current')).toBe('true');
  expect(row('thr_all').getAttribute('aria-current')).toBeNull();
});

test.skipIf(!hasDom)('a layer opened from its row is not remembered by the list: a fresh way to the stack shows the stack, folded', () => {
  draw(null);
  act(() => $('[data-reviews-stack-toggle="thr_all"]')!.click());
  act(() => $(`[data-reviews-layer="${TALL[3]!.key}"]`)!.click());
  // The diff left another way (the sidebar's Inbox: no list drawn), then the same stack opened from a thread or a
  // board tile: no `backLayer`.
  redraw('thr_all');
  expect(row('thr_all').getAttribute('aria-current')).toBe('true');
  expect($('[data-reviews-stack="thr_all"] [data-reviews-layer]')).toBeNull();
});

test.skipIf(!hasDom)("a stack opened by a layer's key unfolds onto that layer's row", () => {
  draw('thr_all', TALL[5]!.key);
  expect($(`[data-reviews-layer="${TALL[5]!.key}"]`)!.getAttribute('aria-current')).toBe('true');
  expect(row('thr_all').getAttribute('aria-current')).toBeNull();
  // Folded by hand, the stack's row shows the selection again.
  act(() => $('[data-reviews-stack-toggle="thr_all"]')!.click());
  expect($('[data-reviews-stack="thr_all"] [data-reviews-layer]')).toBeNull();
  expect(row('thr_all').getAttribute('aria-current')).toBe('true');
});

/** What the eye reads on a line: its text without what only a screen reader hears. */
function seen(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const sr of copy.querySelectorAll('.ib-sr')) sr.remove();
  return copy.textContent ?? '';
}

// A stack with a merged layer under it and a draft on top, beside an open one.
const MIXED = [pull(600, { state: 'merged', merged_at: ago(DAY) }), pull(601, { base: 'b600' }), pull(602, { base: 'b601', state: 'draft' })];
const MIXED_ROWS = [reviewed('thr_mixed', MIXED)];

test.skipIf(!hasDom)("a layer's second line, a desktop's and a phone's: Draft, Merged or nothing before its number, never the stack's repository again", () => {
  for (const [i, words] of [[0, 'Merged · #600'], [1, '#601'], [2, 'Draft · #602']] as const) {
    redraw('thr_mixed', MIXED[i]!.key, MIXED_ROWS);
    const line = $(`[data-reviews-layer="${MIXED[i]!.key}"] [data-reviews-line2] .ib-pv`)!;
    expect(line.textContent).toBe(words);
    // The state was said at the row's start: on this line it is for the eye only.
    expect(spoken(line)).toBe(`#${600 + i}`);
  }
  // A phone's layer line says the same.
  redraw(null, null, MIXED_ROWS, true);
  act(() => $('[data-reviews-stack-toggle="thr_mixed"]')!.click());
  expect(MIXED.map((p) => seen($(`[data-reviews-layer="${p.key}"] [data-reviews-line2-phone] .ib-pv`)!))).toEqual(['Merged · #600', '#601', 'Draft · #602']);
});

test.skipIf(!hasDom)("Tab reaches a stack's row, then its count, then each of its layers", () => {
  draw(null);
  act(() => $('[data-reviews-stack-toggle="thr_all"]')!.click());
  const stack = $('[data-reviews-stack="thr_all"]')!;
  const tabbable = [...stack.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled'));
  expect(tabbable[0]).toBe(row('thr_all'));
  expect(tabbable[1]).toBe($('[data-reviews-stack-toggle="thr_all"]')!);
  expect(tabbable.slice(2).map((el) => el.getAttribute('data-reviews-layer'))).toEqual(TALL.map((p) => p.key));
  // Siblings, never one button in another.
  for (const el of tabbable) expect(el.parentElement!.closest('button')).toBeNull();
});

test.skipIf(!hasDom)("right-click on a layer's row offers Hide for that one PR", async () => {
  draw(null);
  act(() => $('[data-reviews-stack-toggle="thr_all"]')!.click());
  const layer = $(`[data-reviews-layer="${TALL[4]!.key}"]`)!;
  expect(menuTargets(ROWS, {}).get(layer.getAttribute('data-reviews-item')!)!.pulls.map((p) => p.key)).toEqual([TALL[4]!.key]);
  hid.length = 0;
  await act(async () => {
    layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
  expect($('[data-reviews-hide]')!.textContent).toBe('Hide pull request');
  await act(async () => $('[data-reviews-hide]')!.click());
  expect(hid).toEqual([[TALL[4]!.key]]);
});

test.skipIf(!hasDom)('a closed row is heard once, in order: state, title, risk, checks, agent, status, number and repository, age', () => {
  draw(null);
  const said = spoken(row('thr_all'));
  const title = row('thr_all').querySelector('.ib-rvr-t')!.textContent!;
  const age = row('thr_all').querySelector('.ib-rvr-age .ib-sr')!.textContent!;
  expect(said.split('Claude Code')).toHaveLength(2);
  expect(said.split(title)).toHaveLength(2);
  expect(said.split(age)).toHaveLength(2);
  const order = ['A stack of 120 pull requests', title, 'High risk', 'checks failing', 'Claude Code', 'ledger', age].map((part) => said.indexOf(part));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // One open PR: its state leads.
  const one = spoken(row('thr_mid'));
  expect(one.startsWith('Open pull request, ')).toBe(true);
  expect(one.split('Claude Code')).toHaveLength(2);
  expect(one.indexOf('Claude Code')).toBeLessThan(one.indexOf('Changes requested'));
  expect(one.indexOf('Changes requested')).toBeLessThan(one.indexOf('#41'));
});

test.skipIf(!hasDom)("a title's tooltip measures only what is drawn, and never a cut of half a pixel or less", () => {
  draw(null);
  const split = row(ROWS[3]!.id).querySelector('.ib-rvr-t')!;
  const plain = row('thr_mid').querySelector('.ib-rvr-t')!;
  // The full title kept for a screen reader is never measured.
  const parts = titleParts(split);
  expect(parts.length).toBe(3);
  for (const part of parts) expect(part.closest('.ib-sr')).toBeNull();
  expect(titleParts(plain)).toEqual([plain as HTMLElement]);
  const by = (over: (el: HTMLElement) => number) => (el: HTMLElement) => ({ text: 100 + over(el), box: 100 });
  expect(titleIsCut(plain, by(() => 0.25))).toBe(false);
  expect(titleIsCut(plain, by(() => 0.5))).toBe(false);
  // Over by less than a pixel, the line already draws its "…": the tooltip shows.
  expect(titleIsCut(plain, by(() => 0.75))).toBe(true);
  expect(titleIsCut(plain, by(() => 1.5))).toBe(true);
  expect(titleIsCut(split, by(() => 0.4))).toBe(false);
  expect(titleIsCut(split, by(() => 0.9))).toBe(true);
  // The head cut: the title is.
  expect(titleIsCut(split, by((el) => (el.classList.contains('ib-rvr-th') ? 30 : 0)))).toBe(true);
});

test.skipIf(!hasDom)("on a phone every row has two lines: status words in their tone, Medium, then repository and number; heard once, the age last", () => {
  draw('thr_mid', null, true);
  for (const el of document.querySelectorAll<HTMLElement>('[data-reviews-row]')) expect(el.querySelector('[data-reviews-line2-phone]')).not.toBeNull();
  // The open row too: the phone's line, never the desktop's.
  expect(document.querySelector('[data-reviews-line2]')).toBeNull();
  const line = row('thr_mid').querySelector<HTMLElement>('[data-reviews-line2-phone]')!;
  const parts = [...line.querySelectorAll('.ib-rvr-l2p-part')];
  expect(parts[0]!.querySelector('[data-reviews-status]')!.getAttribute('data-tone')).toBe('warn');
  expect(parts[0]!.textContent).toBe('Changes requested');
  expect(parts[1]!.querySelector('[data-pull-risk="medium"]')).not.toBeNull();
  expect(parts[2]!.lastChild!.textContent).toBe('ledger #41');
  const said = spoken(row('thr_mid'));
  expect(said.split('Claude Code')).toHaveLength(2);
  expect(said.split('Changes requested')).toHaveLength(2);
  expect(said.split('Medium')).toHaveLength(2);
  // The age's words, once, and last.
  const age = relativeWords(ROWS[1]!.updated_at, Date.now());
  expect(said.endsWith(`, ${age}`)).toBe(true);
  expect(said.split(age)).toHaveLength(2);
  expect(said.indexOf('Claude Code')).toBeLessThan(said.indexOf('Changes requested'));
  expect(said.indexOf('Medium')).toBeLessThan(said.indexOf('ledger #41'));
  // A stack: its count of open and merged in place of a number; a layer: its own number, its state for the eye.
  expect(row('thr_all').querySelector('[data-reviews-line2-phone]')!.textContent).toContain('ledger · 120 open');
  act(() => $('[data-reviews-stack-toggle="thr_all"]')!.click());
  expect($(`[data-reviews-layer="${TALL[2]!.key}"] [data-reviews-line2-phone] .ib-pv`)!.textContent).toBe('#502');
});
