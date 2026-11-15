/**
 * A stack's page: choosing a range of layers and "Changed since you looked" (approval "inbox-pr-dashboard", q-0a2467a4
 * and q-6cf84c0b). What regresses:
 *  - a plain click no longer opening the layer, or a click while choosing opening it instead of picking it;
 *  - a shift-click not picking an end, or the bar not naming the range ("Layers 3–5 as one diff") once both are;
 *  - Open as one diff opening anything but the range on its top layer (or Whole stack from the lowest open layer);
 *  - Choose a range offered on a stack with fewer than three open layers;
 *  - a layer whose head moved since the person opened it not marked, one never opened marked, or the header not
 *    counting them; another window's look not reaching the page;
 *  - a look kept only in this browser: another browser, the phone or another machine's window not seeing it, a linked
 *    machine's PR's look kept anywhere but on that machine, a machine too old to keep looks sent one (its refusal would
 *    show) or its PRs no longer marked, and a look from before not sent on once.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { PullViewScope } from '../pulls/viewScope';

const hasDom = typeof document !== 'undefined';
const { StackPage } = (hasDom ? await import('./StackPage') : {}) as typeof import('./StackPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { markLooked, resetLookedVisits } = (hasDom ? await import('./looked') : {}) as typeof import('./looked');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const pr = (number: number, head: string, base: string, over: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/northwind/ledger#${number}`,
  platform: 'github',
  host: 'github.com',
  repo: 'northwind/ledger',
  number,
  url: `https://github.com/northwind/ledger/pull/${number}`,
  title: `Change ${number}`,
  author: 'dana',
  mine: true,
  requested: false,
  state: 'open',
  base,
  head,
  head_repo: 'northwind/ledger',
  head_sha: String(number).padStart(40, 'a'),
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  conflicts: false,
  updated_at: '2026-11-09T10:00:00Z',
  merged_at: null,
  ...over,
});
const key = (n: number) => `github.com/northwind/ledger#${n}`;
// main ← #1 (merged) ← #2 ← #3 ← #4 ← #5.
const layers = [pr(1, 'one', 'main', { state: 'merged', merged_at: '2026-11-08T10:00:00Z' }), pr(2, 'two', 'one'), pr(3, 'three', 'two'), pr(4, 'four', 'three'), pr(5, 'five', 'four')];

let host: HTMLDivElement;
let root: Root;
let opened: { key: string; scope?: PullViewScope }[];
let savedFetch: typeof fetch;
/** The machines' kept looks, by where they were sent (`''` this machine, else the linked machine's id). */
let kept: Map<string, Record<string, { sha: string; at: number }>>;
let posts: { at: string; seen: { key: string; sha: string; at: number }[] }[];
beforeEach(() => {
  if (!hasDom) return;
  window.localStorage.clear();
  resetLookedVisits();
  opened = [];
  kept = new Map();
  posts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://127.0.0.1').pathname;
    const at = /^\/api\/inbox\/(?:m\/([^/]+)\/)?pulls\/looked$/.exec(path);
    if (!at) return Response.json({ error: 'not here' }, { status: 404 });
    const { seen } = JSON.parse(String(init?.body)) as { seen: { key: string; sha: string; at: number }[] };
    posts.push({ at: at[1] ?? '', seen });
    const machine = kept.get(at[1] ?? '') ?? {};
    for (const look of seen) machine[look.key] = { sha: look.sha, at: look.at };
    kept.set(at[1] ?? '', machine);
    return Response.json({ looked: machine });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

function draw(pulls: InboxPull[] = layers, board?: Pick<InboxPullsAnswer, 'pulls' | 'machines'>) {
  const stack = inboxPullStacks(pulls)[0]!;
  act(() =>
    root.render(
      <SidebarProvider>
        <StackPage stack={stack} loading={false} board={board ?? null} repoLabel="ledger" phone={false} now={NOW} onBack={() => {}} onOpenLayer={(pull, scope) => opened.push({ key: pull.key, ...(scope ? { scope } : {}) })} />
      </SidebarProvider>,
    ),
  );
}
const row = (n: number) => host.querySelector<HTMLButtonElement>(`[data-pr-layer="${key(n)}"]`)!;
const click = (el: Element, shiftKey = false) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })));
const bar = () => host.querySelector('[data-pr-stack-range]');

test.if(hasDom)('a plain click opens the layer; a shift-click picks an end and opens nothing', () => {
  draw();
  click(row(4));
  expect(opened).toEqual([{ key: key(4) }]);
  click(row(3), true);
  expect(opened).toHaveLength(1);
  expect(row(3).hasAttribute('data-picked')).toBe(true);
  expect(bar()?.textContent).toContain('1 of 5 layers');
});

test.if(hasDom)('both ends picked: the bar names the range and opens it on its top layer', () => {
  draw();
  click(row(5), true);
  click(row(3), true);
  expect(bar()?.getAttribute('data-pr-stack-range')).toBe('ready');
  expect(host.querySelector('[data-pr-stack-range-name]')?.textContent).toBe('Layers 3–5 as one diff');
  expect(bar()?.textContent).toContain('3 of 5 layers');
  expect([3, 4, 5].every((n) => row(n).hasAttribute('data-picked'))).toBe(true);
  expect(row(2).hasAttribute('data-picked')).toBe(false);
  click(host.querySelector('[data-pr-stack-range-open]')!);
  expect(opened).toEqual([{ key: key(5), scope: `range:${key(3)}` }]);
});

