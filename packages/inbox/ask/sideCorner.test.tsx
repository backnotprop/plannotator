/**
 * The minimized side chat's circle in the window's corner (the owner, 2026-11-20, the 28 px circle; it replaces the
 * corner button removed on 2026-11-09), over useInboxAsk with the Inbox's answers scripted (fetch stubbed, nothing
 * started). Failures to catch:
 * - no circle for a minimized thread chat, or a circle while the chat is open, for a thread with no chat, or on a
 *   phone (Ask is off on phones);
 * - a name that does not say a new answer came or the agent is answering, or a dot or an arc that does not follow
 *   the Inbox's `unseen` and `running`;
 * - a press that does not bring the chat back; minimizing that leaves focus on the page instead of on the circle;
 * - the window's × back (the owner: "Drop the ×, keep the chevron"), or a chevron that no longer minimizes;
 * - a circle drawn uncut where there is no pane to cut, over a whole-window layer (a full view, a guided review) or
 *   over a placeholder pane, and focus left on the page when a minimize has no circle to land on;
 * - the circle and the cut blinking off on a switch between two threads with chats while the new read is on its way;
 * - a measure (a walk of the page) for every change inside a message's body, which code highlighting makes many
 *   times a second on a long thread, in one pane or in Split view's panes; no circle or cut in Split view, or the cut
 *   on a pane that is not at the window's corner;
 * - the circle and the cut over something else's corner: a Shape board in the thread, a folded file's open panel,
 *   the floating drafts' pile resting in the window's corner.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';

const hasDom = typeof document !== 'undefined';
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { emitAskChange } = (hasDom ? await import('./askEvents') : {}) as typeof import('./askEvents');

const THREAD = 'thr_retry';
const BARE = 'thr_bare';
const OTHER = 'thr_other';
const T0 = '2026-11-20T10:00:00.000Z';

interface Chat {
  turns: number;
  seen: boolean;
  running: string | null;
}
let chats: Record<string, Chat>;
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
let parts: ReturnType<typeof useInboxAsk> | null = null;

function model(threadId: string) {
  const chat = chats[threadId];
  const turns = Array.from({ length: chat?.turns ?? 0 }, (_, i) => ({
    id: `turn-${threadId}-${i}`,
    at: T0,
    session: 'ses_a',
    host: 'claude-code',
    question: `Question ${i}`,
    answer: `Answer ${i}`,
    answered_at: '2026-11-20T10:01:00.000Z',
  }));
  return {
    subject: 'Retry budget for webhooks',
    project: 'api-gateway',
    conversation: turns.length ? { v: 1, thread_id: threadId, seen_at: chat?.seen ? '2026-11-20T10:02:00.000Z' : null, turns } : null,
    running: chat?.running ?? null,
    can_ask: true,
    agent: { host: 'claude-code', name: 'Claude Code' },
  };
}

/** Reads held until `release()`: a thread switch before the new thread's read lands. */
let held: Promise<void> | null = null;
let release = () => {};
function holdReads() {
  held = new Promise<void>((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
}

/** The window (1440 x 900) and its panes' boxes, as a browser lays them out (happy-dom lays out nothing). */
const WINDOW = { left: 0, top: 0, right: 1440, bottom: 900 };
let boxes: Array<[string, { left: number; top: number; right: number; bottom: number }]> = [];
// Read only with a DOM: without one (the non-DOM unit shards) these names do not exist and the file must load to skip.
const realRect = (hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined) as HTMLElement['getBoundingClientRect'];
const realQueryAll = (hasDom ? document.querySelectorAll : undefined) as Document['querySelectorAll'];
let paneQueries = 0;
let shell: HTMLElement | null = null;

function rect(b: { left: number; top: number; right: number; bottom: number }): DOMRect {
  return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
}

/** The thread's pane, 8 px in from the window's right and bottom edges, rounded, with the panes' shadow token. */
function paneEl(className = 'ib-pane'): HTMLElement {
  const pane = document.createElement('section');
  pane.className = className;
  pane.style.setProperty('border-radius', '12px');
  pane.style.setProperty('border-top-right-radius', '12px');
  pane.style.setProperty('--ib-pane-shadow', '0 0 0 1px rgb(0 0 0 / 0.1), 0 6px 18px -8px rgb(0 0 0 / 0.12)');
  pane.innerHTML = '<div class="ib-pbody"><p class="msg">The retry budget is four calls.</p></div>';
  return pane;
}

beforeEach(() => {
  if (!hasDom) return;
  chats = { [THREAD]: { turns: 1, seen: true, running: null }, [BARE]: { turns: 0, seen: true, running: null }, [OTHER]: { turns: 1, seen: true, running: null } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = url.match(/\/threads\/([^/]+)\/ask$/);
    if (m && method === 'GET') {
      if (held) await held;
      return Response.json(model(decodeURIComponent(m[1]!)));
    }
    return Response.json({});
  }) as typeof fetch;
  boxes = [['.ib-ask-layer', WINDOW], ['.ib-main > section.ib-pane', { left: 628, top: 8, right: 1432, bottom: 892 }]];
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    for (const [selector, b] of boxes) if (this.matches(selector)) return rect(b);
    return realRect.call(this);
  };
  paneQueries = 0;
  // Each measure starts by listing the panes: counted.
  document.querySelectorAll = function (this: Document, selector: string) {
    if (selector.includes('.ib-panedock')) paneQueries += 1;
    return realQueryAll.call(this, selector);
  } as typeof document.querySelectorAll;
  // The shell as the Inbox lays it out: the panes, and the window's root where the Ask layer renders.
  shell = document.createElement('div');
  shell.className = 'pn-inbox';
  shell.innerHTML = '<div class="ib-sb-wrapper"><main class="ib-main"></main></div>';
  shell.querySelector('.ib-main')!.appendChild(paneEl());
  host = document.createElement('div');
  shell.appendChild(host);
  document.body.appendChild(shell);
  root = createRoot(host);
});

