/**
 * A board opened from its thread fits within the thread view (the owner, 2026-11-16: "shape needs to appear to left
 * of artifacts", "I no longer like that it takes up the full screen and has a different background color. It should
 * just fit within the thread view."). The real slot (thread/ThreadSlot.tsx), the real thread pane and the real board
 * (`ShapeLayer` with `inThread`, as App.tsx hands it to the slot), the Inbox's doors stubbed at `fetch`.
 *
 * What regresses:
 *  - the Pebble leaving its place immediately left of Artifacts, on a desktop, a phone, a stacked window, the thread
 *    in full screen, or with the board open;
 *  - the board drawn as a window layer again (outside the thread's pane, `ib-wlayer`, its own background), or the
 *    thread's header going away under it; the messages or the reply box showing beside it;
 *  - the Pebble and Artifacts both showing their view (the board and the Artifacts view are one place);
 *  - the focus: the Pebble's press takes it to the board's title, and a close from the board (its ×) gives it back to
 *    the Pebble, as leaving the Artifacts view gives it to its button;
 *  - the board losing a control in a 400 px pane (the narrowest pane a thread gets): its views, Comment, References,
 *    Global comment and its ×;
 *  - the thread's keys acting under the board (R opening the hidden reply box, O a file beside the board);
 *  - the thread's scroll lost when the board closes (WebKit forgets a hidden scroller's, so the pane puts it back);
 *  - with Shape off, an old address naming a board keeping the Artifacts view shut, with no board in its place;
 *  - a one-message thread with no name losing its title from the bar while the board shows;
 *  - on a phone, the header's way back leaving the thread instead of the board (it reads ‹ Thread, as Artifacts' does);
 *  - the board's side panel growing back its Thread or Ask tab (it is References only, the owner 2026-11-16), or a
 *    reference to a message of the thread opening nothing now that the Thread tab is gone (it lands the thread there).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import { createShapeStore } from '../../shared/shape/store';
import type { InboxShapeSummary } from '../api';
import type { Route } from '../app/route';
import { machinesModel } from '../machines';
import { PHONE_QUERY } from '../phone';
import { createPanesOnScreen } from '../panes/onScreen';
import { NO_OPEN, type PaneReads } from '../panes/paneReads';
import { createKeyedSignal } from '../signal';
import { createStepsBus } from '../steps/useThreadSteps';
import type { ThreadSlotHost } from '../thread/slotHost';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  // The real board (tsconfig `paths` points the window's typecheck at its .d.ts). By a path in a variable: the
  // window's strict typecheck must not follow it into review-editor.
  const seam: string = './ShapeBoard.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#shape-board', () => real);
}
const { ThreadSlot } = (hasDom ? await import('../thread/ThreadSlot') : {}) as typeof import('../thread/ThreadSlot');
const { ShapeLayer } = (hasDom ? await import('./ShapeParts') : {}) as typeof import('./ShapeParts');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-12T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const T = 'msg_T1';

function message(id: string, seq: number, body: string): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: T,
    reply_to: id === T ? null : T,
    author: AGENT,
    subject: id === T ? 'Refund events: webhook or polling?' : null,
    body,
    created_at: `2026-10-12T17:${String(30 + seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
  };
}
const THREAD: InboxThread = {
  thread_id: T,
  project: PROJECT,
  subject: 'Refund events: webhook or polling?',
  thread_name: null,
  resolved_at: null,
  messages: [message(T, 1, 'Refunds can reach billing-svc two ways.'), message('msg_T2', 2, 'The board is up.')],
};
/** Two files: the Artifacts button with its count. */
const ATTACHMENTS = [0, 1].map((i) => ({
  id: `att_${i}`,
  message_id: T,
  path: `/work/billing-svc/notes/part-${i}.md`,
  name: `part-${i}.md`,
  named_path: null,
  kind: 'markdown',
  sent_sha256: '0'.repeat(64),
  size: 10,
  sent_at: '2026-10-12T17:31:00.000Z',
  sent_mtime: '2026-10-12T17:31:00.000Z',
  current: null,
  changed_since_sent: false,
  unavailable: null,
}));