test.if(hasDom)('from the lowest open layer it opens Whole stack up to the top end', () => {
  draw();
  click(row(2), true);
  click(row(4), true);
  click(host.querySelector('[data-pr-stack-range-open]')!);
  expect(opened).toEqual([{ key: key(4), scope: 'stack' }]);
});

test.if(hasDom)('Choose a range: clicks pick instead of opening; Clear leaves it', () => {
  draw();
  click(host.querySelector('[data-pr-stack-choose]')!);
  expect(bar()?.textContent).toContain('0 of 5 layers');
  click(row(4));
  expect(opened).toEqual([]);
  expect(row(4).getAttribute('aria-pressed')).toBe('true');
  // A merged layer is no end.
  click(row(1));
  expect(row(1).hasAttribute('data-picked')).toBe(false);
  click(host.querySelector('[data-pr-stack-range-clear]')!);
  expect(bar()).toBeNull();
  click(row(4));
  expect(opened).toEqual([{ key: key(4) }]);
});

test.if(hasDom)('no range is offered with fewer than three open layers, and a shift-click opens the layer', () => {
  draw(layers.slice(0, 3));
  expect(host.querySelector('[data-pr-stack-choose]')).toBeNull();
  click(row(3), true);
  expect(opened).toEqual([{ key: key(3) }]);
});

test.if(hasDom)('a layer whose head moved since the person opened it is marked and counted; one never opened is not', () => {
  markLooked([
    { key: key(3), sha: 'b'.repeat(40) },
    { key: key(4), sha: String(4).padStart(40, 'a') },
  ]);
  draw();
  expect(row(3).hasAttribute('data-pr-layer-changed')).toBe(true);
  expect(row(3).getAttribute('aria-label')).toContain('changed since you looked');
  expect(row(4).hasAttribute('data-pr-layer-changed')).toBe(false);
  expect(row(5).hasAttribute('data-pr-layer-changed')).toBe(false);
  expect(host.querySelector('[data-pr-stack-changed]')?.textContent).toBe('1 changed since you looked');
});

test.if(hasDom)("another window's look reaches the page", () => {
  markLooked([{ key: key(3), sha: 'b'.repeat(40) }]);
  draw();
  expect(row(3).hasAttribute('data-pr-layer-changed')).toBe(true);
  act(() => {
    window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ [key(3)]: { sha: String(3).padStart(40, 'a'), at: 1 } }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'plannotator-inbox-pull-looked' }));
  });
  expect(row(3).hasAttribute('data-pr-layer-changed')).toBe(false);
  expect(host.querySelector('[data-pr-stack-changed]')).toBeNull();
});

const B = 'ibx_01K0000000000000000000000B';
/** The board as a machine answers it: each layer with the look kept where it is listed. */
const boardOf = (pulls: InboxPull[], machines: InboxPullsAnswer['machines'] = undefined) => ({
  pulls: pulls.map((p) => {
    const look = kept.get(p.machine ?? '')?.[p.key];
    return look ? { ...p, looked: look } : p;
  }),
  machines,
});
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 0))));
/** Another browser, the phone, or another machine's window: nothing in this browser's storage. */
function elsewhere() {
  act(() => root.unmount());
  window.localStorage.clear();
  resetLookedVisits();
  root = createRoot(host);
}

test.if(hasDom)('a look is kept on the machine: another browser, the phone or another machine sees the same marks', async () => {
  const board = boardOf(layers);
  markLooked([{ key: key(3), sha: 'b'.repeat(40) }], board);
  await settle();
  expect(posts).toEqual([{ at: '', seen: [{ key: key(3), sha: 'b'.repeat(40), at: expect.any(Number) }] }]);
  elsewhere();
  draw(layers, boardOf(layers));
  expect(row(3).hasAttribute('data-pr-layer-changed')).toBe(true);
  expect(host.querySelector('[data-pr-stack-changed]')?.textContent).toBe('1 changed since you looked');
});

test.if(hasDom)("a linked machine's stack: its looks are kept on that machine and read back from it", async () => {
  const far = layers.map((p) => ({ ...p, machine: B }));
  markLooked([{ key: key(4), sha: 'c'.repeat(40) }], boardOf(far, { [B]: { read_at: null, pending: false, looked: true } }));
  await settle();
  expect(posts.map((p) => p.at)).toEqual([B]);
  elsewhere();
  draw(far, boardOf(far, { [B]: { read_at: null, pending: false, looked: true } }));
  expect(row(4).hasAttribute('data-pr-layer-changed')).toBe(true);
});

test.if(hasDom)('a machine too old to keep looks is sent none and shows nothing new; this browser still marks its PRs', async () => {
  const far = layers.map((p) => ({ ...p, machine: B }));
  const old = { [B]: { read_at: null, pending: false } };
  markLooked([{ key: key(4), sha: 'c'.repeat(40) }], boardOf(far, old));
  draw(far, boardOf(far, old));
  await settle();
  expect(posts).toEqual([]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(row(4).hasAttribute('data-pr-layer-changed')).toBe(true);
});

test.if(hasDom)("a look from before, kept only in this browser, is sent to its machine once", async () => {
  window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ [key(5)]: { sha: 'd'.repeat(40), at: 5 } }));
  draw(layers, boardOf(layers));
  await settle();
  draw(layers, boardOf(layers));
  await settle();
  expect(posts).toEqual([{ at: '', seen: [{ key: key(5), sha: 'd'.repeat(40), at: 5 }] }]);
  expect(kept.get('')?.[key(5)]).toEqual({ sha: 'd'.repeat(40), at: 5 });
});