afterEach(async () => {
  if (!hasDom) return;
  release();
  if (root) await act(async () => root?.unmount());
  shell?.remove();
  root = null;
  host = null;
  shell = null;
  parts = null;
  globalThis.fetch = realFetch;
  HTMLElement.prototype.getBoundingClientRect = realRect;
  document.querySelectorAll = realQueryAll;
  document.body.replaceChildren();
});

function Harness({ threadId, phone = false }: { threadId: string | null; phone?: boolean }) {
  parts = useInboxAsk({ on: true, codeReview: false, threadId, phone, openThread: () => {}, replyInThread: () => {} });
  return <>{parts.layer}</>;
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

async function show(threadId: string | null, phone = false) {
  await act(async () => root!.render(<Harness threadId={threadId} phone={phone} />));
  await wait(60);
}

const circle = () => document.querySelector<HTMLButtonElement>('[data-side-chat-corner]');
/** The circle is on screen: rendered, and not hidden for want of a pane to cut. */
const circleShown = () => {
  const wrap = circle()?.closest<HTMLElement>('[data-side-corner]');
  // React sets `hidden` as the property, which happy-dom does not reflect to the attribute.
  return !!wrap && !wrap.hidden && !wrap.hasAttribute('hidden');
};
const cutPane = () => document.querySelector('section.ib-pane[data-side-scoop]');
const askWindow = () => document.querySelector<HTMLElement>('[data-chat-window]');

test.skipIf(!hasDom)("a minimized thread chat is a circle with the agent's mark; none while open, without a chat or on a phone", async () => {
  await show(THREAD);
  await until(() => circle() !== null, 'the circle');
  expect(circleShown()).toBe(true);
  expect(cutPane()).not.toBeNull();
  expect(circle()!.tagName).toBe('BUTTON');
  expect(circle()!.getAttribute('aria-label')).toBe('Side chat');
  expect(circle()!.querySelector('.ib-mk')!.outerHTML).toBe(renderToStaticMarkup(<HostMark host="claude-code" />));
  expect(circle()!.hasAttribute('data-chat-launcher')).toBe(true);
  // Open: the window, no circle.
  await act(async () => parts!.corner.open());
  await until(() => askWindow() !== null, 'the window');
  expect(circle()).toBeNull();
  expect(cutPane()).toBeNull();
  // A thread with no chat yet: nothing in the corner.
  await show(BARE);
  await wait(60);
  expect(askWindow()).toBeNull();
  expect(circle()).toBeNull();
  // No thread: nothing.
  await show(null);
  expect(circle()).toBeNull();
  // A phone: no Ask, so no circle, even for a thread with a chat.
  await show(THREAD, true);
  await act(async () => parts!.corner.minimize());
  await wait(80);
  expect(parts!.corner.hasChat).toBe(true);
  expect(askWindow()).toBeNull();
  expect(circle()).toBeNull();
});

test.skipIf(!hasDom)('the name, the dot and the arc follow a new answer and an answer running', async () => {
  chats[THREAD] = { turns: 1, seen: false, running: null };
  await show(THREAD);
  await until(() => circle()?.getAttribute('aria-label') === 'Side chat, new answer', 'the new answer name');
  expect(circle()!.querySelector('[data-side-new]')).not.toBeNull();
  expect(circle()!.querySelector('[data-side-work]')).toBeNull();
  chats[THREAD] = { turns: 1, seen: true, running: 'turn-running' };
  act(() => emitAskChange(THREAD));
  await until(() => circle()?.getAttribute('aria-label') === 'Side chat, answering', 'the answering name');
  expect(circle()!.querySelector('[data-side-new]')).toBeNull();
  expect(circle()!.querySelector('[data-side-work]')).not.toBeNull();
  chats[THREAD] = { turns: 2, seen: false, running: 'turn-running' };
  act(() => emitAskChange(THREAD));
  await until(() => circle()?.getAttribute('aria-label') === 'Side chat, new answer, answering', 'both');
  chats[THREAD] = { turns: 2, seen: true, running: null };
  act(() => emitAskChange(THREAD));
  await until(() => circle()?.getAttribute('aria-label') === 'Side chat', 'back to plain');
  expect(circle()!.querySelector('[data-side-new], [data-side-work]')).toBeNull();
});

test.skipIf(!hasDom)('a press brings the chat back; its header has the chevron and no ×, and the chevron puts focus on the circle', async () => {
  await show(THREAD);
  await until(() => circle() !== null, 'the circle');
  await act(async () => circle()!.click());
  await until(() => askWindow() !== null, 'the window back');
  expect(circle()).toBeNull();
  expect(askWindow()!.querySelector('[aria-label="Close"]')).toBeNull();
  const chevron = askWindow()!.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!;
  expect(chevron).not.toBeNull();
  chevron.focus();
  await act(async () => chevron.click());
  expect(askWindow()).toBeNull();
  await until(() => circle() !== null, 'the circle again');
  // Focus was in the window, which went: it lands on the circle, not on the page.
  await until(() => document.activeElement === circle(), 'focus on the circle');
});

test.skipIf(!hasDom)('no pane at the corner to cut, or a whole-window layer there: no circle, and minimizing puts focus back where the chat was opened from', async () => {
  // The pane out of the pocket's reach (a layout with no pane at the corner): nothing shows uncut over the page.
  boxes[1] = ['.ib-main > section.ib-pane', { left: 628, top: 8, right: 1380, bottom: 840 }];
  await show(THREAD);
  await until(() => circle() !== null, 'the circle rendered');
  expect(circleShown()).toBe(false);
  expect(circle()!.hasAttribute('data-chat-launcher')).toBe(false);
  expect(cutPane()).toBeNull();
  // A file's full view filling the window: no circle over its own corner control.
  const full = paneEl('ib-view ib-full ib-fullview ib-wlayer');
  full.innerHTML = '<button type="button" class="full-close">Close full view</button>';
  shell!.querySelector('.ib-main')!.appendChild(full);
  boxes.unshift(['.ib-main > .ib-view', WINDOW]);
  await wait(60);
  expect(circleShown()).toBe(false);
  // Opened from a button in the thread, minimized from inside: focus goes back to that button, not to the page.
  const from = document.createElement('button');
  from.textContent = 'Side';
  shell!.querySelector('.ib-main > section.ib-pane')!.appendChild(from);
  from.focus();
  await act(async () => parts!.askWith('Why four?'));
  await until(() => askWindow() !== null, 'the window');
  const chevron = askWindow()!.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!;
  chevron.focus();
  await act(async () => chevron.click());
  await until(() => document.activeElement === from, 'focus back on the opener');
});

test.skipIf(!hasDom)('a switch between two threads with chats keeps the circle and the cut until the new read lands', async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle on the first thread');
  await show(OTHER);
  await until(() => parts!.corner.threadId === OTHER && parts!.corner.hasChat, 'the second thread read');
  // Back to the first: its read is held, and the circle and the cut stay as they were.
  holdReads();
  await act(async () => root!.render(<Harness threadId={THREAD} />));
  expect(parts!.corner.hasChat).toBe(true);
  expect(circleShown()).toBe(true);
  expect(cutPane()).not.toBeNull();
  // The read lands and says the chat is gone (another window cleared it): the circle goes.
  chats[THREAD] = { turns: 0, seen: true, running: null };
  release();
  await until(() => circle() === null, 'the circle gone after the read');
});

