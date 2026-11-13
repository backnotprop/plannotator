/**
 * Who is in a thread with two or more sessions (issue #3108): the header's line shows the sessions' marks and
 * "N sessions", and opens in place into each session's name and state.
 *
 * What this catches: sessions named only by their agent ("Claude Code, Claude Code and Claude Code"), a one-session thread drawn differently, three identical marks for three sessions
 * that look the same, a line a keyboard or a touch screen cannot open (a tap that only "hovers"), an Escape that
 * closes the thread instead of the line, and an ended session read as running.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { setInboxAgents } from './agentsList';
import { machinesModel } from './machines';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { pileSessions, sessionLooks } = (hasDom ? await import('./components/ThreadSessions') : {}) as typeof import('./components/ThreadSessions');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-11-01T10:00:00.000Z' };
const T = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const CONTEXT = { rows: [], machines: machinesModel(null) };

const author = (session: string, host = 'claude-code') => ({ kind: 'agent' as const, host, session, name: null });
function message(n: number, a: InboxMessageWire['author']): InboxMessageWire {
  return {
    id: n === 0 ? T : `msg_01M4H7AAAAAAAAAAAAAAAAAAA${n}`,
    project_id: PROJECT.id,
    thread_id: T,
    reply_to: n === 0 ? null : T,
    author: a,
    subject: n === 0 ? 'Invoice retries' : null,
    body: `Note ${n}.`,
    created_at: `2026-11-01T10:4${n}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
  };
}
const threadOf = (...authors: InboxMessageWire['author'][]): InboxThread => ({
  thread_id: T,
  project: PROJECT,
  subject: 'Invoice retries',
  thread_name: null,
  resolved_at: null,
  messages: authors.map((a, i) => message(i, a)),
});
const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({
  id,
  session: id,
  host: 'claude-code',
  project: { id: PROJECT.id, name: PROJECT.name },
  state: 'idle',
  waiting: 0,
  live: true,
  started_at: '2026-11-01T10:00:00.000Z',
  last_seen_at: '2026-11-01T10:50:00.000Z',
  ...over,
});
const THREE = [
  agent('ses_a', { label: 'Billing refactor', state: 'waiting', waiting: 1 }),
  agent('ses_b', { label: 'Retry worker', state: 'working' }),
  agent('ses_c', { label: 'Ledger export' }),
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/draft')) return Response.json({ draft: null });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => setInboxAgents(null));
  globalThis.fetch = savedFetch;
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(thread: InboxThread, agents: InboxAgent[] | null = THREE, filter: { agentFilter?: string | null; onAgentFilter?: (id: string | null) => void } = {}) {
  act(() => setInboxAgents(agents ? [{ agents, total: agents.length, ended_today: 0 }] : null));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} agentContext={CONTEXT} {...filter} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  await settle();
  return host;
}

const line = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-thread-sessions]');
const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-ss-tog')!;
/** The opened line: each session's name and state words, in order; null when it is closed. */
const opened = (el: HTMLElement) => {
  const items = [...el.querySelectorAll('.ib-ss-item')];
  return items.length ? items.map((li) => `${li.querySelector('.ib-ss-nm')?.textContent} · ${li.querySelector('.ib-ss-st')?.textContent ?? ''}`) : null;
};
const pointer = (target: Element, type: string, pointerType: string) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  target.dispatchEvent(e);
};

