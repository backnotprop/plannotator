/**
 * The line under a reply that waits on T3 Code (the owner, 2026-11-14: "one
 * line by the reply saying it's waiting and how to fix it"), drawn from the
 * reply's `t3_wait`, which the thread's own machine writes. The failures this
 * catches: a reply stuck on T3 that reads as "Saved for …" with no reason, a
 * line that stays after the reply went in, a fix with no command to copy, and
 * a linked machine's thread that says less than the machine it lives on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INBOX_T3_LOGIN_COMMAND, inboxT3WaitLine, type InboxMessageWire, type InboxProject, type InboxT3WaitReason, type InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-14T10:00:00.000Z' };
const ASKED = 'msg_01M4XXVG0ZCPSD10B1KPG7T3AA';
const REPLY = 'msg_01M4XXVG0ZCPSD10B1KPG7T3AB';
const T3_THREAD = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const MAC = `ibx_01K${'0'.repeat(22)}D`;

function thread(reply: Partial<InboxMessageWire> = {}): InboxThread {
  const asked: InboxMessageWire = {
    id: ASKED,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: null,
    author: { kind: 'agent', host: 't3', name: 'T3 Code', session: T3_THREAD },
    subject: 'Ship the worker',
    subject_question: null,
    body: 'Ship the worker today?',
    created_at: '2026-11-14T17:00:00.000Z',
    resolved_at: null,
    idempotency_key: null,
  };
  const answer: InboxMessageWire = {
    id: REPLY,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: ASKED,
    author: { kind: 'person' },
    subject: null,
    body: 'Yes, ship it.',
    created_at: '2026-11-14T17:05:00.000Z',
    resolved_at: null,
    idempotency_key: 'k1',
    ...reply,
  };
  return { thread_id: ASKED, project: PROJECT, subject: asked.subject, thread_name: null, resolved_at: null, messages: [asked, answer] };
}

const macMini: MachineView = { id: MAC, name: 'Mac mini', self: false, state: 'online', since: '2026-11-14T10:00:00.000Z', reason: null, version: '0.28.60', address: null, both_ways: true, waiting: 0 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let fetched: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  fetched = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    fetched.push(path);
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
  resetMachineRoutes();
});

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** `checkedAt`: when the list's Sent record says the agent has it (a delivery settles it). */
function draw(value: InboxThread, machine: MachineView | null = null, checkedAt: string | null = null) {
  act(() => {
    root!.render(
      <div className="pn-inbox">
        <ThreadPane thread={value} machine={machine} sent={{ at: '2026-11-14T17:05:00.000Z', checked_at: checkedAt }} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
}

async function render(value: InboxThread, machine: MachineView | null = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  draw(value, machine);
  await settle();
  return host;
}

const waitLine = (el: HTMLElement) => el.querySelector('[data-t3-wait]') as HTMLElement | null;

for (const reason of ['sign_in', 'sign_in_again', 'access', 'closed'] as InboxT3WaitReason[]) {
  test.skipIf(!hasDom)(`a reply waiting on T3 (${reason}) says so in one line by the reply, with the fix`, async () => {
    const el = await render(thread({ t3_wait: reason }));
    const line = waitLine(el)!;
    expect(line).not.toBeNull();
    expect(line.getAttribute('data-t3-wait')).toBe(reason);
    expect(line.textContent).toContain(inboxT3WaitLine(reason).text);
    // The only delivery line under the reply: "Saved for …" is not drawn beside it.
    expect(el.querySelectorAll('[data-delivery]')).toHaveLength(1);
    expect(el.textContent).not.toContain('Saved for');
    const command = line.querySelector('[data-t3-command]');
    const copy = line.querySelector('[data-restart-copy]');
    if (reason === 'closed') {
      expect(command).toBeNull();
      expect(copy).toBeNull();
    } else {
      expect(command?.textContent).toBe(INBOX_T3_LOGIN_COMMAND);
      expect(copy?.getAttribute('aria-label')).toBe('Copy the T3 sign-in command');
    }
  });
}

test.skipIf(!hasDom)('the line goes by itself the moment the reply is delivered, and reads "Delivered to T3 Code"', async () => {
  const el = await render(thread({ t3_wait: 'sign_in' }));
  expect(waitLine(el)).not.toBeNull();
  // What the next read of the thread shows once the T3 wake sent it: the delivery, the reason dropped.
  draw(thread({ delivery: { state: 'delivered', host: 't3', session: T3_THREAD, at: '2026-11-14T17:40:00.000Z' } }), null, '2026-11-14T17:40:00.000Z');
  await settle();
  expect(waitLine(el)).toBeNull();
  expect(el.querySelector('[data-delivery]')?.getAttribute('data-delivery')).toBe('delivered');
  expect(el.querySelector('[data-delivery]')?.textContent).toContain('Delivered to T3 Code');
});

test.skipIf(!hasDom)('a stale reason on a delivered or taken back reply draws nothing', async () => {
  const el = await render(thread({ t3_wait: 'closed', delivery: { state: 'delivered', host: 't3', session: T3_THREAD, at: '2026-11-14T17:40:00.000Z' } }));
  expect(waitLine(el)).toBeNull();
  draw(thread({ t3_wait: 'closed', taken_back_at: '2026-11-14T17:06:00.000Z' }));
  await settle();
  expect(waitLine(el)).toBeNull();
});

test.skipIf(!hasDom)('no reason, no line: a reply nothing is known to hold keeps its own words', async () => {
  const el = await render(thread());
  expect(waitLine(el)).toBeNull();
  expect(el.querySelector('[data-delivery]')?.textContent).toContain('T3 Code');
});

test.skipIf(!hasDom)("a linked machine's T3 thread shows the same line, with the reason its own machine wrote", async () => {
  rememberMachine([ASKED, REPLY], MAC);
  const el = await render(thread({ t3_wait: 'sign_in_again' }), macMini);
  expect(waitLine(el)?.getAttribute('data-t3-wait')).toBe('sign_in_again');
  expect(waitLine(el)?.textContent).toContain(inboxT3WaitLine('sign_in_again').text);
  // Its sessions are read from that machine, never from this one.
  expect(fetched.filter((path) => path.includes('/sessions')).every((path) => path.includes(`/m/${MAC}/`))).toBe(true);
});