test.skipIf(!hasDom)("a burst of changes inside a message's body measures nothing; a pane swapped is measured", async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  await wait(60);
  expect(paneQueries).toBeGreaterThan(0);
  paneQueries = 0;
  // A code highlight or a live message rewriting its body, many times over.
  const body = shell!.querySelector('section.ib-pane .msg')!;
  for (let i = 0; i < 60; i += 1) {
    const span = document.createElement('span');
    span.textContent = `token ${i}`;
    body.appendChild(span);
    if (i % 3 === 0) body.firstChild?.remove();
  }
  await wait(80);
  expect(paneQueries).toBe(0);
  // The thread's pane re-rendered (a thread switch): measured, and the new pane is cut.
  const main = shell!.querySelector('.ib-main')!;
  main.firstElementChild!.remove();
  main.appendChild(paneEl());
  await wait(80);
  expect(paneQueries).toBeGreaterThan(0);
  expect(cutPane()).toBe(main.firstElementChild);
});

test.skipIf(!hasDom)("a guided review over the window hides the circle and the cut; closed, they come back; a placeholder pane gets none", async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  // A guided review (ReviewPane: a whole-window layer over the panes, outside .ib-main).
  const guide = document.createElement('section');
  guide.className = 'ib-viewer ib-wlayer ib-review';
  boxes.unshift(['section.ib-viewer', WINDOW]);
  shell!.appendChild(guide);
  await until(() => !circleShown(), 'the circle hidden under the review');
  expect(cutPane()).toBeNull();
  guide.remove();
  await until(() => circleShown(), 'the circle back');
  expect(cutPane()).not.toBeNull();
  // Reviews with code review off: an empty placeholder pane at the corner, no thread in it.
  const main = shell!.querySelector('.ib-main')!;
  const empty = document.createElement('div');
  empty.className = 'ib-pane ib-pempty';
  boxes.push(['.ib-main > .ib-pempty', { left: 628, top: 8, right: 1432, bottom: 892 }]);
  main.replaceChildren(empty);
  await until(() => !circleShown(), 'no circle over the placeholder');
  expect(document.querySelector('[data-side-scoop]')).toBeNull();
});

