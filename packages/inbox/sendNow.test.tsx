/**
 * The line under the person's sent reply, and Send now, as the thread draws
 * them from the sessions route's `asker.connection` (the owner's request,
 * 2026-10-16: "It should say this message is queued up or something. And
 * then maybe an option just to send it immediately."). The failures this
 * catches: a reply to a working agent that reads as dropped, a Send now that
 * is offered where nothing can take it, and a press that posts nothing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { RecipientConnection } from './deliveryLine';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-16T10:00:00.000Z' };
const ASKED = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const REPLY = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMC';

function thread(options: { wakes?: boolean; reply?: Partial<InboxMessageWire> } = {}): InboxThread {
  const asked: InboxMessageWire = {
    id: ASKED,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'ses_a' },
    subject: 'Shipped the migration',
    subject_question: null,
    body: 'Shipped the migration. Anything else?',
    created_at: '2026-10-16T17:00:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    ...(options.wakes === false ? {} : { wakes: true }),
  };
  const reply: InboxMessageWire = {
    id: REPLY,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: ASKED,
    author: { kind: 'person' },
    subject: null,
    body: 'Yes: also bump the version.',
    created_at: '2026-10-16T17:05:00.000Z',
    resolved_at: null,
    idempotency_key: 'k1',
    ...options.reply,
  };
  return { thread_id: ASKED, project: PROJECT, subject: asked.subject, thread_name: null, resolved_at: null, messages: [asked, reply] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let connection: RecipientConnection | null | undefined;
let sendNowAnswer: Response | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  connection = undefined;
  sendNowAnswer = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/send-now') && sendNowAnswer) return sendNowAnswer;
      return Response.json({ message: {} });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({
        serverSession: 's',
        home: '/home/me',
        project: PROJECT,
        sessions: [],
        ...(asked ? { asker: { session: asked, live: true, ...(connection === undefined ? {} : { connection }) } } : {}),
      });
    }
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

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(value: InboxThread, sent: { at: string; checked_at: string | null } | null = { at: '2026-10-16T17:05:00.000Z', checked_at: null }, onChanged: () => Promise<void> = async () => {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={value}
          sent={sent}
          onQuestions={() => {}}
          onChanged={onChanged}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
        />
      </div>,
    );
  });
  await settle();
  return host;
}

const line = (el: HTMLElement) => el.querySelector('[data-delivery]') as HTMLElement;

test.skipIf(!hasDom)('Claude Code at work: "Undelivered · … is working" (approval "inbox-busy-agent-reply"), and Send now posts the send-now route for the reply', async () => {
  // The server's clock for the reply on that busy session (`waits`): the line's minutes.
  connection = { busy: true, idle_since: null, send_now: true, waits: { [REPLY]: { since: new Date(Date.now() - 4 * 60_000).toISOString(), auto_since: null } } };
  let changed = 0;
  const el = await render(thread(), undefined, async () => {
    changed += 1;
  });
  expect(line(el).getAttribute('data-delivery')).toBe('queued');
  // How long it waited on the busy session and what happens next.
  expect(line(el).textContent).toMatch(/^Undelivered \d+ min · Claude Code is working · it gets this when its turn ends/);
  const button = el.querySelector('[data-send-now]') as HTMLButtonElement;
  expect(button.textContent).toBe('Send now');
  await act(async () => button.click());
  await settle();
  expect(posted.filter((p) => p.path.endsWith('/send-now')).map((p) => p.path)).toEqual([`/api/inbox/messages/${REPLY}/send-now`]);
  expect(changed).toBe(1);
});

test.skipIf(!hasDom)('a connection that cannot take it mid-turn: queued, no Send now', async () => {
  connection = { busy: true, idle_since: null, send_now: false };
  const el = await render(thread());
  expect(line(el).textContent).toContain('is working');
  expect(el.querySelector('[data-send-now]')).toBeNull();
});

test.skipIf(!hasDom)('idle: "Sending to Claude Code…"; after Send now: "Sending … now…"; delivered: unchanged', async () => {
  connection = { busy: false, idle_since: '2026-10-16T17:04:00.000Z', send_now: true };
  let el = await render(thread());
  expect(line(el).getAttribute('data-delivery')).toBe('sending');
  expect(line(el).textContent).toBe('Sending to Claude Code…');
  act(() => root?.unmount());
  host?.remove();

  connection = { busy: true, idle_since: null, send_now: true };
  el = await render(thread({ reply: { deliver_now_at: '2026-10-16T17:06:00.000Z' } }));
  expect(line(el).textContent).toBe('Sending to Claude Code now…');
  expect(el.querySelector('[data-send-now]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  el = await render(
    thread({ reply: { delivery: { state: 'delivered', host: 'claude-code', session: 'ses_a', at: '2026-10-16T17:07:00.000Z' } } }),
    { at: '2026-10-16T17:05:00.000Z', checked_at: '2026-10-16T17:07:00.000Z' },
  );
  expect(line(el).getAttribute('data-delivery')).toBe('delivered');
  expect(line(el).textContent).toStartWith('Delivered to Claude Code, ');
});

test.skipIf(!hasDom)('an agent that only reads the thread (no connection polls for it): the truthful wording, no Send now', async () => {
  connection = null;
  const el = await render(thread({ wakes: false }));
  expect(line(el).textContent).toBe('Saved for Claude Code. It sees it when it next reads this thread.');
  expect(el.querySelector('[data-send-now]')).toBeNull();
});

test.skipIf(!hasDom)('a message sent without the wake mark from a session whose connection polls (the shim inside Claude Code): queued, with Send now', async () => {
  connection = { busy: true, idle_since: null, send_now: true };
  const el = await render(thread({ wakes: false }));
  expect(line(el).getAttribute('data-delivery')).toBe('queued');
  expect(line(el).textContent).toContain('Claude Code is working');
  expect(el.querySelector('[data-send-now]')).not.toBeNull();
});

test.skipIf(!hasDom)("pressed, but the session cannot take it now (its own Ask question holds it): Queued, not Sending now", async () => {
  connection = { busy: true, idle_since: null, send_now: false };
  const el = await render(thread({ reply: { deliver_now_at: '2026-10-16T17:06:00.000Z' } }));
  expect(line(el).getAttribute('data-delivery')).toBe('queued');
  expect(line(el).textContent).toContain('Claude Code is working');
  expect(el.querySelector('[data-send-now]')).toBeNull();
});

test.skipIf(!hasDom)('Send now refused (the connection went away): the reason shows, and the line stays', async () => {
  connection = { busy: true, idle_since: null, send_now: true };
  sendNowAnswer = Response.json({ error: "That session is not connected now; it gets this when it is back.", code: 'send_now_unavailable' }, { status: 409 });
  const el = await render(thread());
  await act(async () => (el.querySelector('[data-send-now]') as HTMLButtonElement).click());
  await settle();
  expect(el.querySelector('[data-send-now-error]')?.textContent).toBe('That session is not connected now; it gets this when it is back.');
  expect(line(el).getAttribute('data-delivery')).toBe('queued');
});

/** A thread whose last word is the agent's, marked 👍 and sent through to its waking session (`note_id`), not taken yet. */
function ackedThread(): InboxThread {
  const value = thread();
  const asked = value.messages[0]!;
  return { ...value, messages: [{ ...asked, ack: { label: 'Looks good', at: '2026-10-16T17:06:00.000Z', read_seq: 4, settled_seq: 5, note_id: 'msg_note' } }] };
}

