/**
 * A swarm thread in the real ThreadPane (swarm/useThreadSwarm.tsx: GhostButton, SwarmSummary, GhostPane) over a mocked
 * fetch. What this catches:
 * - the Ghost button missing on a swarm thread, not first in the bar, drawn on a thread that is not a swarm or while
 *   Swarm is off, its count wrong or still there once pressed, or pressing it not marking the ghost thread seen;
 * - the ghost pane drawing a message without who it is from and whom it is to, its box not posting the person's words
 *   to everyone (or to the one picked), its empty state gone, or its close leaving it open;
 * - the summary row not replacing "N sessions" or counting wrongly; the status view losing a member's state, its
 *   doing line, a sub-agent's indent under the member it works for, or Turn off not posting `on: false`.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessage, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { adoptSwarmOn } = (hasDom ? await import('./swarmOn') : {}) as typeof import('./swarmOn');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-24T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const GHOST_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMG';
const NOW = new Date().toISOString();

const SWARM: InboxThreadSwarm = {
  on: true,
  ghost_id: GHOST_ID,
  ghost_unread: 3,
  members: [
    { session: 'ses_claude', host: 'claude-code', name: 'Claude Code', joined: true, state: 'working', doing: { text: 'Reading the refunds tests', at: NOW } },
    { session: 'ses_codex', host: 'codex', name: 'Codex', joined: true, state: 'waiting', doing: null },
    { session: 'ses_sub', host: 'claude-code', name: 'Explorer', for: 'Claude Code', joined: true, state: 'idle', doing: { text: 'Listing the refund routes', at: NOW } },
    { session: 'ses_pi', host: 'pi', name: 'Pi', joined: false, state: null, doing: null },
  ],
};

function swarmThread(swarm: InboxThreadSwarm | undefined): InboxThread {
  const root: InboxMessageWire = {
    id: ROOT_ID,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: null,
    author: { kind: 'person' },
    subject: 'Split the refunds work',
    subject_question: null,
    body: 'Split the refunds work between you.',
    created_at: '2026-11-24T15:04:00.000Z',
    resolved_at: null,
    idempotency_key: 'c1',
    to: { host: 'claude-code', session: 'ses_claude' },
    started_by_person: true,
  };
  return { thread_id: ROOT_ID, project: PROJECT, subject: root.subject, thread_name: null, resolved_at: null, messages: [root], ...(swarm ? { swarm } : {}) } as InboxThread;
}

const ghostMessage = (id: string, author: InboxMessage['author'], body: string, tags: InboxMessage['tags']): InboxMessage =>
  ({ id, project_id: PROJECT.id, thread_id: GHOST_ID, reply_to: GHOST_ID, author, subject: null, subject_question: null, body, created_at: '2026-11-24T15:10:00.000Z', resolved_at: null, idempotency_key: id, tags }) as InboxMessage;

const GHOST: InboxMessage[] = [
  ghostMessage('msg_g1', { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' }, 'I take the refund routes.', [{ host: 'codex', session: 'ses_codex', name: 'Codex', wakes: true }]),
  ghostMessage('msg_g2', { kind: 'agent', host: 'codex', session: 'ses_codex', name: 'Codex' }, 'Then I take the tests.', [
    { host: 'claude-code', session: 'ses_claude', name: 'Claude Code', wakes: true },
    { host: 'claude-code', session: 'ses_sub', name: 'Explorer', wakes: true },
  ]),
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let swarmPosts: Record<string, unknown>[] = [];
let swarmReads = 0;
let ghost: InboxMessage[] = [];
/** The swarm the route answers with: the thread's own. */
let served: InboxThreadSwarm = SWARM;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  swarmPosts = [];
  swarmReads = 0;
  ghost = GHOST;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes(`/threads/${ROOT_ID}/swarm`)) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        swarmPosts.push(body);
        const said = body.say as { text: string } | undefined;
        if (said) ghost = [...ghost, ghostMessage(`msg_g${ghost.length + 1}`, { kind: 'person' }, said.text, [])];
        return Response.json({ swarm: { ...served, ghost_unread: 0 }, ghost });
      }
      swarmReads += 1;
      return Response.json({ swarm: served, ghost });
    }
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

async function render(thread: InboxThread) {
  served = thread.swarm ?? SWARM;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  return host;
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const press = async (el: Element | null) => {
  if (!el) throw new Error('nothing to press');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await settle();
};
function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('the Ghost button: first in the bar after the title, with the new count; pressed it takes the accent, the count goes and the ghost thread is marked seen', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(SWARM));
  const button = q<HTMLButtonElement>('[data-ghost-button]')!;
  expect(button.getAttribute('aria-label')).toBe('Ghost thread · 3 new');
  expect(button.querySelector('[data-ghost-unread]')?.textContent).toBe('3');
  expect(button.getAttribute('aria-pressed')).toBe('false');
  const title = q('.ib-phead h2')!;
  const barButtons = [...document.querySelectorAll('.ib-phead .ib-iconbtn')].filter((b) => title.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(barButtons[0]).toBe(button);
  expect(button.hasAttribute('aria-keyshortcuts')).toBe(false);

  await press(button);
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.querySelector('[data-ghost-unread]')).toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Ghost thread');
  expect(q('[data-ghost-pane]')).not.toBeNull();
  expect(swarmPosts).toEqual([{ seen: true }]);
  // Pressed again, the pane closes.
  await press(button);
  expect(q('[data-ghost-pane]')).toBeNull();
});

