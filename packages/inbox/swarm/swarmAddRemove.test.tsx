/**
 * Add an agent and Remove in a swarm thread's status view, in the real ThreadPane over a mocked fetch. What this
 * catches:
 * - Add an agent typing `@` in the reply instead of adding the agent to the swarm: it must list the agents the thread
 *   reaches (a linked computer's too) less the members, and a pick must post `swarm/add` with that agent (its computer
 *   for a linked one), after which the agent shows as not joined yet;
 * - Remove missing from a member's row, not posting main's `remove-agent` for that session, its toast not saying
 *   "Removed <name>" with Undo, or the member still listed after the read that follows;
 * - Add an agent's message read as going to the thread's first agent ("to Claude Code · tagged Pi", "Saved for Claude
 *   Code"), when only the agent added gets it;
 * - an agent on a linked computer whose name is not known shown on this computer.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('../components/Thread') : {}) as typeof import('../components/Thread');
const { adoptSwarmOn } = (hasDom ? await import('./swarmOn') : {}) as typeof import('./swarmOn');
const { setSelfMachine } = (hasDom ? await import('../inboxUrl') : {}) as typeof import('../inboxUrl');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-24T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const GHOST_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMG';
const MACMINI = 'ibx_01KAZ00000000000000000000B';

const SWARM: InboxThreadSwarm = {
  on: true,
  ghost_id: GHOST_ID,
  ghost_unread: 0,
  members: [
    { session: 'ses_claude', host: 'claude-code', name: 'Claude Code', joined: true, state: 'working', doing: null },
    { session: 'ses_codex', host: 'codex', name: 'Codex', joined: true, state: 'idle', doing: null },
  ],
};

/** Who the thread reaches (`threads/:id/taggable`): the two members, this computer's Pi, and Qwen Code on the Mac mini. */
const TAGGABLE = {
  serverSession: 's',
  owner: { host: 'claude-code', session: 'ses_claude' },
  machine: { id: 'ibx_01KAZ00000000000000000000A', name: 'Studio' },
  sessions: [
    { session: 'ses_claude', host: 'claude-code', kind: 'live', name: null, project: { id: PROJECT.id, name: 'ledger', root: '/work/ledger' }, started_at: null, last_at: '2026-11-24T15:00:00.000Z', busy: true, idle_since: null, taggable: true, owner: true, wrote_thread: true },
    { session: 'ses_codex', host: 'codex', kind: 'live', name: null, project: { id: PROJECT.id, name: 'ledger', root: '/work/ledger' }, started_at: null, last_at: '2026-11-24T15:00:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true },
    { session: 'ses_pi', host: 'pi', kind: 'live', name: null, project: { id: PROJECT.id, name: 'ledger', root: '/work/ledger' }, started_at: null, last_at: '2026-11-24T15:00:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: false },
    { session: 'ses_qwen', host: 'qwen', kind: 'live', name: null, project: { id: null, name: 'ledger', root: null }, started_at: null, last_at: '2026-11-24T15:00:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: false, machine: MACMINI, machine_name: 'Mac mini' },
  ],
};

function swarmThread(swarm: InboxThreadSwarm): InboxThread {
  const root: InboxMessageWire = {
    id: ROOT_ID,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: null,
    author: { kind: 'person' },
    subject: 'Refund rounding',
    subject_question: null,
    body: 'Refunds are off by a cent.',
    created_at: '2026-11-24T15:04:00.000Z',
    resolved_at: null,
    idempotency_key: 'c1',
    to: { host: 'claude-code', session: 'ses_claude' },
    started_by_person: true,
  };
  return { thread_id: ROOT_ID, project: PROJECT, subject: root.subject, thread_name: null, resolved_at: null, messages: [root], swarm } as InboxThread;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let served: InboxThreadSwarm = SWARM;
let toasts: { lead: string; onUndo?: () => void }[] = [];
let thread: InboxThread;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posts = [];
  toasts = [];
  served = SWARM;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (path.includes(`/threads/${ROOT_ID}/swarm/add`)) {
        served = { ...served, members: [...served.members, { session: String(body.session), host: String(body.host), name: 'Qwen Code', machine_name: 'Mac mini', joined: false, state: null, doing: null }] };
        return Response.json({ swarm: served, ghost: [] });
      }
      if (path.includes(`/threads/${ROOT_ID}/remove-agent`)) return Response.json({ thread_id: ROOT_ID, removal: { host: 'codex', session: body.session, at: '', after: ROOT_ID } });
      return Response.json({});
    }
    if (path.includes(`/threads/${ROOT_ID}/swarm`)) return Response.json({ swarm: served, ghost: [] });
    if (path.includes(`/threads/${ROOT_ID}/taggable`)) return Response.json(TAGGABLE);
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
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The pane, read again as the Inbox would after a write (`onChanged`): the swarm the route serves now. */
function draw() {
  act(() => {
    root!.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={thread}
          sent={null}
          onQuestions={() => {}}
          onChanged={async () => {
            thread = { ...thread, swarm: served };
            draw();
          }}
          onToast={(toast) => toasts.push(toast as { lead: string; onUndo?: () => void })}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
        />
      </div>,
    );
  });
}

async function render(swarm: InboxThreadSwarm) {
  thread = swarmThread(swarm);
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  draw();
  await settle();
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const press = async (el: Element | null) => {
  if (!el) throw new Error('nothing to press');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await settle();
};
const members = () => [...document.querySelectorAll<HTMLElement>('[data-swarm-status] [data-swarm-member]')].map((r) => [r.dataset.swarmMember, r.querySelector('[data-swarm-state]')?.textContent ?? null]);

test.skipIf(!hasDom)('Add an agent lists the agents the thread reaches less the members, and a pick adds it to the swarm, shown as not joined yet', async () => {
  adoptSwarmOn(true);
  await render(SWARM);
  await press(q('[data-swarm-toggle]'));
  await press(q('[data-swarm-add]'));
  const list = q('[data-swarm-add-list]');
  expect(list).not.toBeNull();
  // The reply's words are left alone: no `@` typed anywhere.
  expect(document.querySelector('textarea')?.value ?? '').not.toContain('@');
  const offered = [...list!.querySelectorAll<HTMLElement>('[data-swarm-add-row]')].map((r) => r.dataset.swarmAddRow);
  expect(offered).toEqual(['ses_pi', 'ses_qwen']);
  expect(list!.querySelector('[data-swarm-add-row="ses_qwen"]')?.textContent).toContain('Mac mini');

  await press(list!.querySelector('[data-swarm-add-row="ses_qwen"] button'));
  const added = posts.find((p) => p.path.includes('/swarm/add'));
  expect(added?.body).toMatchObject({ session: 'ses_qwen', host: 'qwen', machine: MACMINI });
  expect(typeof added?.body.idempotency_key).toBe('string');
  expect(q('[data-swarm-add-list]')).toBeNull();
  expect(members()).toEqual([
    ['ses_claude', 'working'],
    ['ses_codex', 'idle'],
    ['ses_qwen', 'not joined yet'],
  ]);
});

test.skipIf(!hasDom)("Add an agent's message reads as going to the agent added alone: its head says \"to Pi\", and only Pi's line is drawn", async () => {
  adoptSwarmOn(true);
  thread = swarmThread(SWARM);
  // What `swarm/add` writes: the person's message answering their own first one, no `to`, Pi tagged and added.
  const added: InboxMessageWire = {
    id: 'msg_01M4XXVG0ZCPSD10B1KPG7DPMC',
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: ROOT_ID,
    author: { kind: 'person' },
    subject: null,
    subject_question: null,
    body: '/swarm',
    created_at: '2026-11-24T15:10:00.000Z',
    resolved_at: null,
    idempotency_key: 'add-pi',
    tags: [{ host: 'pi', session: 'ses_pi', wakes: false, joined: true }],
  };
  thread = { ...thread, messages: [...thread.messages, added] };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  draw();
  await settle();
  const article = q(`[data-message-article="${added.id}"]`);
  expect(article?.querySelector('.ib-to')?.textContent).toBe('to Pi');
  expect(article?.querySelector('[data-tagged-names]')).toBeNull();
  expect([...document.querySelectorAll<HTMLElement>('[data-tag-line]')].map((li) => li.dataset.tagLine)).toEqual(['ses_pi']);
  expect(document.querySelector('[data-owner]')).toBeNull();
  expect(document.body.textContent).not.toContain('Saved for Claude Code');
  expect(document.body.textContent).toContain('Saved for Pi');
});

test.skipIf(!hasDom)('Remove on a member posts main\'s remove-agent for it, toasts "Removed <name>" with Undo, and the member is gone', async () => {
  adoptSwarmOn(true);
  await render(SWARM);
  await press(q('[data-swarm-toggle]'));
  const remove = q<HTMLButtonElement>('[data-swarm-remove="ses_codex"]');
  expect(remove?.getAttribute('aria-label')).toBe('Remove Codex from this thread');
  served = { ...served, members: served.members.filter((m) => m.session !== 'ses_codex') };
  await press(remove);
  expect(posts.find((p) => p.path.includes(`/threads/${ROOT_ID}/remove-agent`))?.body).toMatchObject({ session: 'ses_codex' });
  expect(toasts.map((t) => t.lead)).toEqual(['Removed Codex']);
  expect(typeof toasts[0]!.onUndo).toBe('function');
  expect(members()).toEqual([['ses_claude', 'working']]);
});

test.skipIf(!hasDom)("An agent added on a linked computer whose name is not known shows no computer, never this computer's name", async () => {
  adoptSwarmOn(true);
  // This window's computer is Studio.
  setSelfMachine('ibx_01KAZ00000000000000000000A', [{ id: 'ibx_01KAZ00000000000000000000A', self: true, name: 'Studio' }]);
  await render({ ...SWARM, members: [...SWARM.members, { session: 'ses_qwen', host: 'qwen', name: 'Qwen Code', machine_name: null, joined: false, state: null, doing: null }] });
  await press(q('[data-swarm-toggle]'));
  const where = (session: string) => q(`[data-swarm-member="${session}"] .ib-swarm-wh`)?.textContent ?? null;
  // The thread's own agents are on Studio; the one on the unnamed linked computer is on none.
  expect(where('ses_claude')).toBe('Studio');
  expect(where('ses_qwen')).toBeNull();
});
