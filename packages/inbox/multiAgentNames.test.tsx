/**
 * Two agents in one thread (handoff "multi-agent-thread-model", option A:
 * say what is true). Claude Code started the thread and Pi wrote last: the
 * person's reply goes to Pi, so the line under it says "to Pi", its delivery
 * line "Delivered to Pi" (or "Saved for Cursor" for an agent with no wake),
 * and the reply box "Reply to Pi" (its field; the recipient pill under it
 * says "to Pi", approval "inbox-reply-recipient"). They used to name the
 * thread's first agent, Claude Code, which never got the reply. A thread with
 * one agent reads exactly as before.
 *
 * Also (handoff "reply-box-layout-safety", existing gap): a draft save that
 * did not land said "Saved <the last good time>"; it says "Not saved" now.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { DRAFT_NOT_SAVED_FAILED } from './components/DraftLabel';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
/** The update control's restart guard: what a restart would lose (null: nothing). */
const { unsentReply } = (hasDom ? await import('./unsent') : {}) as typeof import('./unsent');

const PROJECT: InboxProject = { id: 'prj_1', key: 'superfans-abcdef', name: 'superfans', root: '/work/superfans', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
const CURSOR = { kind: 'agent' as const, host: 'cursor', session: 'ses_cursor', name: 'Cursor' };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';
const R1 = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const CHECKED = '2026-11-01T10:53:00.000Z';

function agentMessage(id: string, author: InboxMessageWire['author'], extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Accounts and usage' : null,
    body: id === M1 ? 'I added the usage panel.' : 'I fixed the totals.',
    created_at: id === M1 ? '2026-11-01T10:41:00.000Z' : '2026-11-01T10:45:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    ...extra,
  };
}

function personReply(replyTo: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id: R1,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: replyTo,
    author: { kind: 'person' },
    subject: null,
    body: 'Thanks, ship it.',
    created_at: '2026-11-01T10:52:00.000Z',
    resolved_at: null,
    idempotency_key: 'k',
    ...extra,
  };
}

const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Accounts and usage', thread_name: null, resolved_at: null, messages });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** How the draft route answers a save (POST); null: it saves. */
let draftSave: (() => Response | Promise<Response>) | null = null;
let serverDraft: { body: string; updated_at: string } | null = null;
let saves = 0;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  draftSave = null;
  serverDraft = null;
  saves = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/draft')) {
      if (init?.method === 'POST') {
        saves += 1;
        if (draftSave) return draftSave();
        const body = (JSON.parse(String(init.body)) as { body: string }).body;
        serverDraft = { body, updated_at: new Date(Date.now() + saves).toISOString() };
        return Response.json({ draft: { thread_id: M1, ...serverDraft } });
      }
      return Response.json({ draft: serverDraft ? { thread_id: M1, ...serverDraft } : null });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], ...(asked ? { asker: { session: asked, live: true, connection: null } } : {}) });
    }
    if (init?.method === 'POST') return Response.json({ questions: [] });
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

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(thread: InboxThread, sent: { at: string; checked_at: string | null } | null = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={thread} sent={sent} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  await settle();
  return host;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * The "to" line under a message, the last reply's delivery line, and the reply box: any label above it (none, approval
 * "inbox-reply-recipient"), its field's name, and the recipient pill's name (only in a thread with more than one agent).
 */
const toLine = (el: HTMLElement, id: string) => el.querySelector(`[data-message-article="${id}"] .ib-to`)?.textContent ?? null;
const deliveryText = (el: HTMLElement) => el.querySelector('.ib-delivered .ib-dl-text')?.textContent ?? null;
async function boxHead(el: HTMLElement) {
  act(() => button(el, 'Reply').click());
  await settle();
  return {
    head: [...el.querySelectorAll('.ib-pfoot *')].find((n) => n.children.length === 0 && n.textContent?.startsWith('Reply to'))?.textContent ?? null,
    field: el.querySelector('textarea')?.getAttribute('aria-label') ?? null,
    pill: el.querySelector('[data-recipient] .ib-rto-full')?.textContent ?? null,
  };
}

test.skipIf(!hasDom)('Claude Code started, Pi wrote last: "to Pi" under the reply, "Delivered to Pi", and the box names Pi, in its field and its pill', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE), agentMessage(M2, PI), personReply(M2)), { at: '2026-11-01T10:52:00.000Z', checked_at: CHECKED });
  expect(toLine(el, R1)).toBe('to Pi');
  expect(deliveryText(el)).toMatch(/^Delivered to Pi, /);
  expect(await boxHead(el)).toEqual({ head: null, field: 'Reply to Pi', pill: 'Pi' });
});

test.skipIf(!hasDom)('a second agent with no wake, not read yet: "Saved for Cursor", never the first agent', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE), agentMessage(M2, CURSOR, { wakes: undefined }), personReply(M2)), { at: '2026-11-01T10:52:00.000Z', checked_at: null });
  expect(toLine(el, R1)).toBe('to Cursor');
  expect(deliveryText(el)).toBe('Saved for Cursor. It sees it when it next reads this thread.');
});

test.skipIf(!hasDom)('a thread the person started to Claude Code, Pi wrote last: the reply to Pi says "to Pi" and "Delivered to Pi", not Claude Code', async () => {
  const started: InboxMessageWire = {
    ...personReply(M1),
    id: M1,
    reply_to: null,
    subject: 'Accounts and usage',
    body: 'Add a usage panel.',
    created_at: '2026-11-01T10:40:00.000Z',
    started_by_person: true,
    to: { host: 'claude-code', session: 'ses_claude' },
    idempotency_key: 'k0',
  };
  const reply = personReply(M2, { delivery: { state: 'delivered', host: 'pi', session: 'ses_pi', at: CHECKED } });
  const el = await render(threadOf(started, agentMessage(M2, PI), reply), { at: '2026-11-01T10:52:00.000Z', checked_at: CHECKED });
  expect(toLine(el, R1)).toBe('to Pi');
  expect(deliveryText(el)).toMatch(/^Delivered to Pi, /);
});