test.skipIf(!hasDom)('no ghost thread is looked at again when nothing is new: opening reads it, no seen', async () => {
  adoptSwarmOn(true);
  await render(swarmThread({ ...SWARM, ghost_unread: 0 }));
  const button = q<HTMLButtonElement>('[data-ghost-button]')!;
  expect(button.getAttribute('aria-label')).toBe('Ghost thread');
  expect(button.querySelector('[data-ghost-unread]')).toBeNull();
  await press(button);
  expect(swarmPosts).toEqual([]);
  expect(swarmReads).toBeGreaterThan(0);
});

test.skipIf(!hasDom)('not a swarm, or Swarm off: no Ghost button and no summary row', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(undefined));
  expect(q('[data-ghost-button]')).toBeNull();
  expect(q('[data-swarm-summary]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  adoptSwarmOn(false);
  await render(swarmThread(SWARM));
  expect(q('[data-ghost-button]')).toBeNull();
  expect(q('[data-swarm-summary]')).toBeNull();
  expect(q('[data-ghost-pane]')).toBeNull();
});

test.skipIf(!hasDom)('the ghost pane: each message from whom to whom, the box writes to everyone and to one member, its way back closes it', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(SWARM));
  await press(q('[data-ghost-button]'));
  const pane = q('[data-ghost-pane]')!;
  expect(pane.querySelector('.ib-ghost-t')?.textContent).toBe('Ghost thread');
  expect(pane.querySelector('[data-ghost-count]')?.textContent).toBe('2');
  const lines = [...pane.querySelectorAll('[data-ghost-message] .ib-ghost-line')].map((l) => `${l.querySelector('.ib-ghost-from')?.textContent} ${l.querySelector('.ib-ghost-msgto')?.textContent}`);
  expect(lines).toEqual(['Claude Code to Codex', 'Codex to everyone']);
  expect(pane.querySelector('[data-ghost-message="msg_g1"] .ib-ghost-words')?.textContent).toBe('I take the refund routes.');
  // No Pause in this piece.
  expect([...pane.querySelectorAll('button')].some((b) => /pause/i.test(b.textContent ?? ''))).toBe(false);

  const input = pane.querySelector<HTMLTextAreaElement>('[data-ghost-input]')!;
  expect(input.placeholder).toBe('Write to the agents');
  expect(pane.querySelector('[data-ghost-to]')?.textContent).toContain('everyone');
  expect(pane.querySelector<HTMLButtonElement>('[data-ghost-send]')!.disabled).toBe(true);
  type(input, 'Keep the refund amounts in cents.');
  await press(pane.querySelector('[data-ghost-send]'));
  expect(swarmPosts.at(-1)).toEqual({ say: { text: 'Keep the refund amounts in cents.' } });
  expect(input.value).toBe('');
  expect([...pane.querySelectorAll('[data-ghost-message]')].at(-1)?.querySelector('.ib-ghost-from')?.textContent).toBe('You');

  // To one member: the "to" list names the joined members only (Pi has not joined).
  await press(pane.querySelector('[data-ghost-to]'));
  expect([...pane.querySelectorAll('[data-ghost-to-row]')].map((r) => r.textContent)).toEqual(['everyone', 'Claude Code', 'Codex', 'Explorer']);
  await press(pane.querySelector('[data-ghost-to-row="Codex"] .ib-rpick-name'));
  expect(pane.querySelector('[data-ghost-to]')?.textContent).toContain('Codex');
  type(input, 'Run the tests on the cents change.');
  await press(pane.querySelector('[data-ghost-send]'));
  expect(swarmPosts.at(-1)).toEqual({ say: { text: 'Run the tests on the cents change.', to: 'Codex' } });

  // happy-dom lays nothing out: the room is too narrow for both, so the pane covers the thread and goes back to it.
  expect(pane.classList.contains('ib-full')).toBe(true);
  const back = pane.querySelector('[data-ghost-back]')!;
  expect(back.getAttribute('aria-label')).toBe('Back to Split the refunds work');
  await press(back);
  expect(q('[data-ghost-pane]')).toBeNull();
});