/** Split view (`inboxSplitView`): every pane in the free layout's place for it, as panes/ThreadPanes.tsx draws it. */
function splitShell(): { left: HTMLElement; right: HTMLElement } {
  const main = shell!.querySelector('.ib-main')!;
  const place = (pane: HTMLElement) => {
    const outer = document.createElement('div');
    outer.className = 'pierre-layout-pane';
    outer.innerHTML = '<div class="pierre-layout-pane-inner"><div class="pierre-layout-content"><div class="ib-panehost"><div class="ib-panedock"></div></div></div></div>';
    outer.querySelector('.ib-panedock')!.appendChild(pane);
    return outer;
  };
  const left = paneEl();
  left.dataset.p = 'left';
  const right = paneEl();
  right.dataset.p = 'right';
  const layout = document.createElement('div');
  layout.className = 'ib-layout pierre-layout';
  layout.append(place(left), place(right));
  main.replaceChildren(layout);
  boxes = [
    ['.ib-ask-layer', WINDOW],
    ['section.ib-pane[data-p="left"]', { left: 628, top: 8, right: 1028, bottom: 892 }],
    ['section.ib-pane[data-p="right"]', { left: 1036, top: 8, right: 1432, bottom: 892 }],
  ];
  return { left, right };
}

test.skipIf(!hasDom)("split view: the pane at the window's corner is cut, and a burst inside any pane's body measures nothing", async () => {
  const { left, right } = splitShell();
  await show(THREAD);
  await until(() => circleShown(), 'the circle in split view');
  expect(document.querySelector('[data-side-scoop]')).toBe(right);
  expect(left.hasAttribute('data-side-scoop')).toBe(false);
  await wait(60);
  paneQueries = 0;
  for (const pane of [left, right]) {
    const body = pane.querySelector('.msg')!;
    for (let i = 0; i < 40; i += 1) {
      const span = document.createElement('span');
      span.textContent = `token ${i}`;
      body.appendChild(span);
      if (i % 3 === 0) body.firstChild?.remove();
    }
  }
  await wait(80);
  expect(paneQueries).toBe(0);
  // The two panes swapped in the layout: measured, and the cut follows the pane now at the corner.
  const layout = shell!.querySelector('.ib-layout')!;
  layout.appendChild(layout.firstElementChild!);
  boxes[1] = ['section.ib-pane[data-p="left"]', { left: 1036, top: 8, right: 1432, bottom: 892 }];
  boxes[2] = ['section.ib-pane[data-p="right"]', { left: 628, top: 8, right: 1028, bottom: 892 }];
  await until(() => left.hasAttribute('data-side-scoop'), 'the cut on the pane now at the corner');
  expect(right.hasAttribute('data-side-scoop')).toBe(false);
});

