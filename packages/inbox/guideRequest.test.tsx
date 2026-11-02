/**
 * Request guided review (the thread header's ⋯; guideRequest.ts). The
 * failures this catches: the item offered where nobody can act on it (an
 * archived thread, a host that gets no guided reviews, a session that has
 * ended), the request reaching another session than a typed reply would, a
 * double click sending it twice, and the request eating the person's
 * half-written reply.
 *
 * The rules are pure; the menu runs on the real ThreadPane, DOM-gated
 * (DOM_TESTS=1, from tests/dom-test-list.txt).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { GUIDE_REQUEST_WORDS, guideRequestTarget } from './guideRequest';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-11-02T09:00:00.000Z' };
const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: null };
const PI: InboxAuthor = { kind: 'agent', host: 'pi', session: 'ses_pi', name: null };
const [M1, M2, M3] = ['msg_01M62DTT05NJ59ZR4AJCDJ70XK', 'msg_01M62DTW6WCYD3ZH6Z17MFMA8G', 'msg_01M62DTXR00R23JW3GNA2KTM9H'] as const;
const WORDS = 'Also rename the flag to RETRY_SAME_KEY before you push.';

function message(id: string, author: InboxAuthor, body: string, minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Retry worker for Stripe 409s' : null,
    body,
    created_at: `2026-11-02T10:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: minute,
    ...extra,
  };
}

function threadOf(messages: InboxMessageWire[], extra: Partial<InboxThread> = {}): InboxThread {
  return { thread_id: M1, project: PROJECT, subject: 'Retry worker for Stripe 409s', thread_name: null, resolved_at: null, messages, ...extra };
}

/** Claude Code did the work: the plan, then the PR. */
const worked = (author: InboxAuthor = CLAUDE) =>
  threadOf([message(M1, author, 'I will retry a 409 with the same key.', 1), message(M2, author, 'Done: worker/retry.ts and its tests. PR #142 is open.', 9)]);

// ── Who the request goes to (pure) ──

test('the request answers the message a typed reply answers, and reaches its session', () => {
  expect(guideRequestTarget(worked())).toEqual({ message: worked().messages[1]!, to: { host: 'claude-code', session: 'ses_claude' } });
  expect(guideRequestTarget(worked(PI))?.to).toEqual({ host: 'pi', session: 'ses_pi' });
  // Each host a reply wakes gets it: Codex and Qwen Code through MCP too.
  for (const host of ['opencode', 'codex', 'qwen']) {
    expect(guideRequestTarget(worked({ kind: 'agent', host, session: 'ses_x', name: null }))?.to.host).toBe(host);
  }
});

test('not offered: an archived thread, a host that gets no guided reviews, an agent with no session', () => {
  expect(guideRequestTarget(threadOf(worked().messages, { resolved_at: '2026-11-02T11:00:00.000Z' }))).toBeNull();
  expect(guideRequestTarget(worked({ kind: 'agent', host: 'cursor', session: 'ses_c', name: null }))).toBeNull();
  expect(guideRequestTarget(worked({ kind: 'agent', host: null, session: 'ses_raw', name: null }))).toBeNull();
  expect(guideRequestTarget(worked({ kind: 'agent', host: 'claude-code', session: null, name: null }))).toBeNull();
});

test('a thread the person started goes to the session it is addressed to; a handed-off thread to its new owner', () => {
  const started = threadOf([message(M1, { kind: 'person' }, 'Fix the 409 retries.', 1, { started_by_person: true, to: { host: 'pi', session: 'ses_pi' } })]);
  expect(guideRequestTarget(started)).toEqual({ message: started.messages[0]!, to: { host: 'pi', session: 'ses_pi' } });
  const handoff = message(M3, { kind: 'person' }, 'Pi, take this over.', 12, { to: { host: 'pi', session: 'ses_pi' }, handoff: { from: { host: 'claude-code', session: 'ses_claude' }, at: '2026-11-02T10:12:00.000Z', settled_at: '2026-11-02T10:12:10.000Z' } });
  const handed = threadOf([...worked().messages, handoff]);
  expect(guideRequestTarget(handed)).toEqual({ message: handoff, to: { host: 'pi', session: 'ses_pi' } });
});

test('the words name a guided review (pinned on purpose: the agent tool lists get_guide_brief and submit_guide by that phrase)', () => {
  expect(GUIDE_REQUEST_WORDS).toContain('guided review');
});

