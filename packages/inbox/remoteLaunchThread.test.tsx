/**
 * Remote launch, in the window: an agent started on another linked machine, its thread open here.
 * - The run line's Stop and the ⋯'s Stop go to that machine (`/api/inbox/m/<machine>/launch/…`), never to this one,
 *   which has no such launch; Open in Terminal is not offered (that Terminal is on the other machine).
 * - The header says which machine started it, when that was not this one.
 * - A prompt only Claude Code's own dialog can approve says so with that machine's name, offers Copy attach command,
 *   and no Approve in Terminal (it would open a Terminal here, where the session isn't).
 *
 * The failure this catches: a Stop pressed here answered by this machine's 404, or a button that opens a Terminal
 * on the wrong computer.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxPermissionQuestion, inboxPermissionSession } from '@plannotator/core/inbox-permission';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxRun, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const STUDIO = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAX';
const MINI_VIEW = { id: MINI, name: 'Mini', self: false, state: 'online', since: '2026-11-06T09:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true } as unknown as MachineView;

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-11-06T09:00:00.000Z' };
const ROOT = 'msg_R1';

const rootMessage = (from: { machine: string; name: string } | null) =>
  ({
    id: ROOT,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: null,
    author: { kind: 'person' },
    to: { host: 'claude-code', session: 'ses_a' },
    subject: 'CSV export',
    body: 'Add a weekly CSV export of unpaid invoices.',
    created_at: '2026-11-06T09:12:00.000Z',
    resolved_at: null,
    idempotency_key: 'k-r',
    started_by_person: true,
    launch: { id: 'lch_a', agent: 'claude-code', session_ref: 'ses_a', folder: '/work/billing-svc', scratch: false, started_at: '2026-11-06T09:12:00.000Z', ...(from ? { from } : {}) },
  }) as unknown as InboxMessageWire;

function terminalOnlyCard(): InboxMessageWire {
  const asked = inboxPermissionQuestion(
    { session_id: 'ses_a', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, cwd: '/work/billing-svc', permission_suggestions: [], permission_mode: 'bypassPermissions' },
    { agent: 'Claude Code', folder: '/work/billing-svc', allowHere: false },
  );
  const question = {
    key: 'q1',
    position: 0,
    kind: 'question',
    prompt: asked.prompt,
    context: null,
    choices: asked.choices.map((label) => ({ label, description: null, recommended: false, settled: false })),
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_P1',
    superseded_by: null,
  } as unknown as InboxQuestion;
  return {
    id: 'msg_P1',
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: ROOT,
    author: { kind: 'agent', host: 'claude-code', session: inboxPermissionSession('ses_a'), name: null },
    subject: null,
    body: asked.body,
    created_at: '2026-11-06T09:13:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    questions: [question],
  } as unknown as InboxMessageWire;
}

const RUN = { state: 'waiting_terminal', launch_id: 'lch_a', agent: 'claude-code', project: 'billing-svc', folder: '/work/billing-svc', since: '2026-11-06T09:12:00.000Z', again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: 'claude attach ses_a' } as unknown as InboxRun;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  setSelfMachine(SELF);
  posts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push(path);
      return Response.json({ run: null });
    }
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
  globalThis.fetch = savedFetch;
});

async function settle(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function draw(thread: InboxThread, machine: MachineView | null) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane thread={thread} machine={machine} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} run={RUN} remote={false} />,
    );
  });
  await settle();
}

const threadOf = (from: { machine: string; name: string } | null, ...more: InboxMessageWire[]): InboxThread => ({
  thread_id: ROOT,
  project: PROJECT,
  subject: 'CSV export',
  thread_name: null,
  resolved_at: null,
  messages: [rootMessage(from), ...more],
});

test.skipIf(!hasDom)("another machine's launched agent: Stop goes to that machine, and no Open in Terminal; this machine's own keeps both here", async () => {
  await draw(threadOf({ machine: SELF, name: 'MacBook' }), MINI_VIEW);
  expect(host!.querySelector('[data-run-open]')).toBeNull();
  await act(async () => (host!.querySelector('[data-run-stop]') as HTMLElement).click());
  await settle();
  expect(posts).toEqual([`/api/inbox/m/${MINI}/launch/lch_a/stop`]);
  act(() => root!.unmount());
  host!.remove();

  posts = [];
  await draw(threadOf(null), null);
  expect(host!.querySelector('[data-run-open]')).not.toBeNull();
  await act(async () => (host!.querySelector('[data-run-stop]') as HTMLElement).click());
  await settle();
  expect(posts).toEqual(['/api/inbox/launch/lch_a/stop']);
});

test.skipIf(!hasDom)('the header names the machine that started it, unless it was this one', async () => {
  const started = () => host!.querySelector('[data-started-by]')!.textContent ?? '';
  await draw(threadOf({ machine: STUDIO, name: 'Studio' }), MINI_VIEW);
  expect(started()).toBe('You started Claude Code in billing-svc from Studio');
  act(() => root!.unmount());
  host!.remove();
  await draw(threadOf({ machine: SELF, name: 'MacBook' }), MINI_VIEW);
  expect(started()).toBe('You started Claude Code in billing-svc');
});

test.skipIf(!hasDom)("a prompt only Claude Code's own dialog can approve: on another machine it says where, offers Copy attach command, never Approve in Terminal", async () => {
  await draw(threadOf({ machine: SELF, name: 'MacBook' }, terminalOnlyCard()), MINI_VIEW);
  expect(host!.querySelector('[data-perm-elsewhere]')!.textContent).toBe("Only Claude Code can approve this, on Mini's screen. Deny it here, or approve it at Mini.");
  expect(host!.querySelector('[data-perm="terminal"]')).toBeNull();
  expect(host!.querySelector('[data-perm="copy-attach"]')).not.toBeNull();
  expect(host!.querySelector('[data-perm="deny"]')).not.toBeNull();
  act(() => root!.unmount());
  host!.remove();

  await draw(threadOf(null, terminalOnlyCard()), null);
  expect(host!.querySelector('[data-perm-elsewhere]')).toBeNull();
  expect(host!.querySelector('[data-perm="terminal"]')).not.toBeNull();
});
