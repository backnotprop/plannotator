/**
 * Close on the minimized side chat's circle (the owner, 2026-11-21: "how about a right-click on the circle and close?",
 * and their pick: "Hide the circle and keep the conversation. It comes back if the agent answers, or when you start a
 * side chat on that thread again"), over useInboxAsk with the Inbox's answers scripted (fetch stubbed, nothing
 * started). Failures to catch:
 * - a right-click, a long press or the menu key that opens the chat as well as (or instead of) the menu, the lift
 *   after a long press opening the chat, or a plain click or a short tap that no longer opens it;
 * - Close that ends the chat (any write to the Inbox), or leaves the circle or the pane's cut corner;
 * - a closed circle that stays away after the agent answers (also an answer that was running at Close), or comes back
 *   without one;
 * - a closed circle that stays away after Side or a pick in the dropdown opened that chat and it was minimized again,
 *   or Side that starts a new chat instead of the kept one;
 * - Close leaking to another thread, or lost on a switch and back, or on a reload of the window;
 * - the chat missing from the dropdown while its circle is closed;
 * - focus left on the page after Close from the keyboard.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { useInboxAsk } = (hasDom ? await import('./useInboxAsk') : {}) as typeof import('./useInboxAsk');
const { emitAskChange } = (hasDom ? await import('./askEvents') : {}) as typeof import('./askEvents');
const { LONG_PRESS_MS } = (hasDom ? await import('../components/useContextMenuTrigger') : {}) as typeof import('../components/useContextMenuTrigger');

const THREAD = 'thr_retry';
const OTHER = 'thr_other';

interface Chat {
  turns: number;
  seen: boolean;
  running: string | null;
}
let chats: Record<string, Chat>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let shell: HTMLElement | null = null;
const realFetch = globalThis.fetch;
let parts: ReturnType<typeof useInboxAsk> | null = null;
let writes: string[] = [];
let goTo: ((threadId: string) => void) | null = null;

function model(threadId: string) {
  const chat = chats[threadId];
  const turns = Array.from({ length: chat?.turns ?? 0 }, (_, i) => ({
    id: `turn-${threadId}-${i}`,
    at: `2026-11-21T10:0${i}:00.000Z`,
    session: 'ses_a',
    host: 'claude-code',
    question: `Question ${i}`,
    answer: `Answer ${i}`,
    // Each answer later than the one before.
    answered_at: `2026-11-21T10:0${i}:30.000Z`,
  }));
  return {
    subject: threadId === THREAD ? 'Retry budget for webhooks' : 'Deploy window',
    project: 'api-gateway',
    conversation: turns.length ? { v: 1, thread_id: threadId, seen_at: chat?.seen ? '2026-11-21T11:00:00.000Z' : null, turns } : null,
    running: chat?.running ?? null,
    can_ask: true,
    agent: { host: 'claude-code', name: 'Claude Code' },
  };
}

const WINDOW = { left: 0, top: 0, right: 1440, bottom: 900 };
const PANE = { left: 628, top: 8, right: 1432, bottom: 892 };
const realRect = (hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined) as HTMLElement['getBoundingClientRect'];
function rect(b: { left: number; top: number; right: number; bottom: number }): DOMRect {
  return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
}

function paneEl(): HTMLElement {
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  pane.style.setProperty('border-radius', '12px');
  pane.style.setProperty('border-top-right-radius', '12px');
  pane.style.setProperty('--ib-pane-shadow', '0 0 0 1px rgb(0 0 0 / 0.1), 0 6px 18px -8px rgb(0 0 0 / 0.12)');
  pane.innerHTML = '<div class="ib-pbody"><p class="msg">The retry budget is four calls.</p><button type="button" data-pane-reply="">Reply</button></div>';
  return pane;
}

beforeEach(() => {
  if (!hasDom) return;
  window.sessionStorage.clear();
  writes = [];
  chats = { [THREAD]: { turns: 1, seen: true, running: null }, [OTHER]: { turns: 1, seen: true, running: null } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${url}`);
    const m = url.match(/\/threads\/([^/]+)\/ask$/);
    if (m && method === 'GET') return Response.json(model(decodeURIComponent(m[1]!)));
    // The dropdown's list (`GET /api/inbox/ask`): every chat the Inbox keeps, as the server lists it.
    if (/\/api\/inbox\/ask(\?|$)/.test(url) && method === 'GET') {
      return Response.json({
        chats: Object.keys(chats).map((id) => ({ thread_id: id, subject: model(id).subject, project: 'api-gateway', host: 'claude-code', at: new Date().toISOString(), unread: false, answering: false })),
      });
    }
    return Response.json({});
  }) as typeof fetch;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.matches('.ib-ask-layer')) return rect(WINDOW);
    if (this.matches('.ib-main > section.ib-pane')) return rect(PANE);
    return realRect.call(this);
  };
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
  if (root) await act(async () => root?.unmount());
  shell?.remove();
  root = null;
  host = null;
  shell = null;
  parts = null;
  goTo = null;
  globalThis.fetch = realFetch;
  HTMLElement.prototype.getBoundingClientRect = realRect;
  window.sessionStorage.clear();
  document.body.replaceChildren();
});

function Harness({ start }: { start: string }) {
  const [threadId, setThreadId] = useState(start);
  goTo = setThreadId;
  parts = useInboxAsk({ on: true, codeReview: false, threadId, phone: false, openThread: setThreadId, replyInThread: () => {} });
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

async function show(threadId: string) {
  await act(async () => root!.render(<Harness start={threadId} />));
  await wait(60);
}

async function switchTo(threadId: string) {
  await act(async () => goTo!(threadId));
  await wait(60);
}

const circle = () => document.querySelector<HTMLButtonElement>('[data-side-chat-corner]');
const circleShown = () => {
  const wrap = circle()?.closest<HTMLElement>('[data-side-corner]');
  return !!wrap && !wrap.hidden && !wrap.hasAttribute('hidden');
};
const cutPane = () => document.querySelector('section.ib-pane[data-side-scoop]');
const askWindow = () => document.querySelector<HTMLElement>('[data-chat-window]');
const menu = () => document.querySelector<HTMLElement>('[data-side-circle-menu]');
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());
const closeItem = () => menu()!.querySelector<HTMLElement>('[data-side-circle-close]')!;

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 1415, clientY: 880 });
  act(() => void target.dispatchEvent(event));
  return event;
}

/** A touch as a touch screen sends it: one finger down, none on the lift. */
function touch(target: Element, type: 'touchstart' | 'touchend'): Event {
  const point = { identifier: 1, clientX: 1415, clientY: 880, pageX: 1415, pageY: 880, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  act(() => void target.dispatchEvent(event));
  return event;
}

/** The click a browser sends after a lift, at the element under the finger. */
function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  act(() => void target.dispatchEvent(event));
  return event;
}

