/**
 * New message with a thread name another open thread has: the notice stays, and it offers to send to that thread
 * instead. The real ComposeDialog over a mocked fetch.
 *
 * The failures this catches: the offer missing (the person can only rename), the message going to a new thread or to
 * the wrong message of the thread, a second thread started, compose closing or losing the words when the send fails,
 * the offer left standing for another name, and an offer made when the Inbox did not say which thread has the name.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ComposeJoined, ComposeSent } from './compose/ComposeDialog';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-14T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const ANSWER_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMC';

/** The open thread that has the name: the person started it with Codex, and Codex answered. */
function holder(): InboxThread {
  const base = { project_id: PROJECT.id, thread_id: ROOT_ID, subject_question: null, resolved_at: null };
  const first = { ...base, id: ROOT_ID, reply_to: null, author: { kind: 'person' }, subject: 'Launch notes', body: 'Start the launch notes.', created_at: '2026-10-14T15:04:00.000Z', idempotency_key: 'c1', to: { host: 'codex', session: 'ses_codex' }, started_by_person: true, thread_name: 'Launch notes' } as InboxMessageWire;
  const answer = { ...base, id: ANSWER_ID, reply_to: ROOT_ID, author: { kind: 'agent', host: 'codex', session: 'ses_codex', name: null }, subject: null, body: 'Started.', created_at: '2026-10-14T15:06:00.000Z', idempotency_key: 'c2' } as InboxMessageWire;
  return { thread_id: ROOT_ID, project: PROJECT, subject: 'Launch notes', thread_name: 'Launch notes', resolved_at: null, messages: [first, answer] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let sent: ComposeSent[] = [];
let joined: ComposeJoined[] = [];
let closed = 0;
/** What the 409 says besides its code: the thread that has the name, or nothing. */
let names: Record<string, unknown> = {};
let thread: InboxThread | null = null;
let replyFails = false;

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  sent = [];
  joined = [];
  closed = 0;
  names = { thread_id: ROOT_ID };
  thread = holder();
  replyFails = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posts.push({ path, body });
      if (path === '/api/inbox/messages') {
        if (String(body.thread_name ?? '').toLowerCase() !== 'launch notes') return Response.json({ thread_id: 'msg_01M4XXVG0ZCPSD10B1KPG7DPMZ' });
        return Response.json({ code: 'thread_name_taken', error: 'Another open thread in this project is already named that.', field: 'thread_name', ...names }, { status: 409 });
      }
      if (path.endsWith('/reply')) return replyFails ? Response.json({ code: 'thread_resolved', error: 'That thread is archived.' }, { status: 409 }) : Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({});
    }
    if (path.startsWith(`/api/inbox/threads/${ROOT_ID}`)) return thread ? Response.json({ serverSession: 's', cursor: 2, thread }) : Response.json({ code: 'thread_not_found', error: 'No such thread.' }, { status: 404 });
    if (path.startsWith('/api/inbox/sessions')) {
      return Response.json({
        serverSession: 's',
        home: '/home/me',
        projects: [{ project: { id: PROJECT.id, name: PROJECT.name, root: PROJECT.root }, sessions: [{ session: 'ses_claude', host: 'claude-code', started_at: '2026-10-14T14:00:00.000Z', last_seen_at: '2026-10-14T15:00:00.000Z', busy: false, idle_since: null, last_thread: null }] }],
      });
    }
    if (path.startsWith('/api/inbox/skills')) return Response.json({ skills: [] });
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

const inDialog = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<T>(selector) ?? null;
const notice = () => inDialog('[data-compose-thread-name-error]');
const offer = () => inDialog<HTMLButtonElement>('[data-compose-thread-name-join]');
const nameField = () => inDialog<HTMLInputElement>('input[aria-label="Thread name"]')!;
const words = () => inDialog<HTMLTextAreaElement>('[data-compose-text] textarea')!;
const starts = () => posts.filter((p) => p.path === '/api/inbox/messages');
const replies = () => posts.filter((p) => p.path.endsWith('/reply'));

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** New message to the live Claude Code session, the words and the name typed, Send pressed: the name is refused. */
async function refused(name = 'launch notes') {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{ session: 'ses_claude' }}
        phone={false}
        current={null}
        lastSent={null}
        home="/home/me"
        onSent={(s) => sent.push(s)}
        onJoined={(j) => joined.push(j)}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
  type(words(), 'Add the pricing change to the notes.');
  type(nameField(), name);
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => notice() !== null, 'the notice');
}

