/**
 * Ship in Reviews (approval "inbox-ship-mode", look "Glint"). What regresses:
 *  - Ship missing from a row's menu, not first, or offered on a row about several PRs (one PR per ship);
 *  - Ship's one click not going to the agent already on the review (its thread, its session);
 *  - a phone's agent sheet not starting on that agent, or a tap on another not shipping with that one;
 *  - a shipping row's menu still offering Ship instead of Ship log and Stop shipping, or Stop not stopping;
 *  - ship mode drawn on a row that does not ship (rows not in ship mode carry none of it);
 *  - stuck without its words, merged keeping the water, an old merge still drawn;
 *  - the ship log out of order, without its commits or Stop, or with Stop once the ship ended.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. The log's one read is a stubbed fetch,
 * put back after each test.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull, type InboxPullsAnswer, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import type { InboxShipLogEntry, InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import type { ShipHandlers } from './ReviewsList';
import type { ShipTarget } from './shipStart';
import type { PullThreadOption } from './threadTo';

const hasDom = typeof document !== 'undefined';
const { ReviewsList, ReviewsMenu } = (hasDom ? await import('./ReviewsList') : {}) as typeof import('./ReviewsList');
const { ShipLogBody } = (hasDom ? await import('./ShipLog') : {}) as typeof import('./ShipLog');

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = 'harbor/fern-api';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Change ${number}`,
    author: 'ada-novak',
    mine: true,
    requested: false,
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
    updated_at: ago(HOUR),
    merged_at: null,
    ...fields,
  };
}

const RECEIPT = pull(614, { title: 'Send a receipt after checkout' });
const EXPORT = pull(612, { title: 'Rate-limit the export endpoint' });
const LAYERS = [pull(700, { title: 'Layer one' }), pull(701, { title: 'Layer two', base: 'b700' })];

/** A review thread whose agent (Claude Code, session ses_receipt) is live. */
function reviewed(thread: string, pulls: InboxPull[]): InboxReviewRow {
  const stack = inboxPullStacks(pulls)[0]!;
  return {
    id: thread,
    reviewed: true,
    move: 'on_you',
    reason: 'review_ready',
    thread_id: thread,
    review: null,
    stacks: [stack],
    pull_keys: pulls.map((p) => p.key),
    link: { via: 'owner', thread_id: thread, thread_subject: null, project_id: 'prj_fern', agent: { host: 'claude-code', session: `ses_${thread}`, name: 'Claude Code' }, last: null, guide: null },
    pull_reason: null,
    landed: [],
    updated_at: ago(HOUR),
  } as InboxReviewRow;
}

const ROWS = [reviewed('thr_receipt', [RECEIPT]), reviewed('thr_export', [EXPORT]), reviewed('thr_stack', LAYERS)];
const MODEL = { fetched_at: ago(60_000), hosts: [{ cli: 'gh', host: 'github.com', login: 'charlie-dunn' }], pulls: [RECEIPT, EXPORT, ...LAYERS], links: {}, projects: { 'github.com/harbor/fern-api': ['prj_fern'] }, cards: {} } as unknown as InboxPullsAnswer;
const ANSWER: InboxReviewsAnswer = { fetched_at: MODEL.fetched_at, hosts: MODEL.hosts, rows: ROWS, projects: MODEL.projects };

function ship(key: string, fields: Partial<InboxShipView> = {}): InboxShipView {
  return {
    id: `shp_${key.split('#')[1]}`,
    key,
    url: 'https://github.com/harbor/fern-api/pull/614',
    title: 'Send a receipt after checkout',
    number: Number(key.split('#')[1]),
    repo: 'harbor/fern-api',
    host: 'github.com',
    thread_id: 'thr_receipt',
    project_id: 'prj_fern',
    agent: { host: 'claude-code', session: 'ses_thr_receipt', name: 'Claude Code' },
    started_at: ago(HOUR),
    state: 'shipping',
    reason: null,
    ended_at: null,
    merged_at: null,
    ...fields,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => window.localStorage?.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const shipped: { target: ShipTarget; option: PullThreadOption }[] = [];
const stopped: string[] = [];
function draw(ships: ReadonlyMap<string, InboxShipView> = new Map(), phone = false, rows: InboxReviewRow[] = ROWS) {
  const answer = rows === ROWS ? ANSWER : { ...ANSWER, rows };
  shipped.length = 0;
  stopped.length = 0;
  const handlers: ShipHandlers = {
    ships,
    repoProjects: ANSWER.projects,
    onShip: (target, option) => shipped.push({ target, option }),
    onLog: () => {},
    onStop: (s) => stopped.push(s.id),
  };
  const node = (
    <ReviewsMenu className="ib-lbody" rows={rows} links={{}} phone={phone} onTarget={() => {}} onHide={() => {}} ship={handlers}>
      <ReviewsList answer={answer} model={MODEL} rows={rows} filter="all" projectNames={new Map()} selected={null} phone={phone} onOpen={() => {}} onNew={() => {}} ships={ships} />
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
async function rightClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200 }));
  });
}
const menuWords = () => [...document.querySelectorAll('[data-reviews-menu] [role="menuitem"]')].map((item) => item.textContent?.trim());