const restore: (() => void)[] = [];
const dirs: string[] = [];
let root: Root | null = null;
let el: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  for (const undo of restore.splice(0).reverse()) undo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  document.body.innerHTML = '';
});

function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => (saved ? Object.defineProperty(target, key, saved) : delete (target as Record<string, unknown>)[key]));
}

/** The window as a phone (the Inbox's PHONE_QUERY matches) or a desktop, for this test only. */
function windowIs(phone: boolean) {
  stub(window, 'matchMedia', {
    value: (query: string) => ({ matches: phone && query === PHONE_QUERY, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
  });
}

function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-in-thread-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({
    board: { title: 'Two ways a refund arrives', claim: 'Webhook or polling.', views: { picture: { html: '<p data-mark="hook">Webhook</p>' }, how: { html: '<p data-mark="poll">Poll</p>' } }, refs: [{ n: 1, kind: 'link', title: 'Stripe docs', target: 'https://example.com/stripe' }, { n: 2, kind: 'message', title: 'The question', target: T }] },
    project: { root: dir, name: 'billing-svc' },
    session: { id: 'ses_a', host: 'claude-code' },
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

const noop = () => {};
const none = async () => null;

interface Drawn {
  routes: { kind: 'go' | 'close'; route: Route }[];
  draw: (route: Route) => void;
}

/** The window's side of the slot, as App.tsx builds it: `board` draws the real ShapeLayer in the thread's pane. */
function mount(options: { phone?: boolean; stacked?: boolean; full?: boolean; width?: number; route?: Partial<Route>; shapeOff?: boolean; thread?: InboxThread } = {}): Drawn & { id: string } {
  windowIs(options.phone ?? false);
  // happy-dom lays nothing out: the board reads the pane's width from here (its phone layout is ≤ 640 px).
  stub(HTMLElement.prototype, 'clientWidth', { get: () => options.width ?? 1000 });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return Response.json({ questions: [] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: ATTACHMENTS, annotations: [] });
    if (path.includes('/artifact-pins')) return Response.json({ pins: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  restore.push(() => (globalThis.fetch = savedFetch));
  const loaded = board();
  const id = loaded.shape.id;
  const shapeHost: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const summary: InboxShapeSummary = { id, title: 'Two ways a refund arrives', project: { name: 'billing-svc', root: '/work/billing-svc' }, thread: T, state: 'active', updated: new Date().toISOString(), latest: 1, seen: 1, changed: false, drawing: false, waiting: 0, session: null };
  const routes: Drawn['routes'] = [];
  const queries = new QueryClient();
  const thread = options.thread ?? THREAD;
  const on = !options.shapeOff;
  const draw = (route: Route) => {
    const go = (next: Route) => routes.push({ kind: 'go', route: next });
    const close = (next: Route) => routes.push({ kind: 'close', route: next });
    const host = {
      route, routeRef: { current: route }, rowsPending: false,
      paneReads: { view: () => ({ ...NO_OPEN, look: { threadId: T, seq: 2, through: 2 } }), retry: noop } as unknown as PaneReads,
      outbox: new Map(), dismissOutbox: noop, phone: options.phone ?? false, stack: { thread: options.stacked ?? false, file: false }, full: options.full ?? false, fromCard: null,
      fileOpen: false, staleNotice: null, notifyAgainIn: null, notifications: {} as ThreadSlotHost['notifications'], soundOn: false, settings: null,
      saveTour: noop, go, leave: noop, close, openCompose: noop, pullReviewOf: null, reviewView: null, pullsShown: false,
      stepsBus: createStepsBus(), boardEnabled: null, boardsOn: on, cards: null, backToCard: noop, openThreadRow: null, snoozeBack: null,
      refreshThread: none, refreshList: none, shown: null, markRead: none, markUnread: none, acknowledge: none,
      markAction: none, archive: none, pinnedIds: new Set(), pinsOn: false, machines: machinesModel([]), setPin: none, setPriority: noop,
      snoozeOn: false, snooze: noop, unsnooze: noop, setMachineUpdateOpen: noop, threadAgentContext: null, replyFor: null, setReplyFor: noop,
      draftSignals: createKeyedSignal(), filesSignals: createKeyedSignal(), shapes: { byThread: new Map([[T, summary]]) } as unknown as ThreadSlotHost['shapes'],
      // As App.tsx: always a function on the Inbox page; nothing drawn with no board open, or with Shape off.
      board: (inThread: boolean, sidebarToggle: boolean) =>
        on && route.shape ? <ShapeLayer host={shapeHost} id={route.shape} thread={thread} inThread={inThread} sidebarToggle={sidebarToggle} onClose={() => close({ ...route, shape: null })} /> : null,
      ask: { side: undefined, sideWords: undefined }, askReply: null, setAskReply: noop, shapeReply: null, setShapeReply: noop,
      patchQuestions: noop, onPickSaves: noop, afterWrite: async () => {}, rowPatches: new Map(), decideInThread: () => null,
      searchLanding: { current: null }, decideLanding: { current: null }, landed: noop,
      seenOnSight: noop, covered: false, panesOnScreen: createPanesOnScreen(), setOpenThreadCovered: noop, listTitle: 'Inbox', fullSidebar: true,
      setThreadFull: noop, leaveFull: noop, showToast: noop, toastNow: { current: null }, dismissToast: noop, inboxLink: () => null,
      holdSidebarIfTight: noop, backFromFile: { current: null },
    } satisfies ThreadSlotHost;
    const tree = (
      <QueryClientProvider client={queries}>
        <SidebarProvider open onOpenChange={noop}>
          <main className="ib-main">
            <ThreadSlot paneId="main" threadId={T} active held={{ serverSession: 's', cursor: 0, thread }} host={host} />
          </main>
        </SidebarProvider>
      </QueryClientProvider>
    );
    if (!root) {
      el = document.createElement('div');
      el.className = 'pn-inbox';
      document.body.appendChild(el);
      root = createRoot(el);
    }
    act(() => root!.render(tree));
  };
  draw({ page: 'inbox', project: null, thread: T, ...options.route });
  return { routes, draw, id };
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(() => new Promise((r) => setTimeout(r, 15)));
  }
}

const pane = () => el!.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${T}"]`)!;
const head = () => pane().querySelector<HTMLElement>(':scope > .ib-phead')!;
const pebble = () => head().querySelector<HTMLButtonElement>('[data-shape-pebble]')!;
const layer = () => el!.querySelector<HTMLElement>('[data-shape-layer]');

/** The header's right group, left to right: the views and the controls after the subject. */
function rightGroup(): string[] {
  const names: string[] = [];
  for (const b of head().querySelectorAll<HTMLElement>('button')) {
    if (b.hasAttribute('data-shape-pebble')) names.push('Shape');
    else if (b.hasAttribute('data-artifacts-button')) names.push('Artifacts');
    else if (b.hasAttribute('data-expand-all')) names.push('Expand');
    else if (b.hasAttribute('data-thread-more')) names.push('More');
    else if (b.getAttribute('aria-label') === 'Close the thread') names.push('×');
  }
  return names;
}

async function ready() {
  await until(() => !!pane()?.querySelector('[data-artifacts-button]') && !!pane()?.querySelector('[data-shape-pebble]'), 'the Pebble and Artifacts');
}

async function boardDrawn() {
  await until(() => !!layer()?.querySelector('.shp-head h1'), 'the board');
}

for (const [where, options, expected] of [
  ['a desktop beside the list', {}, ['Shape', 'Artifacts', 'Expand', 'More', '×']],
  ['a phone', { phone: true }, ['Shape', 'Artifacts', 'Expand', 'More']],
  ['a stacked window', { stacked: true }, ['Shape', 'Artifacts', 'Expand', 'More']],
  ['the thread in full screen', { full: true }, ['Shape', 'Artifacts', 'Expand', 'More']],
] as const) {
  test.skipIf(!hasDom)(`${where}: the Pebble sits immediately left of Artifacts`, async () => {
    mount(options);
    await ready();
    expect(rightGroup()).toEqual([...expected]);
  });
}

test.skipIf(!hasDom)('the board draws in the thread’s own pane, under its header, in the messages’ and the reply’s place', async () => {
  const { id, draw } = mount({});
  await ready();
  expect(layer()).toBeNull();
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await ready();
  await boardDrawn();
  const board = layer()!;
  // In the pane, right under the header: not a layer over the window.
  expect(board.parentElement).toBe(pane());
  expect(board.previousElementSibling).toBe(head());
  expect(board.classList.contains('ib-shape-inthread')).toBe(true);
  expect(board.classList.contains('ib-wlayer')).toBe(false);
  expect(el!.querySelectorAll('[data-shape-layer]')).toHaveLength(1);
  // The header stays, the Pebble pressed and still left of Artifacts; Expand has nothing to expand.
  expect(pebble().getAttribute('aria-pressed')).toBe('true');
  expect(rightGroup()).toEqual(['Shape', 'Artifacts', 'More', '×']);
  expect(head().querySelector('[data-artifacts-button]')!.getAttribute('aria-pressed')).toBe('false');
  // The thread's title stays in the bar.
  expect(head().querySelector('[data-header-title]')!.textContent).toContain('Refund events: webhook or polling?');
  // The messages and the reply box are kept, out of sight.
  expect(pane().querySelector<HTMLElement>(':scope > .ib-pbody')!.hidden).toBe(true);
  expect(pane().querySelector<HTMLElement>(':scope > .ib-pfoot')!.hidden).toBe(true);
  // The list (and its sidebar toggle) is beside the thread: the board has no toggle of its own.
  expect(board.querySelector('[data-sidebar="trigger"]')).toBeNull();
});

test.skipIf(!hasDom)('a stacked window, where the thread covers the list: the board keeps its sidebar toggle', async () => {
  const { id, draw } = mount({ stacked: true });
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await ready();
  await boardDrawn();
  expect(layer()!.querySelector('.shp-head [data-sidebar="trigger"]')).not.toBeNull();
});

test.skipIf(!hasDom)('one view at a time: the Pebble closes Artifacts, Artifacts closes the board', async () => {
  const { id, routes, draw } = mount({ route: { artifacts: true } });
  await ready();
  await act(async () => pebble().click());
  expect(routes.at(-1)).toEqual({ kind: 'go', route: { page: 'inbox', project: null, thread: T, artifacts: false, links: false, shape: id } });
  // An address that names both (an old link): the board wins and the Artifacts view stays shut.
  draw({ page: 'inbox', project: null, thread: T, artifacts: true, shape: id });
  await boardDrawn();
  expect(pane().querySelector('[data-artifacts-button]')!.getAttribute('aria-pressed')).toBe('false');
  expect(pane().querySelector('.ib-artbody')).toBeNull();
  await act(async () => pane().querySelector<HTMLButtonElement>('[data-artifacts-button]')!.click());
  expect(routes.at(-1)!.route.shape).toBeNull();
  expect(routes.at(-1)!.route.artifacts).toBe(true);
});

test.skipIf(!hasDom)('the focus: the Pebble’s press goes to the board’s title, the board’s × gives it back to the Pebble', async () => {
  const { id, routes, draw } = mount({});
  await ready();
  pebble().focus();
  await act(async () => pebble().click());
  expect(routes.at(-1)!.route.shape).toBe(id);
  draw(routes.at(-1)!.route);
  await boardDrawn();
  await until(() => document.activeElement === layer()!.querySelector('.shp-head h1'), 'the focus on the board’s title');
  // The board's × closes it: the window writes the address without the board.
  await act(async () => layer()!.querySelector<HTMLButtonElement>('[aria-label="Close Shape"]')!.click());
  expect(routes.at(-1)).toEqual({ kind: 'close', route: { page: 'inbox', project: null, thread: T, artifacts: false, links: false, shape: null } });
  draw(routes.at(-1)!.route);
  expect(layer()).toBeNull();
  await until(() => document.activeElement === pebble(), 'the focus back on the Pebble');
  expect(pane().querySelector<HTMLElement>(':scope > .ib-pbody')!.hidden).toBe(false);
});

test.skipIf(!hasDom)('a 400 px pane: the board takes its narrow layout and keeps every control', async () => {
  const { id, draw } = mount({ width: 400 });
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await ready();
  await boardDrawn();
  const board = layer()!;
  await until(() => !!board.querySelector('.shp-root.phone'), 'the narrow layout');
  const dock = board.querySelector<HTMLElement>('[role="toolbar"][aria-label="Shape toolbar"]')!;
  const views = [...dock.querySelectorAll<HTMLButtonElement>('[aria-label="Views"] button')].map((b) => b.title);
  expect(views).toEqual(['Shape', 'How it works']);
  for (const name of ['Comment', 'Global comment']) expect(dock.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
  expect(dock.querySelector('button[title="References"]')).not.toBeNull();
  expect(board.querySelector('button[aria-label="Close Shape"]')).not.toBeNull();
  for (const b of dock.querySelectorAll<HTMLButtonElement>('button')) expect(b.disabled, b.title).toBe(false);
  // References opens the panel (a sheet here).
  await act(async () => dock.querySelector<HTMLButtonElement>('button[title="References"]')!.click());
  expect(board.querySelector('.shp-sidep.sheet.open')).not.toBeNull();
});

const press = (target: Element, key: 'r' | 'o') =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'r' ? 'KeyR' : 'KeyO', bubbles: true, cancelable: true }));
  });
const replyBox = () => pane().querySelector('.ib-pfoot textarea');

/** The address as the test found it, put back after: O writes a file into it. */
function keepAddress() {
  const was = window.location.href;
  restore.push(() => window.history.replaceState(null, '', was));
}

test.skipIf(!hasDom)('the thread’s keys never act under the board: R and O from the board do nothing (and do, with it closed)', async () => {
  keepAddress();
  const { id, draw } = mount({});
  await ready();
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  const title = layer()!.querySelector<HTMLElement>('.shp-head h1')!;
  title.focus();
  const address = window.location.hash;
  await press(title, 'r');
  await press(title, 'o');
  await act(() => new Promise((r) => setTimeout(r, 30)));
  expect(replyBox()).toBeNull();
  expect(window.location.hash).toBe(address);
  // The same keys with the board closed: R opens the reply box, O the newest file.
  draw({ page: 'inbox', project: null, thread: T, shape: null });
  const subject = pane().querySelector<HTMLElement>('.ib-subject')!;
  subject.focus();
  await press(subject, 'r');
  await until(() => replyBox() !== null, 'the reply box');
  await press(document.body, 'o');
  await until(() => window.location.hash.includes('file='), 'the newest file in the address');
});

test.skipIf(!hasDom)('the thread’s scroll is back where it was once the board closes', async () => {
  const { id, draw } = mount({});
  await ready();
  const body = pane().querySelector<HTMLElement>(':scope > .ib-pbody')!;
  body.scrollTop = 300;
  body.dispatchEvent(new Event('scroll'));
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  // Hidden, WebKit forgets it.
  body.scrollTop = 0;
  draw({ page: 'inbox', project: null, thread: T, shape: null });
  expect(body.hidden).toBe(false);
  expect(body.scrollTop).toBe(300);
});

test.skipIf(!hasDom)('Shape off: an old address naming a board and the Artifacts view opens the Artifacts view, no board', async () => {
  const { id } = mount({ shapeOff: true, route: { artifacts: true, shape: 'shp_old' } });
  expect(id).not.toBe('shp_old');
  await until(() => !!pane()?.querySelector('[data-artifacts-button]'), 'the Artifacts button');
  expect(pane().querySelector('[data-artifacts-button]')!.getAttribute('aria-pressed')).toBe('true');
  expect(pane().querySelector('.ib-artbody')).not.toBeNull();
  expect(layer()).toBeNull();
  expect(pane().querySelector('[data-shape-pebble]')).toBeNull();
});

test.skipIf(!hasDom)('a one-message thread with no name: its title stays in the bar with the board open', async () => {
  const one: InboxThread = { ...THREAD, messages: [THREAD.messages[0]!] };
  const { id, draw } = mount({ thread: one });
  await ready();
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  expect(head().querySelector('[data-header-title]')?.textContent).toContain('Refund events: webhook or polling?');
});

test.skipIf(!hasDom)('a phone: with the board open the header’s way back reads ‹ Thread and closes the board, not the thread', async () => {
  const { id, routes, draw } = mount({ phone: true });
  await ready();
  expect(head().querySelector('[data-phone-back]')!.textContent).toContain('Inbox');
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  const back = head().querySelector<HTMLButtonElement>('[data-phone-back]')!;
  expect(back.textContent).toContain('Thread');
  await act(async () => back.click());
  expect(routes.at(-1)).toEqual({ kind: 'close', route: { page: 'inbox', project: null, thread: T, shape: null } });
});

test.skipIf(!hasDom)('the board in its thread counts as open over the page for the idle clock, and only while drawn', async () => {
  const { id, draw } = mount({});
  await ready();
  expect(document.querySelector('[data-shape-open]')).toBeNull();
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  expect(document.querySelector('[data-shape-open]')).toBe(layer());
  draw({ page: 'inbox', project: null, thread: T, shape: null });
  expect(document.querySelector('[data-shape-open]')).toBeNull();
});

test.skipIf(!hasDom)('the board’s side panel is References only: no Thread tab, no Ask tab, no Chat button', async () => {
  const { id, draw } = mount({});
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  const dock = layer()!.querySelector<HTMLElement>('[role="toolbar"][aria-label="Shape toolbar"]')!;
  expect(dock.querySelector('button[title="Chat"]')).toBeNull();
  await act(async () => dock.querySelector<HTMLButtonElement>('button[title="References"]')!.click());
  const panel = layer()!.querySelector<HTMLElement>('.shp-sidep.open')!;
  expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(panel.querySelector('[data-shape-message], textarea')).toBeNull();
  expect(panel.querySelector('.shp-sidep-title')!.textContent).toBe('References');
});

test.skipIf(!hasDom)('a reference to a message of the thread lands the thread on it, the board closed', async () => {
  keepAddress();
  const { id, draw } = mount({});
  window.history.replaceState(null, '', `#thread=${T}&shape=${id}`);
  draw({ page: 'inbox', project: null, thread: T, shape: id });
  await boardDrawn();
  const dock = layer()!.querySelector<HTMLElement>('[role="toolbar"][aria-label="Shape toolbar"]')!;
  await act(async () => dock.querySelector<HTMLButtonElement>('button[title="References"]')!.click());
  const row = [...layer()!.querySelectorAll<HTMLElement>('.shp-sidep li, .shp-sidep .shp-ref')].find((r) => r.textContent?.includes('The question'));
  const open = (row ?? layer()!.querySelector('.shp-sidep')!).querySelector<HTMLButtonElement>('.shp-ref-open');
  expect(open).not.toBeNull();
  await act(async () => open!.click());
  expect(window.location.hash).toContain(`msg=${T}`);
  expect(window.location.hash).not.toContain('shape=');
});