test.skipIf(!hasDom)('a taken name keeps its notice and offers the thread that has it; the offer sends the message there, to the message a reply in that thread answers', async () => {
  await refused();
  // The notice names the thread as that thread has it, and who gets what is sent there (not To's Claude Code).
  expect(notice()!.textContent).toContain('“Launch notes”');
  expect(notice()!.textContent).toContain('Codex');
  expect(notice()!.getAttribute('role')).toBe('alert');
  // A real button after the alert's words, with its full name; the field is still described by the alert alone.
  expect(offer()!.tagName).toBe('BUTTON');
  expect(offer()!.hasAttribute('tabindex')).toBe(false);
  expect(notice()!.contains(offer())).toBe(false);
  expect(offer()!.getAttribute('aria-label')).toContain('Launch notes');
  expect(offer()!.getAttribute('aria-label')).toContain('Codex');
  expect(nameField().getAttribute('aria-describedby')!.split(' ')).toContain(notice()!.id);
  expect(joined).toHaveLength(0);

  act(() => offer()!.click());
  await until(() => joined.length === 1, 'the send');
  // One reply, on the agent's latest message in that thread; no thread started, nobody else addressed.
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.path).toBe(`/api/inbox/messages/${ANSWER_ID}/reply`);
  expect(replies()[0]!.body).toMatchObject({ words: 'Add the pricing change to the notes.', questions: [] });
  expect(replies()[0]!.body.to).toBeUndefined();
  expect(replies()[0]!.body.tags).toBeUndefined();
  expect(starts()).toHaveLength(1);
  expect(sent).toHaveLength(0);
  expect(joined[0]).toMatchObject({ threadId: ROOT_ID, threadName: 'Launch notes', agent: 'Codex', draftId: null });
});

test.skipIf(!hasDom)('the send to that thread fails: compose stays open with the words, the name and the offer, and says why', async () => {
  replyFails = true;
  await refused();
  act(() => offer()!.click());
  await until(() => inDialog('[data-compose-error]') !== null, 'the error');
  expect(inDialog('[data-compose-error]')!.textContent).toContain('That thread is archived.');
  expect(joined).toHaveLength(0);
  expect(closed).toBe(0);
  expect(words().value).toBe('Add the pricing change to the notes.');
  expect(nameField().value).toBe('launch notes');
  expect(offer()!.disabled).toBe(false);
  // The second press is the same send (one key), so a lost answer is never two messages.
  replyFails = false;
  act(() => offer()!.click());
  await until(() => joined.length === 1, 'the retry');
  expect(replies().map((r) => r.body.idempotency_key)).toEqual([replies()[0]!.body.idempotency_key, replies()[0]!.body.idempotency_key]);
});

test.skipIf(!hasDom)('another name is the other way out: typing one takes the notice and the offer away, and Send starts a thread', async () => {
  await refused();
  type(nameField(), 'Launch notes two');
  expect(notice()).toBeNull();
  expect(offer()).toBeNull();
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  expect(starts().at(-1)!.body.thread_name).toBe('Launch notes two');
  expect(replies()).toHaveLength(0);
});

test.skipIf(!hasDom)('no offer without one thread to send to: the Inbox named none, or the thread it named cannot be read or is archived', async () => {
  names = {};
  await refused();
  expect(notice()!.textContent).toBe('Another open thread in this project has this name.');
  expect(offer()).toBeNull();

  act(() => root?.unmount());
  host?.remove();
  names = { thread_id: ROOT_ID };
  thread = null;
  await refused();
  expect(notice()!.textContent).toBe('Another open thread in this project has this name.');
  expect(offer()).toBeNull();

  act(() => root?.unmount());
  host?.remove();
  thread = { ...holder(), resolved_at: '2026-10-14T16:00:00.000Z' };
  await refused();
  expect(offer()).toBeNull();
});
