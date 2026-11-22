/**
 * Reviews' compact rows (approval "inbox-reviews-compact-list", part 1). What regresses:
 *  - a closed row growing a second line, or the open row losing it (number, repository, agent, the status words in
 *    their tone, a Medium or Low mark), or the second line staying on a row after another opens;
 *  - the groups losing their order, counts or folding, or a group label drawn as a filled band again;
 *  - an unread review's title not bold, or a listed PR's bold;
 *  - one row with everything at once (High, failing checks, the agent, a three-digit stack count, an old age) losing
 *    any of it, or the count's button nested in the row's;
 *  - a long unbroken title losing the end that tells it apart, or a right-to-left title split.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No fetch: the list is drawn from props.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull, type InboxPullsAnswer, type InboxReviewRow, type InboxReviewThread, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { RiskJudgments } from './risk';

const hasDom = typeof document !== 'undefined';
const { ReviewsList } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');

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
function draw(selected: string | null) {
  const node = (
    <div className="ib-lbody">
      <ReviewsList answer={ANSWER} model={MODEL} rows={ROWS} filter="all" judgments={JUDGMENTS} projectNames={new Map()} selected={selected} phone={false} onOpen={(row) => opened.push(row.id)} onNew={() => {}} />
    </div>
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

test.skipIf(!hasDom)("closed rows are one line; the open row's second line says its number, repository, agent, status in its tone and Medium", () => {
  draw('thr_mid');
  for (const el of document.querySelectorAll<HTMLElement>('[data-reviews-row]')) {
    expect(el.querySelectorAll('.ib-rvr-l1')).toHaveLength(1);
    expect(el.querySelector('[data-reviews-line2]') !== null).toBe(el.getAttribute('aria-current') === 'true');
  }
  const line2 = row('thr_mid').querySelector<HTMLElement>('[data-reviews-line2]')!;
  expect(line2.querySelector('.ib-pr-l3')!.textContent).toBe('#41 · ledger · Changes requested');
  expect(line2.querySelector('[data-pulls-row-agent]')!.getAttribute('aria-label')).toBe('Claude Code');
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
  expect(JSON.parse(window.localStorage.getItem('plannotator-inbox-reviews-folds')!)).toEqual({ waiting: true, not_reviewed: false });
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
  act(() => toggle.click());
  // Unfolding opens nothing; the layers are listed from the base up, and a layer's row opens the stack's review.
  expect(opened).toEqual([]);
  expect([...document.querySelectorAll('[data-reviews-stack="thr_all"] [data-reviews-layer]')].map((l) => l.getAttribute('data-reviews-layer'))).toEqual(TALL.map((p) => p.key));
  act(() => $(`[data-reviews-layer="${TALL[9]!.key}"]`)!.click());
  expect(opened).toEqual(['thr_all']);
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
