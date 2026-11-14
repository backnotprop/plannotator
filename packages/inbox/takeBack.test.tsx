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
let takeBackAnswer: () => Response = () => Response.json({});
let replyHeld: Promise<void> | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  connection = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/take-back')) return takeBackAnswer();
      if (path.endsWith('/reply') && replyHeld) {
        await replyHeld;
        return Response.json({ error: 'Not taken for the test.', code: 'refused' }, { status: 409 });
      }
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


const DRAFT = { v: 1, thread_id: ASKED, body: 'Yes: also bump the version.', created_at: '2026-10-16T17:08:00.000Z', updated_at: '2026-10-16T17:08:00.000Z' };
const working = (): RecipientConnection => ({ busy: true, idle_since: null, send_now: true, waits: { [REPLY]: { since: new Date(Date.now() - 4 * 60_000).toISOString(), auto_since: null } } });
const press = async (el: HTMLElement) => {
  await act(async () => (el.querySelector('[data-take-back]') as HTMLButtonElement).click());
  await settle();
};

test.skipIf(!hasDom)('Take back beside Send now: its words come back into the reply box, with the line that the agent never got it', async () => {
  connection = working();
  takeBackAnswer = () => Response.json({ message: {}, draft: DRAFT, compose: null });
  const el = await render(thread());
  await press(el);
  expect(posted.map((p) => p.path)).toContain(`/api/inbox/messages/${REPLY}/take-back`);
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Yes: also bump the version.');
  expect(el.querySelector('[data-take-back-note]')?.textContent).toBe("Taken back. Claude Code never got it. Send it again when it's ready.");
});

test.skipIf(!hasDom)('too late: one quiet line, the message stays, the box stays shut', async () => {
  connection = working();
  takeBackAnswer = () => Response.json({ error: 'The agent already has this message.', code: 'agent_has_it', by: 'delivered' }, { status: 409 });
  const el = await render(thread());
  await press(el);
  expect(el.querySelector('[data-take-back-line]')?.textContent).toBe("Claude Code already has this message, so it can't be taken back. Reply below to change it.");
  expect(el.querySelector('textarea')).toBeNull();
});

test.skipIf(!hasDom)('not offered once the agent has it: delivered, or handed to its queue', async () => {
  connection = { ...working(), handed: [REPLY] };
  let el = await render(thread());
  expect(el.querySelector('[data-take-back]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  connection = working();
  el = await render(thread({ reply: { delivery: { state: 'delivered', host: 'claude-code', session: 'ses_a', at: '2026-10-16T17:07:00.000Z' } } }), { at: '2026-10-16T17:05:00.000Z', checked_at: '2026-10-16T17:07:00.000Z' });
  expect(el.querySelector('[data-take-back]')).toBeNull();
});

test.skipIf(!hasDom)('no Take back while a Send of this thread is on its way: what it drew is not a message yet', async () => {
  connection = working();
  const el = await render(thread());
  expect(el.querySelector('[data-take-back]')).not.toBeNull();
  let release = () => {};
  replyHeld = new Promise<void>((done) => (release = done));
  const reply = [...el.querySelectorAll('.ib-pfoot button')].find((b) => /^(Reply|Edit draft)$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
  await act(async () => reply.click());
  await settle();
  const box = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(box, 'One more thing.');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await act(async () => (el.querySelector('[data-reply-send]') as HTMLButtonElement).click());
  for (let i = 0; i < 40 && !posted.some((p) => p.path.endsWith('/reply')); i++) await settle();
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(true);
  expect(el.querySelector('[data-take-back]')).toBeNull();
  release();
  replyHeld = null;
  for (let i = 0; i < 40 && el.querySelector('[data-take-back]') === null; i++) await settle();
  expect(el.querySelector('[data-take-back]')).not.toBeNull();
});