test.skipIf(!hasDom)('one agent: every name is the thread\'s agent, as before ("to Claude Code", "Delivered to Claude Code", "Reply to Claude Code", no pill)', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE), agentMessage(M2, CLAUDE), personReply(M2)), { at: '2026-11-01T10:52:00.000Z', checked_at: CHECKED });
  expect(toLine(el, R1)).toBe('to Claude Code');
  expect(deliveryText(el)).toMatch(/^Delivered to Claude Code, /);
  expect(await boxHead(el)).toEqual({ head: null, field: 'Reply to Claude Code', pill: null });
});

test.skipIf(!hasDom)('one agent that named itself: its own name, as before, wherever it wrote', async () => {
  const el = await render(threadOf(agentMessage(M1, CURSOR, { wakes: undefined }), agentMessage(M2, { ...CURSOR, name: 'Cursor Agent' }, { wakes: undefined }), personReply(M2)), {
    at: '2026-11-01T10:52:00.000Z',
    checked_at: null,
  });
  // The thread's name for its one agent (the root's), whichever message the reply answers.
  expect(toLine(el, R1)).toBe('to Cursor');
  expect(deliveryText(el)).toBe('Saved for Cursor. It sees it when it next reads this thread.');
  expect(await boxHead(el)).toEqual({ head: null, field: 'Reply to Cursor', pill: null });
});

test.skipIf(!hasDom)('an archived thread Claude Code started that Pi wrote in after the archive: the came-back note names Pi, whom the reply goes to', async () => {
  const thread: InboxThread = {
    ...threadOf(agentMessage(M1, CLAUDE, { seq: 1 }), agentMessage(M2, PI, { seq: 3, created_at: '2026-11-01T11:45:00.000Z' })),
    resolved_at: '2026-11-01T11:00:00.000Z',
    archive_seq: 2,
  };
  const el = await render(thread);
  expect(el.querySelector('[data-came-back] .ib-st')?.textContent).toBe('Archived · Pi wrote after you archived it. Your reply goes to it; the thread stays archived.');
});

test.skipIf(!hasDom)('an archived thread its one agent came back to: the came-back note names that agent, as before', async () => {
  const thread: InboxThread = {
    ...threadOf(agentMessage(M1, CLAUDE, { seq: 1 }), agentMessage(M2, CLAUDE, { seq: 3, created_at: '2026-11-01T11:45:00.000Z' })),
    resolved_at: '2026-11-01T11:00:00.000Z',
    archive_seq: 2,
  };
  const el = await render(thread);
  expect(el.querySelector('[data-came-back] .ib-st')?.textContent).toBe('Archived · Claude Code wrote after you archived it. Your reply goes to it; the thread stays archived.');
});

test.skipIf(!hasDom)('a draft save that did not land says "Not saved", never the last good "Saved" time; the next save that lands goes quiet again', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE)));
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Ship the usage panel');
  await settle(700);
  // A computer saves silently (approval "inbox-reply-box", T6): no Saved time in the box, only a failure shows.
  expect(serverDraft?.body).toBe('Ship the usage panel');
  expect(el.querySelector('[data-draft-head]')).toBeNull();

  // The Inbox stops answering: the save fails and reading the draft back finds the older words.
  draftSave = () => {
    throw new TypeError('Failed to fetch');
  };
  type(el, 'Ship the usage panel, and the totals fix');
  await settle(700);
  await settle(50);
  expect(el.querySelector('[data-draft-head] .ib-draft-saved')?.textContent).toBe(DRAFT_NOT_SAVED_FAILED);
  expect(el.querySelector('[data-draft-head]')?.hasAttribute('data-draft-failed')).toBe(true);

  // A refusal says the same.
  draftSave = () => Response.json({ error: 'base: not a time', code: 'validation_error' }, { status: 400 });
  type(el, 'Ship the usage panel, and the totals fix, today');
  await settle(700);
  await settle(50);
  expect(el.querySelector('[data-draft-head] .ib-draft-saved')?.textContent).toBe(DRAFT_NOT_SAVED_FAILED);

  draftSave = null;
  type(el, 'Ship the usage panel, and the totals fix, today.');
  await settle(700);
  await settle(50);
  expect(serverDraft?.body).toBe('Ship the usage panel, and the totals fix, today.');
  expect(el.querySelector('[data-draft-head]')).toBeNull();
  expect(el.querySelector('[data-draft-failed]')).toBeNull();
});

test.skipIf(!hasDom)('an emptied box whose save did not land: the restart guard does not ask, since a restart loses nothing', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE)));
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Ship it');
  await settle(700);
  expect(serverDraft?.body).toBe('Ship it');
  expect(unsentReply()).toBeNull();

  // The Inbox stops answering, and the person empties the box: that save (a delete) fails, and the read-back
  // finds the older words. A restart brings them back, so nothing would be lost.
  draftSave = () => {
    throw new TypeError('Failed to fetch');
  };
  type(el, '');
  await settle(700);
  await settle(50);
  expect(saves).toBe(2);
  expect(unsentReply()).toBeNull();

  // Words typed again that do not land: those a restart would lose, so the guard asks.
  type(el, 'Ship it today');
  await settle(700);
  await settle(50);
  expect(unsentReply()).not.toBeNull();
  draftSave = null;
  type(el, 'Ship it today.');
  await settle(700);
  await settle(50);
  expect(unsentReply()).toBeNull();
});
