/**
 * Plannotator's board in the Inbox (approval "shape-whats-changed"): no Code tab, even on a board the agent gave
 * one; What's changed after How it works; and its links open the thread's own review. The real ShapeLayer and
 * board, the Inbox's doors stubbed at `fetch`. What regresses:
 *  - the Code tab comes back on the Inbox's board;
 *  - What's changed leaves its place, or a board in a thread with a review cannot open that review from it;
 *  - a guide step or a `file:line` opens a review other than the thread's newest, or at the wrong place;
 *  - a board with no review in its thread shows review buttons that lead nowhere;
 *  - the board under an open review takes the first Esc (closing its own panel) instead of leaving it to the review.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost, ShapeLoaded, ShapeReviewAt } from '@plannotator/ui/components/shape';
import { createShapeStore } from '../shared/shape/store';
import { KETTLE_CHANGED } from '../../tests/fixtures/shape-whats-changed';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  // The real board. By a path in a variable: the window's strict typecheck must not follow it into review-editor.
  const seam: string = './shape/ShapeBoard.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#shape-board', () => real);
}
const { ShapeLayer } = (hasDom ? await import('./shape/ShapeParts') : {}) as typeof import('./shape/ShapeParts');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const OLD_REVIEW = 'msg_01M4H6G73M9H3Z32T859E7OLDR';
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E7NEWR';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Kettle', intent: '', sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] }, { title: 'The setting', overview: '', diffs: [{ file: 'src/settings.ts', summary: '' }] }] },
  reviewed: [false, false],
  review: { rawPatch: ['src/kettle.ts', 'src/settings.ts'].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`).join(''), gitRef: 'main...HEAD', source: { kind: 'pr', pr: { url: 'https://github.com/acme/kettle/pull/12', number: 12 } } },
  exportedAt: '2026-11-05T10:00:00.000Z',
});
const reviewMessage = (id: string) =>
  ({ id, guide: { sha256: id, input_sha256: 'b', bytes: 1, title: 'Kettle', sections: 2, files: 2, additions: 2, deletions: 2, review: true, source: { kind: 'pr', pr: { url: 'https://github.com/acme/kettle/pull/12', number: 12 } } } }) as unknown as InboxMessageWire;
const THREAD = { thread_id: 'thr_1', messages: [reviewMessage(OLD_REVIEW), reviewMessage(REVIEW)], project: { root: '/work/kettle', repo: null } } as unknown as InboxThread;
const PLAIN = { thread_id: 'thr_2', messages: [], project: { root: '/work/kettle', repo: null } } as unknown as InboxThread;

let root: Root | null = null;
const dirs: string[] = [];
const restore: Array<() => void> = [];
let guideReads: string[] = [];
beforeEach(() => {
  if (!hasDom) return;
  guideReads = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) {
      guideReads.push(path);
      return Response.json({ message_id: REVIEW, guide: {}, snapshot });
    }
    return Response.json({});
  }) as typeof fetch;
  restore.push(() => (globalThis.fetch = saved));
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const undo of restore.splice(0)) undo();
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A board the agent gave every view, Code included, stored as the Inbox stores it. */
function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-whats-changed-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const picture = { html: '<p data-mark="k">One whistle</p>' };
  const code = { stage: 'after' as const, guide: { title: 'Kettle', intent: '', sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts' }] }] } };
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture, how: picture, changed: KETTLE_CHANGED, know: 'Once.', code } }, project: { root: dir, name: 'kettle' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

let cover: (on: boolean) => void = () => {};

async function mount(thread: InboxThread | null): Promise<[string, ShapeReviewAt | null][]> {
  const loaded = board();
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
    readFile: async () => '',
  };
  const opened: [string, ShapeReviewAt | null][] = [];
  const el = document.createElement('div');
  el.className = 'pn-inbox';
  document.body.appendChild(el);
  root = createRoot(el);
  const onOpenReview = (id: string, at: ShapeReviewAt | null) => opened.push([id, at]);
  const draw = (covered: boolean) =>
    root!.render(
      <SidebarProvider open onOpenChange={() => {}}>
        <main className="ib-main" data-shape-open="">
          <ShapeLayer host={host} id={loaded.shape.id} onClose={() => {}} thread={thread} onOpenReview={onOpenReview} covered={covered} />
        </main>
      </SidebarProvider>,
    );
  cover = (on) => act(() => draw(on));
  act(() => draw(false));
  for (let i = 0; i < 100 && !el.querySelector('.shp-dock'); i++) await wait();
  return opened;
}
const wait = () => act(() => new Promise((r) => setTimeout(r, 20)));
const tabs = () => [...document.querySelectorAll<HTMLElement>('.shp-dock [aria-label="Views"] .shp-tbtn')].map((b) => b.title);
const button = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === words || b.getAttribute('aria-label') === words) ?? null;
async function openChanged() {
  await act(async () => document.querySelector<HTMLElement>('.shp-dock [title="What\'s changed"]')!.click());
  for (let i = 0; i < 20 && !document.querySelector('.shp-chg'); i++) await wait();
}