// ── The menu (DOM) ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** The session the window asks about, as live or not (`?asker=`). */
let askerLive = true;
let replyAnswer: () => Promise<Response> = async () => Response.json({ reply: {}, questions: [], replayed: false });

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  askerLive = true;
  replyAnswer = async () => Response.json({ reply: {}, questions: [], replayed: false });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'DELETE') {
      posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : {} });
      if (path.endsWith('/reply')) return replyAnswer();
      return Response.json({ questions: [] });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], ...(asked ? { asker: { session: asked, live: askerLive } } : {}) });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('.ib-pm-pos, .ib-pm-scrim').forEach((n) => n.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(t: InboxThread, options: { phone?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={t}
        sent={null}
        phone={options.phone === true}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        linkOf={() => 'http://localhost:4321/'}
      />,
    );
  });
  await settle();
  await settle();
  return host;
}

const threadMenu = () => document.querySelector<HTMLElement>('[data-thread-menu]');
const requestItem = () => threadMenu()?.querySelector<HTMLElement>('[data-thread-guide-request-item]') ?? null;
/** A boolean, never the element: bun's failure message for a happy-dom element can take seconds and pass. */
const offered = () => requestItem() !== null;
const labels = () => [...(threadMenu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));

/** Base UI opens on the pointer's press, as a person's click does. */
async function openMenu() {
  const el = document.querySelector<HTMLButtonElement>('[data-thread-more]')!;
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
  await until(() => !!threadMenu(), 'the thread menu');
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

test.skipIf(!hasDom)('the item sits in its own group above Archive, and sends one reply of the request to the message a reply answers', async () => {
  await render(worked());
  await openMenu();
  expect(labels()).toEqual(['Copy thread', 'Copy link', 'Copy thread ID', 'Request guided review', 'Archive thread']);
  // A double click: the second press finds the request in flight and sends nothing more.
  await act(async () => {
    requestItem()!.click();
    requestItem()?.click();
  });
  await until(() => replies().length > 0, 'the reply');
  await settle();
  expect(replies()).toHaveLength(1);
  const [reply] = replies();
  // The reply route of the agent's latest message: the session a typed reply reaches, no `to` of its own.
  expect(reply!.path).toEndWith(`/api/inbox/messages/${M2}/reply`);
  expect(reply!.body.words).toBe(GUIDE_REQUEST_WORDS);
  expect(reply!.body.to).toBeUndefined();
  expect(typeof reply!.body.idempotency_key).toBe('string');
});

test.skipIf(!hasDom)('a half-written reply stays: the request carries none of it, clears no draft, and Send still sends the words', async () => {
  const el = await render(worked());
  act(() => button(el, 'Reply').click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, WORDS);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await openMenu();
  await act(async () => requestItem()!.click());
  await until(() => replies().length === 1, 'the request');
  await settle();
  expect(replies()[0]!.body.words).toBe(GUIDE_REQUEST_WORDS);
  expect(replies()[0]!.body.clear_draft).toBeUndefined();
  // The box and its words are as the person left them.
  const after = el.querySelector('textarea') as HTMLTextAreaElement;
  expect(after.value).toBe(WORDS);
  act(() => button(el, 'Send').click());
  await until(() => replies().length === 2, 'the typed reply');
  expect(replies()[1]!.body.words).toBe(WORDS);
});

test.skipIf(!hasDom)('hidden, not disabled: an archived thread, a host without guided reviews, a session that has ended', async () => {
  await render(threadOf(worked().messages, { resolved_at: '2026-11-02T11:00:00.000Z' }));
  await openMenu();
  expect(labels()).toContain('Unarchive thread');
  expect(offered()).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  await render(worked({ kind: 'agent', host: 'cursor', session: 'ses_c', name: null }));
  await openMenu();
  expect(labels()).toContain('Copy thread ID');
  expect(offered()).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  // The session that wrote it came through a waking connection and has not been heard from since.
  askerLive = false;
  await render(worked());
  await until(() => !!document.querySelector('[data-session-ended]'), 'the session read as ended');
  await openMenu();
  expect(offered()).toBe(false);
});

test.skipIf(!hasDom)('a refused request says so and sends again with the same key; on a phone the item is in the sheet', async () => {
  let refuse = true;
  replyAnswer = async () => (refuse ? Response.json({ error: 'inbox_busy', message: 'The Inbox is busy.' }, { status: 503 }) : Response.json({ reply: {}, questions: [], replayed: false }));
  const el = await render(worked(), { phone: true });
  await openMenu();
  expect(document.querySelector('[data-thread-menu]')?.closest('.ib-pm-pos')?.hasAttribute('data-phone')).toBe(true);
  await act(async () => requestItem()!.click());
  await until(() => !!el.querySelector('.ib-error'), 'the error line');
  expect(el.querySelector('.ib-error')?.textContent).toContain('guided review request was not sent');
  refuse = false;
  await openMenu();
  await act(async () => requestItem()!.click());
  await until(() => replies().length === 2, 'the retry');
  // The retry is the same request: the server answers a replay, never a second reply.
  expect(replies()[1]!.body.idempotency_key).toBe(replies()[0]!.body.idempotency_key);
});
