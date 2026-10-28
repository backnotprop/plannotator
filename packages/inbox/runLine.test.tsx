/**
 * A session the Inbox runs itself (the ACP runner), as the window draws it:
 * the run line under a person message (Queued, Starting, working with its
 * clock, Stop and Show activity, waiting on the person's OK, Done, Stopped,
 * Interrupted, Not sent with Try again), the permission card (every option
 * the agent offered, in its order, the answer posted as given), and the
 * thread foot's resume command. The components alone, over a fake `fetch`
 * that records what is posted; the server's side is proved by
 * packages/server/inbox-acp-runner.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxRunStatus, InboxRunTurn } from '@plannotator/core/inbox-acp';

const hasDom = typeof document !== 'undefined';
const { PermissionCard, RunFoot, RunLine, runKeyOf } = (hasDom ? await import('./components/RunLine') : {}) as typeof import('./components/RunLine');

const KEY = 'run_01HZY3T5R4M2Q8W9X6V7B1N0KP';
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  posted = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    posted.push({ path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    return new Response(JSON.stringify({ run: status() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;
});

const turn = (over: Partial<InboxRunTurn> = {}): InboxRunTurn => ({
  replies: ['msg_A'],
  started_at: new Date(Date.now() - 42_000).toISOString(),
  ended_at: null,
  outcome: null,
  error: null,
  answered: null,
  ...over,
});

function status(over: Partial<InboxRunStatus> = {}): InboxRunStatus {
  const turns = over.turns ?? [turn()];
  // Through JSON, as the wire carries it: `turn` and `turns` are separate copies (never one object).
  return JSON.parse(JSON.stringify({
    key: KEY,
    agent: 'grok',
    label: 'Grok Build',
    cwd: '/Users/me/billing',
    cwd_display: '~/billing',
    acp_session_id: '01a1747b-a761-7f32-bbe8-6990bc50db00',
    thread_id: 'msg_A',
    state: 'working',
    turn: turns.at(-1) ?? null,
    turns,
    permission: null,
    activity: { tools: [{ id: 't1', title: 'Read src/invoice.ts', status: 'completed' }, { id: 't2', title: 'Run `bun test`', status: 'in_progress' }], text: 'Looking at the totals.' },
    queued: [],
    resume_command: 'cd ~/billing && grok -r 01a1747b-a761-7f32-bbe8-6990bc50db00',
    resume: { command: 'grok -r 01a1747b-a761-7f32-bbe8-6990bc50db00', folder: '~/billing' },
    approve_rest: false,
    ...over,
  }));
}

const draw = (node: React.ReactNode) => act(() => root!.render(node));
const text = () => host!.textContent ?? '';
const click = async (selector: string) => {
  const el = host!.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
};

test.skipIf(!hasDom)('working: the clock, Stop, and Show activity with the tool titles and the agent text', async () => {
  draw(<RunLine run={status()} messageId="msg_A" onChanged={() => {}} />);
  expect(host!.querySelector('[data-run-line]')!.getAttribute('data-run-line')).toBe('working');
  expect(text()).toMatch(/Grok Build is working · 0:4\d/);
  expect(host!.querySelector('[data-run-activity]')).toBeNull();
  await click('[data-run-activity-toggle]');
  expect(host!.querySelector('[data-run-activity]')!.textContent).toContain('Read src/invoice.ts');
  expect(host!.querySelector('[data-run-activity]')!.textContent).toContain('Run `bun test`');
  expect(host!.querySelector('[data-run-activity]')!.textContent).toContain('Looking at the totals.');
  await click('[data-run-stop]');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/acp/${KEY}/stop`);
});

test.skipIf(!hasDom)('the other states: queued, starting, done, stopped, interrupted, and not sent with Try again', async () => {
  draw(<RunLine run={status({ queued: ['msg_B'] })} messageId="msg_B" onChanged={() => {}} />);
  expect(text()).toBe('Queued · Grok Build gets this when its current turn ends.');
  draw(<RunLine run={status({ state: 'starting' })} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Starting Grok Build…');
  const ended = (outcome: InboxRunTurn['outcome'], extra: Partial<InboxRunTurn> = {}) =>
    status({ state: 'idle', turns: [turn({ outcome, ended_at: new Date(Date.now() - 42_000 + 72_000).toISOString(), answered: 'inbox', ...extra })] });
  draw(<RunLine run={ended('done')} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Done · 1:12');
  expect(host!.querySelector('[data-run-stop]')).toBeNull();
  draw(<RunLine run={ended('stopped')} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Stopped · 1:12');
  draw(<RunLine run={ended('interrupted')} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Interrupted: the Inbox stopped while it ran. Your message is not sent again.');
  draw(<RunLine run={ended('failed', { error: 'Grok Build could not reopen this session, so nothing was sent: boom', answered: null })} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Not sent: Grok Build could not reopen this session, so nothing was sent: boom');
  await click('[data-run-retry]');
  expect(posted.at(-1)!.path).toBe(`/api/inbox/acp/${KEY}/retry`);
  // A message no turn carried and none waits for: nothing.
  draw(<RunLine run={status()} messageId="msg_Z" onChanged={() => {}} />);
  expect(text()).toBe('');
});

test.skipIf(!hasDom)("the permission card: the agent's own options in order, the answer posted as given, and the rest of the turn", async () => {
  const run = status({
    state: 'permission',
    permission: {
      id: 'prm_1',
      title: 'Run `rm -rf build`',
      kind: 'execute',
      options: [
        { id: 'always-allow', name: 'always allow', kind: 'allow_always' },
        { id: 'allow-once', name: 'allow once', kind: 'allow_once' },
        { id: 'reject-once', name: 'reject once', kind: 'reject_once' },
      ],
      at: new Date().toISOString(),
    },
  });
  draw(<RunLine run={run} messageId="msg_A" onChanged={() => {}} />);
  expect(text()).toContain('Grok Build needs your OK · 0:4');
  const card = host!.querySelector('[data-run-permission]')!;
  expect(card.getAttribute('role')).toBe('group');
  expect(card.querySelector('[data-run-permission-title]')!.textContent).toBe('Run `rm -rf build`');
  expect([...card.querySelectorAll('[data-run-option]')].map((b) => b.textContent)).toEqual(['Always allow', 'Allow once', 'Reject once']);
  await click('[data-run-option="reject-once"]');
  expect(posted.at(-1)).toMatchObject({ path: `/api/inbox/acp/${KEY}/permission`, body: { permission_id: 'prm_1', option_id: 'reject-once' } });
  await click('[data-run-approve-rest]');
  expect(posted.at(-1)!.body).toMatchObject({ permission_id: 'prm_1', option_id: 'allow-once', approve_rest: true });
  // The card alone.
  draw(<PermissionCard run={run} onChanged={() => {}} />);
  expect(host!.querySelectorAll('[data-run-option]')).toHaveLength(3);
});

test.skipIf(!hasDom)('the foot: the resume command with Copy, and no line without one', () => {
  draw(<RunFoot run={status()} />);
  expect(host!.querySelector('[data-run-resume]')!.textContent).toBe('grok -r 01a1747b-a761-7f32-bbe8-6990bc50db00');
  expect(text()).toContain('in ~/billing');
  expect(text()).toContain('Close it in Grok Build before you reply here.');
  draw(<RunFoot run={status({ resume_command: null, resume: null })} />);
  expect(host!.querySelector('[data-run-foot]')).toBeNull();
});

test.skipIf(!hasDom)('runKeyOf: the run_ session a thread is addressed to, or that wrote in it', () => {
  const person = { id: 'msg_A', author: { kind: 'person' }, to: { host: 'grok', session: KEY } };
  expect(runKeyOf({ messages: [person] } as never)).toBe(KEY);
  expect(runKeyOf({ messages: [{ id: 'msg_B', author: { kind: 'agent', host: 'grok', session: KEY } }] } as never)).toBe(KEY);
  expect(runKeyOf({ messages: [{ id: 'msg_C', author: { kind: 'agent', host: 'claude-code', session: 'abc' } }] } as never)).toBeNull();
});

test.if(hasDom)('a 👍 to a session the Inbox runs is never "delivered": it waits until the session reads the thread', async () => {
  const { ackPillLine } = await import('./components/Thread');
  type Ack = Parameters<typeof ackPillLine>[0];
  const ack = {
    label: 'Looks good',
    at: '2026-10-25T10:00:00.000Z',
    settled_seq: 12,
    note_id: 'msg_01HZY3T5R4M2Q8W9X6V7B1N0KQ',
    delivered_at: '2026-10-25T10:00:11.000Z',
  } as unknown as Ack;
  const time = () => '10:00 AM';
  const ran = ackPillLine(ack, 'Grok Build', true, time, undefined, Date.now(), true);
  expect(ran.state).toBe('saved');
  expect(ran.text).not.toContain('Delivered');
  expect(ran.text).toContain('when it next reads this thread');
  // Inside the Undo window it still says when it goes, as for any agent.
  const pending = { ...(ack as object), settled_seq: null, delivered_at: null } as unknown as Ack;
  expect(ackPillLine(pending, 'Grok Build', true, time, undefined, Date.now(), true).state).toBe('pending');
  // Another agent's 👍 keeps its delivery line.
  expect(ackPillLine(ack, 'Claude Code', true, time).state).toBe('delivered');
});