test.skipIf(!hasDom)("the Inbox's board has no Code tab, and What's changed sits after How it works", async () => {
  await mount(THREAD);
  expect(tabs()).toEqual(['Picture', 'How it works', "What's changed", 'What to know']);
  // It still opens on the Picture.
  expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
});

test.skipIf(!hasDom)("What's changed opens the thread's newest review: its buttons, a step, a file:line", async () => {
  const opened = await mount(THREAD);
  await openChanged();
  expect(document.querySelector('.shp-chg-meta')?.textContent).toContain('#12');
  await act(async () => button('Guided review')!.click());
  await act(async () => button('Full review')!.click());
  await act(async () => button('Guide step 2, open the guided review there')!.click());
  await act(async () => button('settings.ts:12, open src/settings.ts at line 12')!.click());
  for (let i = 0; i < 20 && opened.length < 4; i++) await wait();
  expect(opened).toEqual([[REVIEW, null], [REVIEW, { files: true }], [REVIEW, { step: 2 }], [REVIEW, { path: 'src/settings.ts', line: 12 }]]);
  expect(guideReads.every((p) => p.includes(REVIEW))).toBe(true);
});

test.skipIf(!hasDom)('a thread with no review: no review buttons or steps on the board', async () => {
  const opened = await mount(PLAIN);
  await openChanged();
  expect(button('Guided review')).toBeNull();
  expect(document.querySelector('.shp-chg-step')).toBeNull();
  expect(tabs()).not.toContain('Code');
  expect(opened).toEqual([]);
});

test.skipIf(!hasDom)('with the review open over the board, Esc is the review\'s: the board is inert and keeps its panel', async () => {
  await mount(THREAD);
  await act(async () => document.querySelector<HTMLElement>('.shp-dock [title="References"]')!.click());
  const panelOpen = () => !!document.querySelector('.shp-sidep.open');
  expect(panelOpen()).toBe(true);
  const esc = () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(e));
    return e;
  };
  cover(true);
  expect(document.querySelector('[data-shape-layer]')!.hasAttribute('inert')).toBe(true);
  // The host's own Esc (the Inbox: close the review) sees a key the board did not use.
  expect(esc().defaultPrevented).toBe(false);
  expect(panelOpen()).toBe(true);
  // Back on the board: Esc closes its panel again, first.
  cover(false);
  expect(document.querySelector('[data-shape-layer]')!.hasAttribute('inert')).toBe(false);
  expect(esc().defaultPrevented).toBe(true);
  expect(panelOpen()).toBe(false);
});

test.skipIf(!hasDom)('a guide step the review does not have is not drawn', async () => {
  const short = { ...THREAD, messages: [{ ...reviewMessage(REVIEW), guide: { ...reviewMessage(REVIEW).guide!, sections: 1 } }] } as unknown as InboxThread;
  await mount(short);
  await openChanged();
  // KETTLE_CHANGED's steps are 1 and 2; a one-chapter review shows only step 1.
  expect([...document.querySelectorAll('.shp-chg-step')].map((b) => b.textContent)).toEqual(['Guide step 1']);
});