test.skipIf(!hasDom)('the ghost pane with nothing in it says so', async () => {
  adoptSwarmOn(true);
  ghost = [];
  await render(swarmThread({ ...SWARM, ghost_unread: 0 }));
  await press(q('[data-ghost-button]'));
  const empty = q('[data-ghost-empty]')!;
  expect(empty.querySelector('.ib-ghost-empty-t')?.textContent).toBe('No ghost messages yet');
  expect(empty.querySelector('.ib-ghost-empty-s')?.textContent).toBe('When the agents talk to each other, it shows up here.');
  expect(empty.querySelector('[data-ghost-cut="full"]')).not.toBeNull();
  expect(q('[data-ghost-count]')).toBeNull();
  // The box is there all the same.
  expect(q('[data-ghost-input]')).not.toBeNull();
});

test.skipIf(!hasDom)('the summary row replaces "N sessions"; its status view shows each member, its state in words, its doing line and a sub-agent under its member; Turn off posts on: false', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(SWARM));
  const summary = q('[data-swarm-summary]')!;
  expect(summary.querySelector('.ib-swarm-sum')?.textContent).toBe('4 agents · 1 working · 1 waiting on you');
  expect(summary.querySelector('.ib-sw-look, [data-swarm-look]')).not.toBeNull();
  expect(summary.closest('[data-thread-meta]')?.hasAttribute('data-sessions')).toBe(true);
  const toggle = summary.querySelector<HTMLButtonElement>('[data-swarm-toggle]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  await press(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-swarm-status] [data-swarm-member]')];
  expect(rows.map((r) => [r.dataset.swarmMember, r.dataset.depth, r.querySelector('[data-swarm-state]')?.textContent])).toEqual([
    ['ses_claude', '0', 'working'],
    ['ses_sub', '1', 'idle'],
    ['ses_codex', '0', 'waiting on you'],
    ['ses_pi', '0', 'not joined yet'],
  ]);
  expect(rows[0]!.querySelector('[data-swarm-doing]')?.textContent).toBe('Reading the refunds tests · just now');
  expect(rows[2]!.querySelector('[data-swarm-doing]')).toBeNull();
  // No task line in this piece, and the plan is not in the status view; the foot holds its three actions.
  const status = q('[data-swarm-status]')!;
  expect(status.textContent).not.toMatch(/Tasks/);
  expect(status.querySelector('[data-swarm-add]')?.textContent).toBe('Add an agent');
  await settle();
  expect(status.querySelector('[data-swarm-ghost]')?.textContent).toBe('Ghost thread2');

  await press(status.querySelector('[data-swarm-turn]'));
  expect(swarmPosts).toEqual([{ on: false }]);
});

test.skipIf(!hasDom)('the status view\'s ghost count follows the stream: the thread read again brings the new count', async () => {
  adoptSwarmOn(true);
  const thread = swarmThread(SWARM);
  await render(thread);
  await press(q('[data-swarm-toggle]'));
  expect(q('[data-swarm-ghost]')?.textContent).toBe('Ghost thread2');
  // A ghost message arrives: the stream's swarm event reads the thread again (a new read, the same swarm words).
  ghost = [...ghost, ghostMessage('msg_g3', { kind: 'person' }, 'From the phone.', [])];
  act(() => {
    root!.render(
      <div className="pn-inbox">
        <ThreadPane thread={{ ...thread, swarm: { ...SWARM } }} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  expect(q('[data-swarm-ghost]')?.textContent).toBe('Ghost thread3');
});

test.skipIf(!hasDom)('an Escape pressed in a dialog over the thread (New message) is the dialog\'s: the open status view leaves it alone', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(SWARM));
  await press(q('[data-swarm-toggle]'));
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const field = document.createElement('textarea');
  dialog.appendChild(field);
  document.body.appendChild(dialog);
  let reached = 0;
  dialog.addEventListener('keydown', () => (reached += 1));
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(reached).toBe(1);
  expect(q('[data-swarm-status]')).not.toBeNull();
  dialog.remove();
  // Pressed in the thread, it closes the view.
  act(() => q('[data-swarm-toggle]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
  expect(q('[data-swarm-status]')).toBeNull();
});

test.skipIf(!hasDom)('the status view\'s Ghost thread opens the ghost pane and closes the view', async () => {
  adoptSwarmOn(true);
  await render(swarmThread(SWARM));
  await press(q('[data-swarm-toggle]'));
  await press(q('[data-swarm-ghost]'));
  expect(q('[data-swarm-status]')).toBeNull();
  expect(q('[data-ghost-pane]')).not.toBeNull();
  expect(q('[data-ghost-button]')?.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('a swarm turned off: the row says off, the foot offers Turn on, and the ghost pane has no box', async () => {
  adoptSwarmOn(true);
  await render(swarmThread({ ...SWARM, on: false, ghost_unread: 0 }));
  expect(q('.ib-swarm-sum')?.textContent).toBe('4 agents · off');
  await press(q('[data-swarm-toggle]'));
  expect(q('[data-swarm-turn]')?.textContent).toBe('Turn on');
  await press(q('[data-swarm-ghost]'));
  expect(q('[data-ghost-input]')).toBeNull();
  expect(q('[data-ghost-off]')?.textContent).toBe('The swarm is off: nothing is sent from here.');
});