async function closeFromMenu() {
  rightClick(circle()!);
  await until(() => menu() !== null, 'the menu');
  act(() => closeItem().click());
  await until(() => circle() === null, 'the circle gone');
}

test.skipIf(!hasDom)('Close hides the circle and the cut and keeps the chat: no write, and Side opens the same conversation', async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  expect(cutPane()).not.toBeNull();
  rightClick(circle()!);
  await until(() => menu() !== null, 'the menu');
  // One item, and the right-click opened no chat.
  expect(items()).toEqual(['Close']);
  expect(askWindow()).toBeNull();
  act(() => closeItem().click());
  await until(() => circle() === null, 'the circle gone');
  expect(menu()).toBeNull();
  // The pane's corner is whole again.
  expect(cutPane()).toBeNull();
  expect(document.querySelector('[data-side-scoop-edge]')).toBeNull();
  // Nothing was written to the Inbox: no End, no delete, no seen.
  expect(writes).toEqual([]);
  expect(parts!.corner.hasChat).toBe(true);
  expect(parts!.corner.circle).toBe(false);
  // Stays away while nothing new comes (another read of the same chat).
  act(() => emitAskChange(THREAD));
  await wait(80);
  expect(circle()).toBeNull();
  // Side on the thread: the window opens on the kept conversation.
  await act(async () => parts!.askWith('Why four?'));
  await until(() => askWindow() !== null, 'the window');
  await until(() => askWindow()!.textContent?.includes('Answer 0') === true, 'the kept transcript');
  expect(askWindow()!.textContent).toContain('Question 0');
  // Minimized again: the circle is back.
  const chevron = askWindow()!.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!;
  await act(async () => chevron.click());
  await until(() => circleShown(), 'the circle back after Side and a minimize');
  expect(cutPane()).not.toBeNull();
});