test.skipIf(!hasDom)('Ship is first in the menu, and one click ships with the agent already on the review, in its thread', async () => {
  draw();
  await rightClick(row('thr_receipt'));
  expect(menuWords()).toEqual(['Ship', 'Hide pull request']);
  // The item shows who will do it: the agent's mark, then the submenu's chevron.
  expect($('[data-ship] .ib-shp-end')!.children.length).toBe(2);
  await act(async () => $('[data-ship]')!.click());
  expect(shipped).toHaveLength(1);
  expect(shipped[0]!.target.threadId).toBe('thr_receipt');
  expect(shipped[0]!.target.pull.key).toBe(RECEIPT.key);
  expect(shipped[0]!.option.to).toEqual({ host: 'claude-code', session: 'ses_thr_receipt' });
});

test.skipIf(!hasDom)('a row about a stack of several PRs offers no Ship: a ship is one pull request', async () => {
  draw();
  await rightClick(row('thr_stack'));
  expect(menuWords()).toEqual(['Hide 2 pull requests']);
});

test.skipIf(!hasDom)("a phone's Ship opens the agent sheet on the review's agent; a tap on an agent ships with it", async () => {
  draw(new Map(), true);
  await rightClick(row('thr_export'));
  await act(async () => $('[data-ship]')!.click());
  const sheet = $('[data-ship-sheet]');
  expect(sheet).not.toBeNull();
  const chosen = sheet!.querySelector<HTMLElement>('[data-ship-agent][data-on]');
  expect(chosen?.getAttribute('data-ship-agent')).toBe('ses_thr_export');
  await act(async () => chosen!.click());
  expect(shipped.map((s) => s.option.to)).toEqual([{ host: 'claude-code', session: 'ses_thr_export' }]);
  expect(shipped[0]!.target.threadId).toBe('thr_export');
});

test.skipIf(!hasDom)('a shipping row: the water and the sail on it alone, and its menu says Ship log and Stop shipping', async () => {
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key)]]));
  expect(row('thr_receipt').getAttribute('data-ship')).toBe('shipping');
  expect(row('thr_receipt').querySelector('.ib-shp')).not.toBeNull();
  expect(row('thr_receipt').querySelector('.ib-rvr-mark .ib-shp-sail')).not.toBeNull();
  // Rows not in ship mode carry none of it.
  expect(row('thr_export').hasAttribute('data-ship')).toBe(false);
  expect(document.querySelectorAll('.ib-shp')).toHaveLength(1);
  await rightClick(row('thr_receipt'));
  expect(menuWords()).toEqual(['Ship log', 'Stop shipping', 'Hide pull request']);
  await act(async () => $('[data-ship-stop]')!.click());
  expect(stopped).toEqual(['shp_614']);
});

test.skipIf(!hasDom)('stuck says why on the row and keeps the sail; merged keeps no water and says when; an old merge is a plain row', () => {
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key, { state: 'stuck', reason: 'e2e-checkout failing' })]]));
  expect(row('thr_receipt').getAttribute('data-ship')).toBe('stuck');
  expect(row('thr_receipt').querySelector('[data-ship-words]')!.textContent).toContain('Stuck: e2e-checkout failing');
  // "Stuck: " drawn apart from the reason, which alone may be cut; the whole words are the tooltip.
  expect(row('thr_receipt').querySelector('.ib-shp-head')!.textContent).toBe('Stuck: ');
  expect(row('thr_receipt').querySelector('.ib-shp-why')!.textContent).toBe('e2e-checkout failing');
  expect(row('thr_receipt').querySelector('[data-ship-words]')!.getAttribute('title')).toBe('Stuck: e2e-checkout failing');
  expect(row('thr_receipt').querySelector('.ib-shp-sail')).not.toBeNull();
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key, { state: 'merged', merged_at: ago(5 * 60_000), ended_at: ago(5 * 60_000) })]]));
  expect(row('thr_receipt').getAttribute('data-ship')).toBe('merged');
  expect(row('thr_receipt').querySelector('.ib-shp')).toBeNull();
  expect(row('thr_receipt').querySelector('[data-ship-words]')!.textContent).toMatch(/Merged \d/);
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key, { state: 'merged', merged_at: ago(30 * HOUR), ended_at: ago(30 * HOUR) })]]));
  expect(row('thr_receipt').hasAttribute('data-ship')).toBe(false);
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key, { state: 'stopped', ended_at: ago(60_000) })]]));
  expect(row('thr_receipt').hasAttribute('data-ship')).toBe(false);
});

