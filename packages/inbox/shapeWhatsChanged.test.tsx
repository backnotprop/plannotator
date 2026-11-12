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
import { bridgeSanitizerDom } from '../../tests/helpers/chat-sanitizer-dom';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
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
  restore.push(bridgeSanitizerDom());
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

function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-whats-changed-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const picture = { html: '<p data-mark="k" data-code="src/settings.ts#L12">One whistle</p>' };
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
function inDrawing(selector: string): Element | null {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector(selector);
    if (found) return found;
  }
  return null;
}
async function clickPart() {
  for (let i = 0; i < 50 && !inDrawing('[data-code]'); i++) await wait();
  await act(async () => void inDrawing('[data-code]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })));
  await wait();
}

test.skipIf(!hasDom)("the Inbox's board has no Code tab and no What's changed, and none of its words or the review's buttons show", async () => {
  await mount(THREAD);
  expect(tabs()).toEqual(['Shape', 'How it works']);
  expect(document.querySelector('.shp-view.v-picture')).not.toBeNull();
  for (const words of [KETTLE_CHANGED.summary!, KETTLE_CHANGED.items[0]!.title, 'Guided review', 'Full review', 'Guide step']) expect(document.body.textContent).not.toContain(words);
});

test.skipIf(!hasDom)("a drawn part's place in code opens the thread's newest review there", async () => {
  const opened = await mount(THREAD);
  await clickPart();
  for (let i = 0; i < 20 && !opened.length; i++) await wait();
  expect(opened).toEqual([[REVIEW, { path: 'src/settings.ts', line: 12 }]]);
  expect(guideReads.every((p) => p.includes(REVIEW))).toBe(true);
});

test.skipIf(!hasDom)('a thread with no review: a drawn part opens no review', async () => {
  const opened = await mount(PLAIN);
  await clickPart();
  await wait();
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
  expect(esc().defaultPrevented).toBe(false);
  expect(panelOpen()).toBe(true);
  cover(false);
  expect(document.querySelector('[data-shape-layer]')!.hasAttribute('inert')).toBe(false);
  expect(esc().defaultPrevented).toBe(true);
  expect(panelOpen()).toBe(false);
});
