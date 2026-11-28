/**
 * The swarm's plan card (swarm/SwarmPlanCard.tsx) in the real ThreadPane, over a mocked fetch. What this catches:
 * - the card missing from the agent reply `swarm propose` wrote, drawn somewhere else, or drawn with its plain words too;
 * - a part losing what it does, who does it, its "joining" while its agent is brought in, or a sub-agent its indent;
 * - another agent's lines (or an agent joining) drawing a second card, or not reaching the one card;
 * - a plain prose proposal (no `swarm_plan`) drawn as a card, or the card drawn while Swarm is off;
 * - a long team as a wall: the band with marks, or every row at once.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxSwarmPlan, InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { adoptSwarmOn } = (hasDom ? await import('./swarmOn') : {}) as typeof import('./swarmOn');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-24T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const CARD_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMC';
const PROSE_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMD';
const GHOST_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMG';
const AT = '2026-11-24T15:05:00.000Z';

const part = (who: string, does: string, by = 'Claude Code', parent?: string) => ({ who, does, by, at: AT, ...(parent ? { for: parent } : {}) });
const PLAN: InboxSwarmPlan = {
  summary: 'Three parts, one per agent. The refunds go last.',
  message_id: CARD_ID,
  at: AT,
  parts: [part('Claude Code', 'Rounding in refunds.ts'), part('Test writer', 'Tests for the rounding rules', 'Claude Code', 'Claude Code'), part('Codex', 'Find the refunds that went out short'), part('Pi', 'Re-send the short refunds')],
};
const SWARM: InboxThreadSwarm = {
  on: true,
  ghost_id: GHOST_ID,
  ghost_unread: 0,
  members: [
    { session: 'ses_claude', host: 'claude-code', name: 'Claude Code', joined: true, state: 'working', doing: null },
    { session: 'ses_codex', host: 'codex', name: 'Codex', joined: true, state: 'idle', doing: null },
    { session: 'ses_pi', host: 'pi', name: 'Pi', machine_name: 'Laptop', joined: false, state: null, doing: null },
  ],
  plan: PLAN,
};

const ROOT: InboxMessageWire = {
  id: ROOT_ID,
  project_id: PROJECT.id,
  thread_id: ROOT_ID,
  reply_to: null,
  author: { kind: 'person' },
  subject: 'Refunds are off by a cent',
  subject_question: null,
  body: 'Split the refunds work between you.',
  created_at: '2026-11-24T15:04:00.000Z',
  resolved_at: null,
  idempotency_key: 'c1',
  to: { host: 'claude-code', session: 'ses_claude' },
  started_by_person: true,
};
const agentReply = (id: string, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire =>
  ({ id, project_id: PROJECT.id, thread_id: ROOT_ID, reply_to: ROOT_ID, author: { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' }, subject: null, subject_question: null, body, created_at: AT, resolved_at: null, idempotency_key: id, ...extra }) as InboxMessageWire;
const CARD = agentReply(CARD_ID, 'Swarm plan: Three parts, one per agent.\n\n- Claude Code: Rounding in refunds.ts', { swarm_plan: true });

const threadOf = (messages: InboxMessageWire[], swarm: InboxThreadSwarm | undefined): InboxThread =>
  ({ thread_id: ROOT_ID, project: PROJECT, subject: ROOT.subject, thread_name: null, resolved_at: null, messages, ...(swarm ? { swarm } : {}) }) as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/swarm')) return Response.json({ swarm: SWARM, ghost: [] });
    if (init?.method === 'POST') return Response.json({});
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/charlie', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  adoptSwarmOn(false);
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const pane = (thread: InboxThread) => (
  <div className="pn-inbox">
    <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
  </div>
);

async function render(thread: InboxThread) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread));
  });
  await settle();
  return host;
}

async function rerender(thread: InboxThread) {
  act(() => root!.render(pane(thread)));
  await settle();
}

const article = (id: string) => document.querySelector<HTMLElement>(`[data-message-article="${id}"]`);
const rowOf = (who: string) => document.querySelector<HTMLElement>(`[data-swarm-plan] [data-swarm-plan-part="${who}"]`);

test.skipIf(!hasDom)("the plan card is the proposing agent's reply: the band, the plan in a line, and each part with who does it", async () => {
  adoptSwarmOn(true);
  await render(threadOf([ROOT, CARD], SWARM));
  const cards = document.querySelectorAll('[data-swarm-plan]');
  expect(cards).toHaveLength(1);
  // In that reply's body, in place of its plain words.
  expect(article(CARD_ID)!.contains(cards[0]!)).toBe(true);
  expect(article(CARD_ID)!.textContent).not.toContain('- Claude Code: Rounding');
  const card = cards[0] as HTMLElement;
  expect(card.querySelector('.ib-sp-title')!.textContent).toBe('Swarm plan');
  expect(card.querySelector('[data-swarm-plan-status]')!.textContent).toMatch(/^Started .+ · Pi is joining on Laptop$/);
  expect(card.querySelector('[data-swarm-plan-count]')!.textContent).toBe('4 parts');
  expect(card.querySelector('[data-swarm-plan-summary]')!.textContent).toBe('Three parts, one per agent. The refunds go last.');
  // The band names no agent and draws no mark: only the parts do.
  expect(card.querySelector('.ib-sp-band .ib-mk')).toBeNull();
  expect([...card.querySelectorAll('[data-swarm-plan-part]')].map((li) => li.getAttribute('data-swarm-plan-part'))).toEqual(['Claude Code', 'Test writer', 'Codex', 'Pi']);
  expect(rowOf('Claude Code')!.querySelector('[data-swarm-plan-does]')!.textContent).toBe('Rounding in refunds.ts');
  expect(rowOf('Claude Code')!.hasAttribute('data-joined')).toBe(true);
  expect(rowOf('Claude Code')!.querySelector('[data-swarm-plan-joining]')).toBeNull();
  // Pi is being brought in on the other computer: "joining", its computer, its mark's tile waiting.
  expect(rowOf('Pi')!.querySelector('[data-swarm-plan-joining]')!.textContent).toBe('joining');
  expect(rowOf('Pi')!.querySelector('.ib-sp-wh')!.textContent).toContain('Laptop');
  expect(rowOf('Pi')!.querySelector('.ib-sp-mk')!.hasAttribute('data-waiting')).toBe(true);
  // The sub-agent, under its agent: "sub-agent", never counted as joining.
  expect(rowOf('Test writer')!.getAttribute('data-depth')).toBe('1');
  expect(rowOf('Test writer')!.querySelector('[data-swarm-plan-joining]')!.textContent).toBe('sub-agent');
  // Written by the card's own agent: no "Added by".
  expect(card.querySelector('[data-swarm-plan-by]')).toBeNull();
});

test.skipIf(!hasDom)("another agent's lines and an agent joining change the one card in place, never a second", async () => {
  adoptSwarmOn(true);
  await render(threadOf([ROOT, CARD], SWARM));
  const first = document.querySelector('[data-swarm-plan]');
  const added: InboxSwarmPlan = { ...PLAN, parts: [...PLAN.parts.slice(0, 2), part('Codex', 'List the short refunds in a CSV', 'Codex'), PLAN.parts[3]!, part('Migration check', 'The berth_rates migration runs clean', 'Codex', 'Codex')] };
  const members = SWARM.members.map((m) => (m.session === 'ses_pi' ? { ...m, joined: true, state: 'working' as const } : m));
  await rerender(threadOf([ROOT, CARD], { ...SWARM, members, plan: added }));
  expect(document.querySelectorAll('[data-swarm-plan]')).toHaveLength(1);
  expect(document.querySelector('[data-swarm-plan]')).toBe(first);
  expect(rowOf('Codex')!.querySelector('[data-swarm-plan-does]')!.textContent).toBe('List the short refunds in a CSV');
  expect(rowOf('Codex')!.querySelector('[data-swarm-plan-by]')!.textContent).toBe('Added by Codex');
  expect(rowOf('Migration check')!.getAttribute('data-depth')).toBe('1');
  expect(document.querySelector('[data-swarm-plan-count]')!.textContent).toBe('5 parts');
  // Pi joined: its row fills, and the band says everyone is in.
  expect(rowOf('Pi')!.querySelector('[data-swarm-plan-joining]')).toBeNull();
  expect(document.querySelector('[data-swarm-plan-status]')!.textContent).toMatch(/ · everyone joined$/);
});

test.skipIf(!hasDom)('a proposal written as prose stays a message, and with Swarm off the card is its plain words', async () => {
  adoptSwarmOn(true);
  const prose = agentReply(PROSE_ID, 'I propose: Claude Code takes the rounding, Codex finds the short refunds.');
  await render(threadOf([ROOT, prose], { ...SWARM, plan: null }));
  expect(document.querySelector('[data-swarm-plan]')).toBeNull();
  expect(article(PROSE_ID)!.textContent).toContain('I propose: Claude Code takes the rounding');
  act(() => root?.unmount());
  host?.remove();
  adoptSwarmOn(false);
  // Off: the thread read carries no `swarm`; the card's message reads as its words.
  await render(threadOf([ROOT, CARD], undefined));
  expect(document.querySelector('[data-swarm-plan]')).toBeNull();
  expect(article(CARD_ID)!.textContent).toContain('Claude Code: Rounding in refunds.ts');
});

test.skipIf(!hasDom)('a team of 20 still reads: no marks in the band, six rows, then "Show 14 more" opens the rest', async () => {
  adoptSwarmOn(true);
  const many: InboxSwarmPlan = { ...PLAN, parts: Array.from({ length: 20 }, (_, i) => part(`Codex ${i + 1}`, `Shard ${i + 1} of the refunds`)) };
  await render(threadOf([ROOT, CARD], { ...SWARM, plan: many }));
  const card = document.querySelector<HTMLElement>('[data-swarm-plan]')!;
  expect(card.querySelector('[data-swarm-plan-count]')!.textContent).toBe('20 parts');
  expect(card.querySelector('[data-swarm-plan-status]')!.textContent).toMatch(/ · 20 agents are joining$/);
  expect(card.querySelector('.ib-sp-band .ib-mk')).toBeNull();
  expect(card.querySelectorAll('[data-swarm-plan-part]')).toHaveLength(6);
  const more = card.querySelector<HTMLButtonElement>('[data-swarm-plan-more]')!;
  expect(more.textContent).toBe('Show 14 more');
  act(() => more.click());
  expect(card.querySelectorAll('[data-swarm-plan-part]')).toHaveLength(20);
  expect(more.getAttribute('aria-expanded')).toBe('true');
});

test.skipIf(!hasDom)("the card's Ghost thread opens the ghost pane beside the thread", async () => {
  adoptSwarmOn(true);
  await render(threadOf([ROOT, CARD], SWARM));
  expect(document.querySelector('[data-ghost-pane]')).toBeNull();
  act(() => document.querySelector<HTMLButtonElement>('[data-swarm-plan-ghost]')!.click());
  await settle();
  expect(document.querySelector('[data-ghost-pane]')).not.toBeNull();
});
