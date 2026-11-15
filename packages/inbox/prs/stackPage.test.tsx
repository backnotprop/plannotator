/**
 * A stack's page: choosing a range of layers and "Changed since you looked" (approval "inbox-pr-dashboard", q-0a2467a4
 * and q-6cf84c0b). What regresses:
 *  - a plain click no longer opening the layer, or a click while choosing opening it instead of picking it;
 *  - a shift-click not picking an end, or the bar not naming the range ("Layers 3–5 as one diff") once both are;
 *  - Open as one diff opening anything but the range on its top layer (or Whole stack from the lowest open layer);
 *  - Choose a range offered on a stack with fewer than three open layers;
 *  - a layer whose head moved since the person opened it not marked, one never opened marked, or the header not
 *    counting them; another window's look not reaching the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
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
beforeEach(() => {
  if (!hasDom) return;
  window.localStorage.clear();
  resetLookedVisits();
  opened = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

function draw(pulls: InboxPull[] = layers) {
  const stack = inboxPullStacks(pulls)[0]!;
  act(() =>
    root.render(
      <SidebarProvider>
        <StackPage stack={stack} loading={false} repoLabel="ledger" phone={false} now={NOW} onBack={() => {}} onOpenLayer={(pull, scope) => opened.push({ key: pull.key, ...(scope ? { scope } : {}) })} />
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