test.skipIf(!hasDom)("a shipped PR's thread, its PR merged (no stack left, the landing only), says Merged under the PR's title", () => {
  const at = ago(5 * 60_000);
  const landed: InboxReviewRow = {
    ...reviewed('thr_receipt', [RECEIPT]),
    move: 'agents',
    reason: 'curating',
    stacks: [],
    pull_keys: [],
    landed: [{ key: RECEIPT.key, thread_id: 'thr_receipt', state: 'merged', at, url: RECEIPT.url, number: 614, title: RECEIPT.title, platform: 'github', head: RECEIPT.head, through_review: null }],
  };
  draw(new Map([[RECEIPT.key, ship(RECEIPT.key, { state: 'merged', merged_at: at, ended_at: at })]]), false, [landed]);
  expect(row('thr_receipt').getAttribute('data-ship')).toBe('merged');
  expect(row('thr_receipt').querySelector('[data-ship-words]')!.textContent).toMatch(/Merged \d/);
  expect(row('thr_receipt').textContent).toContain('Send a receipt after checkout');
});

test.skipIf(!hasDom)("a thread that shipped twice: yesterday's merge never hides today's, and the row is of today's PR", () => {
  const old = ago(30 * HOUR);
  const at = ago(5 * 60_000);
  const landing = (p: InboxPull, when: string) => ({ key: p.key, thread_id: 'thr_receipt', state: 'merged' as const, at: when, url: p.url, number: p.number, title: p.title, platform: 'github' as const, head: p.head, through_review: null });
  const landed: InboxReviewRow = { ...reviewed('thr_receipt', [RECEIPT]), stacks: [], pull_keys: [], landed: [landing(EXPORT, old), landing(RECEIPT, at)] };
  const ships = new Map([
    [EXPORT.key, ship(EXPORT.key, { state: 'merged', merged_at: old, ended_at: old, title: EXPORT.title })],
    [RECEIPT.key, ship(RECEIPT.key, { state: 'merged', merged_at: at, ended_at: at })],
  ]);
  draw(ships, false, [landed]);
  expect(row('thr_receipt').getAttribute('data-ship')).toBe('merged');
  expect(row('thr_receipt').querySelector('[data-ship-words]')!.textContent).toMatch(/Merged \d/);
  expect(row('thr_receipt').textContent).toContain('Send a receipt after checkout');
  expect(row('thr_receipt').textContent).not.toContain('Rate-limit the export endpoint');
});

function stubLog(log: InboxShipLogEntry[]) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ ship: ship(RECEIPT.key), log }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

async function drawLog(view: InboxShipView, onStop: () => void) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ShipLogBody ship={view} onStop={onStop} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test.skipIf(!hasDom)('the ship log: newest first, the newest marked, a commit as code, and Stop while it ships', async () => {
  const asked = stubLog([
    { at: ago(2 * 60_000), by: 'agent', kind: 'step', text: 'Pushed a fix', sha: 'a3f9c21' },
    { at: ago(10 * 60_000), by: 'inbox', kind: 'checks_failed', text: 'Checks failed: e2e-checkout' },
    { at: ago(20 * 60_000), by: 'inbox', kind: 'started', text: 'Started' },
  ]);
  let stops = 0;
  await drawLog(ship(RECEIPT.key), () => (stops += 1));
  expect(asked[0]).toContain('/api/inbox/ships/log?id=shp_614');
  const entries = [...document.querySelectorAll('[data-ship-log] .ib-shp-e')];
  expect(entries.map((e) => e.getAttribute('data-kind'))).toEqual(['step', 'checks_failed', 'started']);
  expect(entries[0]!.hasAttribute('data-now')).toBe(true);
  expect(entries[0]!.querySelector('code')!.textContent).toBe('a3f9c21');
  await act(async () => $('[data-ship-log-stop]')!.click());
  expect(stops).toBe(1);
});

test.skipIf(!hasDom)('an ended ship keeps its log and offers no Stop', async () => {
  stubLog([{ at: ago(60_000), by: 'inbox', kind: 'merged', text: 'Merged' }]);
  await drawLog(ship(RECEIPT.key, { state: 'merged', merged_at: ago(60_000), ended_at: ago(60_000) }), () => {});
  expect($('[data-ship-log-stop]')).toBeNull();
  expect(document.querySelectorAll('[data-ship-log] .ib-shp-e')).toHaveLength(1);
});