test.skipIf(!hasDom)('the circle comes back when the agent answers, also an answer that was running at Close', async () => {
  chats[THREAD] = { turns: 1, seen: true, running: 'turn-next' };
  await show(THREAD);
  await until(() => circle()?.getAttribute('aria-label') === 'Side chat, answering', 'the answering circle');
  await closeFromMenu();
  // Still answering, nothing new: still away.
  act(() => emitAskChange(THREAD));
  await wait(80);
  expect(circle()).toBeNull();
  // The answer lands: back, with its dot.
  chats[THREAD] = { turns: 2, seen: false, running: null };
  act(() => emitAskChange(THREAD));
  await until(() => circleShown(), 'the circle back with the answer');
  expect(circle()!.getAttribute('aria-label')).toBe('Side chat, new answer');
  // Closed again, then another answer, while the thread was not on screen: back when the thread is.
  await closeFromMenu();
  await switchTo(OTHER);
  chats[THREAD] = { turns: 3, seen: false, running: null };
  await switchTo(THREAD);
  await until(() => circleShown(), 'the circle back for an answer that came while away');
});

test.skipIf(!hasDom)('Close is this thread only, survives a switch and a reload of the window; the dropdown still lists the chat and a pick brings it back', async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  await closeFromMenu();
  await switchTo(OTHER);
  await until(() => circleShown(), "the other thread's circle");
  await switchTo(THREAD);
  await wait(60);
  expect(circle()).toBeNull();
  // The window reloaded: still closed for this thread, not for the other.
  await act(async () => root!.unmount());
  root = createRoot(host!);
  await show(THREAD);
  await wait(60);
  expect(circle()).toBeNull();
  await switchTo(OTHER);
  await until(() => circleShown(), "the other thread's circle after the reload");
  // From the other thread's window, the dropdown still lists the closed chat; picking it opens that chat.
  await act(async () => parts!.corner.open());
  await until(() => askWindow() !== null, "the other thread's window");
  act(() => askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!.click());
  await until(() => document.querySelector(`[data-ask-menu] [data-ask-chat="${THREAD}"]`) !== null, 'the closed chat in the dropdown');
  act(() => document.querySelector<HTMLElement>(`[data-ask-menu] [data-ask-chat="${THREAD}"]`)!.click());
  await until(() => parts!.corner.threadId === THREAD && askWindow() !== null, 'the picked chat open');
  await until(() => askWindow()!.textContent?.includes('Answer 0') === true, 'its transcript');
  await act(async () => askWindow()!.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click());
  await until(() => circleShown(), 'the circle back after the pick and a minimize');
  expect(writes).toEqual([]);
});

test.skipIf(!hasDom)('a click and a short tap open the chat; a right-click and a long press open the menu, never the chat; the lift opens nothing', async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  // A plain click.
  await act(async () => circle()!.click());
  await until(() => askWindow() !== null, 'the window from a click');
  await act(async () => parts!.corner.minimize());
  await until(() => circleShown(), 'the circle again');
  // A right-click: the menu, no chat, and the browser's own menu cancelled.
  const right = rightClick(circle()!);
  await until(() => menu() !== null, 'the menu from a right-click');
  expect(right.defaultPrevented).toBe(true);
  expect(askWindow()).toBeNull();
  act(() => void menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await until(() => menu() === null, 'the menu shut');
  expect(askWindow()).toBeNull();
  // A finger held on the circle: the menu; its lift and the click a browser sends after it open no chat.
  touch(circle()!, 'touchstart');
  await wait(LONG_PRESS_MS - 200);
  expect(menu()).toBeNull();
  await wait(260);
  expect(menu()).not.toBeNull();
  touch(circle()!, 'touchend');
  const after = click(circle()!);
  expect(after.defaultPrevented).toBe(true);
  await wait(60);
  expect(askWindow()).toBeNull();
  expect(menu()).not.toBeNull();
  // After the lift, Close is the person's.
  await wait(450);
  act(() => closeItem().click());
  await until(() => circle() === null, 'the circle closed from a long press');
  // A short tap (after Side brought it back) opens the chat.
  await act(async () => parts!.askWith(''));
  await act(async () => parts!.corner.minimize());
  await until(() => circleShown(), 'the circle back');
  touch(circle()!, 'touchstart');
  await wait(100);
  touch(circle()!, 'touchend');
  click(circle()!);
  await until(() => askWindow() !== null, 'the window from a tap');
  expect(menu()).toBeNull();
});

test.skipIf(!hasDom)('Shift+F10 on the focused circle opens the same menu; Close puts focus in the pane, not on the page', async () => {
  await show(THREAD);
  await until(() => circleShown(), 'the circle');
  circle()!.focus();
  act(() => void circle()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
  await until(() => menu() !== null, 'the menu from Shift+F10');
  expect(askWindow()).toBeNull();
  act(() => closeItem().click());
  await until(() => circle() === null, 'the circle gone');
  await until(() => document.activeElement?.hasAttribute('data-pane-reply') === true, 'focus in the pane');
});
