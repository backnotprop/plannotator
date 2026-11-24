/**
 * The board's bar while PRs are picked stays one row however narrow (approval "inbox-pr-board-close-safe"; Reviews'
 * right pane is about 700 px). What regresses: the bar wrapping its actions to a second row instead of stepping down;
 * the steps out of order (a shorter field first, "Filter"; then "Review" for Start review thread, its full words kept as
 * its title; then the field's icon alone); a bar that went narrow not stepping back up when there is room again; the
 * steps reaching the bar outside select mode. The widths a browser would measure are stood in for here; the real row
 * at 700 px is the browser spec's (tests/e2e/inbox-pr-board-close.spec.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { BAR_FITS, firstFit, type BarFit } from './useBarFit';

const hasDom = typeof document !== 'undefined';
const { SheetPage } = (hasDom ? await import('./SheetPage') : {}) as typeof import('./SheetPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const pull = (number: number): InboxPull =>
  ({
    key: `github.com/northwind/ledger#${number}`, platform: 'github', host: 'github.com', repo: 'northwind/ledger', number, url: '', title: `Change ${number}`,
    author: 'dana', mine: true, requested: false, state: 'open', base: 'main', head: `b${number}`, head_repo: 'northwind/ledger', head_sha: String(number).padStart(40, 'a'),
    additions: 1, deletions: 1, files: 1, review: 'approved', approved_by: 'jun', reviewers: ['jun'], checks: 'success', conflicts: false, updated_at: '2026-11-08T09:00:00.000Z', merged_at: null,
  }) as InboxPull;
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-09T11:59:00.000Z', hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }], pulls: [pull(7), pull(8)], links: {},
  projects: { 'github.com/northwind/ledger': ['prj_ledger'] }, cards: {}, clis: { gh: 'signed_in' }, unsigned: [],
};

/** What the bar's row needs at each step, against the width it has: a browser's measure, stood in for. */
let rowNeeds: Record<BarFit, number> = { full: 900, short: 780, review: 700, icon: 640 };
let barHas = 1200;
const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  const proto = HTMLDivElement.prototype;
  for (const name of ['scrollWidth', 'clientWidth']) saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('ib-prs-bar') ? barHas : 0; } });
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const fit = this.getAttribute('data-fit') as BarFit | null;
      return this.classList.contains('ib-prs-bar') ? Math.max(barHas, fit ? rowNeeds[fit] : 0) : 0;
    },
  });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  const proto = HTMLDivElement.prototype;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(proto, name, descriptor);
    else delete (proto as unknown as Record<string, unknown>)[name];
  }
  rowNeeds = { full: 900, short: 780, review: 700, icon: 640 };
  barHas = 1200;
});

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const click = (selector: string) => act(() => $(selector)!.click());

function draw() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <div className="pn-inbox">
        <SidebarProvider>
          <SheetPage mode="pane" model={MODEL} error={null} loading={false} phone={false} view="open" risk={{}} now={Date.parse('2026-11-09T12:00:00Z')} layout="grid" onLayout={() => {}} onView={() => {}} onOpenPull={() => {}} onOpenStack={() => {}} onMerged={() => {}} />
        </SidebarProvider>
      </div>,
    ),
  );
}

test('the steps, tried in order: the first whose row fits, the last when none does', () => {
  const tried: BarFit[] = [];
  expect(firstFit((fit) => tried.push(fit), () => tried.at(-1) === 'review')).toBe('review');
  expect(tried).toEqual(['full', 'short', 'review']);
  expect(firstFit(() => {}, () => false)).toBe(BAR_FITS.at(-1)!);
});

test('picked in a 700 px pane: a shorter field, then Review, then the icon; wide again, the full bar', () => {
  if (!hasDom) return;
  draw();
  // Outside a pick the bar is as it was: no step on it.
  expect($('.ib-prs-bar')!.hasAttribute('data-fit')).toBe(false);
  click('[data-pr-select="select"]');
  click('[data-pr-tile="github.com/northwind/ledger#7"]');
  const bar = $('.ib-prs-bar')!;
  const input = () => $('[data-pr-filter]') as HTMLInputElement;
  expect(bar.dataset.fit).toBe('full');
  expect(input().placeholder).toBe('Filter by title, author, repository or number');

  // The pane narrows to 700: the row fits once Start review thread says Review.
  barHas = 700;
  click('[data-pr-tile="github.com/northwind/ledger#8"]');
  expect(bar.dataset.fit).toBe('review');
  expect(input().placeholder).toBe('Filter');
  expect($('[data-pr-review]')!.getAttribute('title')).toBe('Start review thread');
  expect($('[data-pr-review] .ib-prs-short')!.textContent).toBe('Review');

  // Narrower still: the field is its icon, still the field (it keeps filtering).
  barHas = 640;
  click('[data-pr-tile="github.com/northwind/ledger#8"]');
  expect(bar.dataset.fit).toBe('icon');
  expect(input()).not.toBeNull();
  expect(input().closest('.ib-prs-field')!.getAttribute('title')).toBe('Filter pull requests');

  // Room again: back up to the full bar.
  barHas = 1200;
  click('[data-pr-tile="github.com/northwind/ledger#8"]');
  expect(bar.dataset.fit).toBe('full');

  // Done: no step left on the bar.
  click('[data-pr-select="done"]');
  expect(bar.hasAttribute('data-fit')).toBe(false);
});