test.skipIf(!hasDom)("something else's in the pane's corner (a board in the thread, a folded file's panel): no circle or cut until it goes; the drafts' pile there never hides it", async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  const pane = shell!.querySelector<HTMLElement>('section.ib-pane')!;
  // A Shape board opened in the thread: its side panel runs to the pane's corner.
  const board = document.createElement('section');
  board.className = 'ib-shape-layer pn-shape ib-shape-inthread';
  pane.appendChild(board);
  await until(() => !circleShown(), 'no circle over the board');
  expect(cutPane()).toBeNull();
  board.hidden = true;
  board.setAttribute('hidden', '');
  await until(() => circleShown(), 'the circle back with the board hidden');
  board.remove();
  await wait(40);
  expect(circleShown()).toBe(true);
  // The floating drafts' pile resting in the window's corner (no reply foot on screen): both show, the pile above the
  // circle (floaters.test.tsx), so the circle and the cut stay.
  const pile = document.createElement('div');
  pile.setAttribute('data-rf-corner', '');
  pile.setAttribute('data-rf-spot', 'corner');
  shell!.appendChild(pile);
  window.dispatchEvent(new Event('resize'));
  await wait(80);
  expect(circleShown()).toBe(true);
  expect(cutPane()).toBe(pane);
  pile.remove();
  // A file beside the thread at the corner, folded with its annotations panel open down its right edge.
  const main = shell!.querySelector('.ib-main')!;
  const file = paneEl('ib-view ib-fold');
  main.appendChild(file);
  boxes = [['.ib-ask-layer', WINDOW], ['.ib-main > section.ib-pane', { left: 628, top: 8, right: 1028, bottom: 892 }], ['.ib-main > section.ib-view', { left: 1036, top: 8, right: 1432, bottom: 892 }]];
  file.className = 'ib-view';
  await until(() => document.querySelector('[data-side-scoop]') === file, 'the file cut');
  file.className = 'ib-view ib-fold ib-panel-open';
  await until(() => !circleShown(), 'no circle over the open panel');
  file.className = 'ib-view ib-fold';
  await until(() => circleShown(), 'the circle back with the panel shut');
});