test.skipIf(!hasDom)('three Claude Code sessions: one mark and "3 sessions", opened by keyboard focus into each title and state', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b'), author('ses_a'), author('ses_c')));
  expect(line(el)?.getAttribute('data-thread-sessions')).toBe('3');
  // Three sessions that look the same are one mark, never three identical ones.
  expect(el.querySelector('.ib-ss-pile')?.getAttribute('data-pile')).toBe('1');
  expect(el.querySelector('.ib-ss-n')?.textContent).toBe('3 sessions');
  expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
  expect(opened(el)).toBeNull();
  // The count and time stay on the line.
  expect(el.querySelector('[data-thread-meta-rest]')?.textContent).toContain('4 messages');

  act(() => toggle(el).focus());
  expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
  expect(opened(el)).toEqual(['Billing refactor · waiting on you', 'Retry worker · working', 'Ledger export · idle']);

  // Escape closes the line and leaves the thread open: the window's Escape (App's, which closes the thread) never
  // gets it unused.
  let closesThread = false;
  const onKey = (e: KeyboardEvent) => (closesThread ||= e.key === 'Escape' && !e.defaultPrevented);
  window.addEventListener('keydown', onKey);
  act(() => {
    toggle(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  window.removeEventListener('keydown', onKey);
  expect(closesThread).toBe(false);
  expect(opened(el)).toBeNull();
  expect(document.activeElement).toBe(toggle(el));
});

test.skipIf(!hasDom)('a touch screen: the first tap opens it (a tap is not a hover), a second closes it, a tap outside closes it', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b'), author('ses_c')));
  // A touch's own pointer events never open it as a hover would.
  act(() => pointer(line(el)!, 'pointerover', 'touch'));
  expect(opened(el)).toBeNull();
  act(() => pointer(toggle(el), 'pointerdown', 'touch'));
  act(() => toggle(el).focus());
  expect(opened(el)).toBeNull();
  act(() => toggle(el).click());
  expect(opened(el)).toHaveLength(3);
  act(() => toggle(el).click());
  expect(opened(el)).toBeNull();

  act(() => toggle(el).click());
  expect(opened(el)).toHaveLength(3);
  act(() => pointer(document.body, 'pointerdown', 'touch'));
  expect(opened(el)).toBeNull();
});

test.skipIf(!hasDom)('a mouse: resting on it opens it, leaving closes it; a click while it shows keeps it open', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b'), author('ses_c')));
  act(() => pointer(toggle(el), 'pointerover', 'mouse'));
  expect(opened(el)).toHaveLength(3);
  act(() => pointer(toggle(el), 'pointerout', 'mouse'));
  expect(opened(el)).toBeNull();

  act(() => pointer(toggle(el), 'pointerover', 'mouse'));
  act(() => pointer(toggle(el), 'pointerdown', 'mouse'));
  act(() => toggle(el).click());
  act(() => pointer(toggle(el), 'pointerout', 'mouse'));
  expect(opened(el)).toHaveLength(3);
});

test.skipIf(!hasDom)('a session the list no longer names reads "ended", by its agent; a Pi session is named by its label', async () => {
  const agents = [agent('ses_a', { label: 'Billing refactor' }), agent('ses_pi', { host: 'pi', label: 'Docs pass', state: 'working' })];
  const el = await render(threadOf(author('ses_a'), author('ses_gone'), author('ses_pi', 'pi')), agents);
  act(() => toggle(el).focus());
  expect(opened(el)).toEqual(['Billing refactor · idle', 'Claude Code · ended', 'Docs pass · working']);
  // Two looks (Claude Code, Pi): two marks in the pile; opened, a mark starts each run of sessions that look alike.
  act(() => toggle(el).click());
  expect(el.querySelector('.ib-ss-pile')?.getAttribute('data-pile')).toBe('2');
});

test.skipIf(!hasDom)("a session's state moves on a list read, and only the line draws it", async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b'), author('ses_c')));
  act(() => toggle(el).focus());
  act(() => setInboxAgents([{ agents: [THREE[0]!, { ...THREE[1]!, state: 'idle' }, THREE[2]!], total: 3, ended_today: 0 }]));
  expect(opened(el)?.[1]).toBe('Retry worker · idle');
});

test.skipIf(!hasDom)('one session: no line of sessions in the header', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_a')));
  expect(line(el)).toBeNull();
  expect(el.querySelector('[data-thread-meta]')?.hasAttribute('data-sessions')).toBe(false);
  expect(el.querySelector('[data-thread-meta]')?.textContent).toMatch(/^2 messages/);
});

test.skipIf(!hasDom)('the pile: one mark per look, at most four; a face picked in the sidebar is its own look', () => {
  const hosts = ['claude-code', 'claude-code', 'codex', 'pi', 'opencode', 'cursor'].map((h) => ({ host: h }));
  expect(pileSessions(sessionLooks(hosts, hosts.map(() => 'agent')))).toEqual([0, 2, 3, 4]);
  const faces = ['agent', 'glass', 'agent', 'agent', 'agent', 'agent'];
  expect(pileSessions(sessionLooks(hosts.slice(0, 2), faces.slice(0, 2)))).toEqual([0, 1]);
});

