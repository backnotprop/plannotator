/**
 * A swarm thread's line and status view (swarm/SwarmLine.tsx), drawn by the real thread pane. What this catches: a
 * swarm thread drawn as a plain thread, a state taken from what an agent says instead of its live connection, a
 * silent agent that does not go grey with "no word since", two agents in one file not flagged, a status view that
 * cannot be closed with Escape without closing the thread, and a Turn off that hides the way back on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxMessageWire, InboxProject, InboxSwarm, InboxThread } from '@plannotator/core/inbox-types';
import { setInboxAgents } from '../agentsList';
import { machinesModel } from '../machines';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-24T10:00:00.000Z' };
const T = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const CONTEXT = { rows: [], machines: machinesModel(null) };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const root: InboxMessageWire = {
  id: T,
  project_id: PROJECT.id,
  thread_id: T,
  reply_to: null,
  author: { kind: 'person' },
  subject: 'Refund rounding',
  body: 'Refunds are off by a cent after Ada Novak\'s rounding change.',
  created_at: minutesAgo(30),
  resolved_at: null,
  idempotency_key: 'k1',
  to: { host: 'claude-code', session: 'ses_a' },
  started_by_person: true,
  tags: [
    { host: 'codex', session: 'ses_b', wakes: true },
    { host: 'pi', session: 'ses_c', wakes: true },
  ],
} as InboxMessageWire;
const threadWith = (swarm: InboxSwarm): InboxThread => ({ thread_id: T, project: PROJECT, subject: 'Refund rounding', thread_name: null, resolved_at: null, swarm, messages: [root] });
const agent = (id: string, host: string, over: Partial<InboxAgent> = {}): InboxAgent => ({
  id,
  session: id,
  host,
  project: { id: PROJECT.id, name: PROJECT.name },
  state: 'idle',
  waiting: 0,
  live: true,
  started_at: minutesAgo(40),
  last_seen_at: minutesAgo(1),
  ...over,
});
const SWARM: InboxSwarm = {
  on: true,
  started_at: minutesAgo(30),
  changed_at: minutesAgo(30),
  doing: [
    // A claim: it says it is working, but its connection says idle.
    { session: 'ses_c', text: 'Working hard on the receipt copy', at: minutesAgo(3) },
    { session: 'ses_a', text: 'Rewriting the rounding', at: minutesAgo(5) },
  ],
};

let mounted: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  posted = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/swarm')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push({ path, body });
        return Response.json({ thread_id: T, swarm: { ...SWARM, on: body.on } });
      }
      return Response.json({ thread_id: T, swarm: SWARM });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: null });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/charlie', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => mounted?.unmount());
  host?.remove();
  mounted = null;
  host = null;
  act(() => setInboxAgents(null));
  globalThis.fetch = savedFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(thread: InboxThread, agents: InboxAgent[], phone = false) {
  act(() => setInboxAgents([{ agents, total: agents.length, ended_today: 0 }]));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    mounted = createRoot(host!);
    mounted.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} agentContext={CONTEXT} phone={phone} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  await settle();
  return host;
}

const AGENTS = () => [
  agent('ses_a', 'claude-code', { state: 'working', activity: { tool: 'Edit', file: 'refunds/round.ts', at: minutesAgo(1) } }),
  agent('ses_b', 'codex', { state: 'waiting', waiting: 1 }),
  agent('ses_c', 'pi', { activity: { tool: 'Read', file: 'refunds/round.ts', at: minutesAgo(2) } }),
];
const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-swarm-tog');
const row = (el: HTMLElement, session: string) => el.querySelector<HTMLElement>(`.ib-swarm-row[data-session="${session}"]`)!;

test.skipIf(!hasDom)('a one-message swarm thread shows the swarm line: the badge, three agents and who waits on you', async () => {
  const el = await render(threadWith(SWARM), AGENTS());
  expect(el.querySelector('[data-swarm-line="on"]')).not.toBeNull();
  expect(el.querySelector('.ib-swarm-sum')?.textContent).toBe('3 agents · 1 waiting on you');
  // Closed, it takes no room: no status view in the page.
  expect(el.querySelector('.ib-swarm-pop')).toBeNull();
});

test.skipIf(!hasDom)('opened: state from the connection, the agent\'s own line, its file, and the shared file flagged', async () => {
  const el = await render(threadWith(SWARM), AGENTS());
  act(() => toggle(el)!.click());
  expect(toggle(el)!.getAttribute('aria-expanded')).toBe('true');
  expect(row(el, 'ses_a').querySelector('[data-swarm-state]')?.textContent).toBe('working');
  expect(row(el, 'ses_a').querySelector('[data-swarm-doing]')?.textContent).toBe('Rewriting the rounding');
  expect(row(el, 'ses_a').querySelector('[data-swarm-file]')?.textContent).toContain('refunds/round.ts');
  expect(row(el, 'ses_a').querySelector('[data-swarm-also]')?.textContent).toBe(' · also Pi');
  expect(row(el, 'ses_b').querySelector('[data-swarm-state]')?.textContent).toBe('waiting on you');
  // It said "Working hard"; its connection says idle, and idle is what shows.
  expect(row(el, 'ses_c').getAttribute('data-state')).toBe('idle');
  expect(row(el, 'ses_c').querySelector('[data-swarm-state]')?.textContent).toBe('idle');
  expect(row(el, 'ses_c').querySelector('[data-swarm-also]')?.textContent).toBe(' · also Claude Code');
});

test.skipIf(!hasDom)('before the activity source lands: no file, no "also", and nothing in their place', async () => {
  const agents = AGENTS().map((a) => ({ ...a, activity: undefined }));
  const el = await render(threadWith(SWARM), agents);
  act(() => toggle(el)!.click());
  expect(el.querySelector('[data-swarm-file]')).toBeNull();
  expect(el.querySelector('[data-swarm-also]')).toBeNull();
  expect(row(el, 'ses_a').textContent).not.toMatch(/·\s*$/);
  expect(row(el, 'ses_b').querySelector('[data-swarm-doing]')).toBeNull();
});

test.skipIf(!hasDom)('an agent with no live connection goes grey with "no word since", and shows no file', async () => {
  const agents = AGENTS();
  agents[2] = agent('ses_c', 'pi', { state: 'ended', live: false, last_seen_at: '2026-11-24T14:16:00.000Z', activity: { tool: 'Read', file: 'refunds/round.ts', at: minutesAgo(2) } });
  const el = await render(threadWith(SWARM), agents);
  act(() => toggle(el)!.click());
  expect(row(el, 'ses_c').getAttribute('data-state')).toBe('quiet');
  expect(row(el, 'ses_c').querySelector('[data-swarm-state]')?.textContent).toMatch(/^no word since /);
  expect(row(el, 'ses_c').querySelector('[data-swarm-file]')).toBeNull();
  expect(row(el, 'ses_a').querySelector('[data-swarm-also]')).toBeNull();
});

test.skipIf(!hasDom)('Escape closes the status view, not the thread', async () => {
  const el = await render(threadWith(SWARM), AGENTS());
  act(() => toggle(el)!.click());
  let closesThread = false;
  const onKey = (e: KeyboardEvent) => (closesThread ||= e.key === 'Escape' && !e.defaultPrevented);
  window.addEventListener('keydown', onKey);
  act(() => {
    toggle(el)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  window.removeEventListener('keydown', onKey);
  expect(closesThread).toBe(false);
  expect(el.querySelector('.ib-swarm-pop')).toBeNull();
});

test.skipIf(!hasDom)('Turn off switches it off on the thread\'s computer and leaves the quiet badge, which turns it back on', async () => {
  const el = await render(threadWith(SWARM), AGENTS());
  act(() => toggle(el)!.click());
  act(() => el.querySelector<HTMLButtonElement>('[data-swarm-turn-off]')!.click());
  await settle();
  expect(posted.at(-1)?.path).toContain(`/threads/${T}/swarm`);
  expect(posted.at(-1)?.body.on).toBe(false);
  const quiet = el.querySelector<HTMLButtonElement>('[data-swarm-line="off"] [data-swarm-badge]');
  expect(quiet?.getAttribute('aria-pressed')).toBe('false');
  // Off, today's who-is-here line is back beside it.
  expect(el.querySelector('[data-thread-sessions]')).not.toBeNull();
  act(() => quiet!.click());
  await settle();
  expect(posted.at(-1)?.body.on).toBe(true);
  expect(el.querySelector('[data-swarm-line="on"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a phone: the view opens below the line, one agent per row', async () => {
  const el = await render(threadWith(SWARM), AGENTS(), true);
  expect(el.querySelector('[data-swarm-line="on"]')?.hasAttribute('data-phone')).toBe(true);
  expect(el.querySelector('.ib-swarm-sum')?.textContent).toBe('1 waiting on you');
  act(() => toggle(el)!.click());
  expect(el.querySelectorAll('.ib-swarm-row')).toHaveLength(3);
});