const pill = (el: HTMLElement) => el.querySelector('[data-ack-pill]') as HTMLElement;

test.skipIf(!hasDom)('a 👍 sent through reads the same honest words as a reply: "Queued · … is working" while the session works, with no Send now', async () => {
  connection = { busy: true, idle_since: null, send_now: true };
  const el = await render(ackedThread(), null);
  await settle();
  expect(pill(el).getAttribute('data-ack-pill')).toBe('queued');
  expect(pill(el).textContent).toContain('Queued · Claude Code is working; it gets this when its turn ends.');
  // A 👍 asks nothing of the agent: it never goes into the running turn.
  expect([...el.querySelectorAll('button')].some((button) => /send now/i.test(button.textContent ?? ''))).toBe(false);
  expect(posted.some((entry) => entry.path.endsWith('/send-now'))).toBe(false);
});

test.skipIf(!hasDom)('a 👍 sent through to an idle session reads "Sending to …"; to a session that does not poll now, "when its session is back"', async () => {
  connection = { busy: false, idle_since: '2026-10-16T17:06:00.000Z', send_now: true };
  const idle = await render(ackedThread(), null);
  await settle();
  expect(pill(idle).getAttribute('data-ack-pill')).toBe('sending');
  expect(pill(idle).textContent).toContain('Sending to Claude Code…');
  act(() => root?.unmount());
  host?.remove();
  connection = null;
  const away = await render(ackedThread(), null);
  await settle();
  expect(pill(away).textContent).toContain('Queued for Claude Code; it gets this when its session is back.');
});
