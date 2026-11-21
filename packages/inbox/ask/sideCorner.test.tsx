/**
 * The minimized side chat's circle in the window's corner (the owner, 2026-11-20, the 28 px circle; it replaces the
 * corner button removed on 2026-11-09), over useInboxAsk with the Inbox's answers scripted (fetch stubbed, nothing
 * started). Failures to catch:
 * - no circle for a minimized thread chat, or a circle while the chat is open, for a thread with no chat, or on a
 *   phone (Ask is off on phones);
 * - a name that does not say a new answer came or the agent is answering, or a dot or an arc that does not follow
 *   the Inbox's `unseen` and `running`;
 * - a press that does not bring the chat back; minimizing that leaves focus on the page instead of on the circle;
 * - the window's × back (the owner: "Drop the ×, keep the chevron"), or a chevron that no longer minimizes.
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

beforeEach(() => {
  if (!hasDom) return;
  chats = { [THREAD]: { turns: 1, seen: true, running: null }, [BARE]: { turns: 0, seen: true, running: null } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = url.match(/\/threads\/([^/]+)\/ask$/);
    if (m && method === 'GET') return Response.json(model(decodeURIComponent(m[1]!)));
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  parts = null;
  globalThis.fetch = realFetch;
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
const askWindow = () => document.querySelector<HTMLElement>('[data-chat-window]');

test.skipIf(!hasDom)("a minimized thread chat is a circle with the agent's mark; none while open, without a chat or on a phone", async () => {
  await show(THREAD);
  await until(() => circle() !== null, 'the circle');
  expect(circle()!.tagName).toBe('BUTTON');
  expect(circle()!.getAttribute('aria-label')).toBe('Side chat');
  expect(circle()!.querySelector('.ib-mk')!.outerHTML).toBe(renderToStaticMarkup(<HostMark host="claude-code" />));
  expect(circle()!.hasAttribute('data-chat-launcher')).toBe(true);
  // Open: the window, no circle.
  await act(async () => parts!.corner.open());
  await until(() => askWindow() !== null, 'the window');
  expect(circle()).toBeNull();
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