test.skipIf(!hasDom)("a click on a session's name filters the list to that agent, as the sidebar's does; a second click on the filtered one clears it", async () => {
  const picked: (string | null)[] = [];
  const el = await render(threadOf(author('ses_a'), author('ses_gone'), author('ses_b')), THREE, { agentFilter: 'ses_b', onAgentFilter: (id) => picked.push(id) });
  act(() => toggle(el).focus());
  const buttons = [...el.querySelectorAll<HTMLButtonElement>('.ib-ss-item button')];
  // An ended session the list no longer names has no filter: its name is words.
  expect(buttons.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
    ['Billing refactor', 'false'],
    ['Retry worker', 'true'],
  ]);
  act(() => buttons[0]!.click());
  act(() => buttons[1]!.click());
  expect(picked).toEqual(['ses_a', null]);
  // The line stays open: the name's click is not the line's.
  expect(opened(el)).toHaveLength(3);
});

test.skipIf(!hasDom)('with no filter to hand, the names are words', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b')));
  act(() => toggle(el).focus());
  expect(el.querySelectorAll('.ib-ss-item button')).toHaveLength(0);
});

/** Each message line's author as drawn (the folded lines and the open head). */
const authors = (el: HTMLElement) => [...el.querySelectorAll('.ib-fl-nm')].map((n) => n.textContent);

test.skipIf(!hasDom)("several sessions: each message leads with its session's name, its agent in the tooltip and what a screen reader hears", async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_b'), author('ses_c')));
  // The folded lines, then the open head.
  expect(authors(el)).toEqual(['Billing refactor', 'Retry worker', 'Ledger export']);
  // A screen reader hears the agent after the name (the lines' and the open head's buttons say it).
  const said = [...el.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')!);
  for (const who of ['Billing refactor', 'Retry worker', 'Ledger export']) expect(said.some((l) => l.startsWith(`${who}, Claude Code, `))).toBe(true);
  expect(el.querySelector('[data-session-label]')).toBeNull();
});

test.skipIf(!hasDom)('one session: its messages read its agent and its label', async () => {
  const el = await render(threadOf(author('ses_a'), author('ses_a')));
  expect(el.querySelector('[data-session-name]')).toBeNull();
  expect(authors(el).every((a) => a?.startsWith('Claude Code'))).toBe(true);
});

test.skipIf(!hasDom)('a session added to a thread of several: one quiet line, "You added <its name> · <time>", no icon, no mark', async () => {
  const thread = threadOf(author('ses_a'), { kind: 'person' }, author('ses_b'));
  thread.messages[1] = { ...thread.messages[1]!, body: 'Retry worker, look at this.', tags: [{ host: 'claude-code', session: 'ses_b', label: 'Claude Code', wakes: true, joined: true }] };
  const el = await render(thread);
  const line = el.querySelector<HTMLElement>('[data-thread-move="added"]')!;
  expect(line.hasAttribute('data-quiet')).toBe(true);
  expect(line.textContent).toMatch(/^You added Retry worker · \S/);
  expect(line.querySelector('svg, .ib-mk')).toBeNull();
});

test.skipIf(!hasDom)("an unnamed session is its agent everywhere in the thread: the opened line, its messages and \"You added Pi\"", async () => {
  // Pi has no title; the sidebar would name it by its thread, which inside this thread reads as the thread's own title.
  const agents = [THREE[0]!, agent('ses_pi', { host: 'pi', state: 'working' })];
  const thread = threadOf(author('ses_a'), { kind: 'person' }, author('ses_pi', 'pi'), author('ses_a'));
  thread.messages[1] = { ...thread.messages[1]!, body: 'Pi, look at this.', tags: [{ host: 'pi', session: 'ses_pi', label: 'Pi', wakes: true, joined: true }] };
  const el = await render(thread, agents);
  expect(el.querySelector('[data-thread-move="added"]')!.textContent).toMatch(/^You added Pi · \S/);
  expect(authors(el)).toEqual(['Billing refactor', 'You', 'Pi', 'Billing refactor']);
  expect(el.querySelector('[data-message-article] [data-session-name]')!.textContent).toBe('Billing refactor');
  act(() => toggle(el).focus());
  expect(opened(el)).toEqual(['Billing refactor · waiting on you', 'Pi · working']);
});
