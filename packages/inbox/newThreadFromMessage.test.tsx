/**
 * New thread from this message (approved by the owner, 2026-11-23): an item on an agent's message's ⋯ menu that asks
 * the agent that wrote it, and only that agent, to move it to a new thread, as the person's reply to that message.
 *
 * The words (no DOM): the message's first words and its id; a message with no words keeps the id alone.
 * The menu (DOM-gated: DOM_TESTS=1, from the test.yml DOM list), on the real ThreadPane, in a thread two agents
 * share: on agent B's message the item sends one reply, to B's message (so to B's session), and nothing to A; the
 * person's own message has no item; nor has a message of an archived thread that Reply no longer answers.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxReplyQuoteExcerpt } from '@plannotator/core/inbox-reply-quote';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { NEW_THREAD_FROM_MESSAGE_LABEL, newThreadFromMessageOffered, newThreadFromMessageWords } from './thread/newThreadFromMessage';
import type { InboxToastModel } from './components/Toast';
import { lastReplySent } from './api';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-11-23T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const B: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_b', name: null };
const [M1, M2, M3, M4, M5] = ['msg_01M62DTT05NJ59ZR4AJCDJ70X1', 'msg_01M62DTT05NJ59ZR4AJCDJ70X2', 'msg_01M62DTT05NJ59ZR4AJCDJ70X3', 'msg_01M62DTT05NJ59ZR4AJCDJ70X4', 'msg_01M62DTT05NJ59ZR4AJCDJ70X5'] as const;

const A_BODY = 'The retry worker is done. It retries a 409 with the same key, at most 3 times.';
const B_BODY = [
  'I looked at the **webhook** side.',
  '',
  'Stripe resends an event for up to three days, so the handler must be idempotent too.',
  '',
  ':::question',
  'Store processed event ids for how long?',
  '',
  '- [ ] 3 days',
  '- [ ] 30 days',
  ':::',
].join('\n');
const PICTURES_ONLY = '![The failed upload](shots/upload-failed.png)';

function message(id: string, author: InboxAuthor, body: string, seq: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Stripe 409s' : null,
    body,
    created_at: `2026-11-23T10:${String(seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq,
    ...extra,
  };
}

function sample(extra: Partial<InboxThread> = {}): InboxThread {
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Stripe 409s',
    thread_name: 'stripe',
    resolved_at: null,
    messages: [message(M1, A, A_BODY, 1), message(M2, B, B_BODY, 2), message(M3, { kind: 'person' }, 'Both look right. Go on.', 3), message(M4, B, PICTURES_ONLY, 4), message(M5, A, 'Next I will open the PR.', 5)],
    ...extra,
  };
}

// ── The words ──

test("the words carry the message's first words as one plain line, and its id", () => {
  const b = sample().messages[1]!;
  const words = newThreadFromMessageWords(b);
  const excerpt = inboxReplyQuoteExcerpt(b);
  // Guard: the excerpt is plain text (no markup, no question block, no line break).
  expect(excerpt).toStartWith('I looked at the webhook side. Stripe resends');
  expect(excerpt).not.toContain('**');
  expect(excerpt).not.toContain(':::');
  expect(words).toContain(`"${excerpt}" (${M2})`);
  expect(words).not.toContain('\n');
});

test('a message with no words (pictures only) drops the quoted part and keeps the id', () => {
  const pictures = sample().messages[3]!;
  expect(inboxReplyQuoteExcerpt(pictures)).toBe('');
  const words = newThreadFromMessageWords(pictures);
  expect(words).toContain(`(${M4})`);
  expect(words).not.toContain('""');
  expect(words).not.toContain(': "');
});

test("offered on an agent's message with a session; not on the person's, nor on a script's post with no session", () => {
  const [a, , person] = sample().messages;
  expect(newThreadFromMessageOffered(a!)).toBe(true);
  expect(newThreadFromMessageOffered(person!)).toBe(false);
  expect(newThreadFromMessageOffered(message(M5, { kind: 'agent', host: null, session: null, name: null } as unknown as InboxAuthor, 'Nightly build passed.', 5))).toBe(false);
});

// ── The menu ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let toasts: Omit<InboxToastModel, 'id'>[] = [];
let changed = 0;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posts = [];
  toasts = [];
  changed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' && /\/api\/inbox\/messages\/[^/]+\/reply/.test(path)) {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return Response.json({ serverSession: 's', reply: { id: 'msg_reply' }, questions: [] });
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

async function render(t: InboxThread) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={t}
        sent={null}
        // Nothing seen yet: every message is new, so every one is open with its ⋯.
        lookSeq={0}
        phone={false}
        onQuestions={() => {}}
        onChanged={async () => {
          changed += 1;
        }}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onToast={(toast) => toasts.push(toast)}
      />,
    );
  });
  await settle();
}

const more = (id: string) => document.querySelector<HTMLButtonElement>(`[data-message-more="${id}"]`);
const menuOf = (id: string) => document.querySelector<HTMLElement>(`[data-message-menu="${id}"]`);
const labels = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());

/** Opens a message's ⋯ (unfolding the message first when the thread shows it folded). */
async function openMenu(id: string) {
  if (!more(id)) {
    const fold = document.querySelector<HTMLElement>(`[data-message-article="${id}"] button`);
    if (fold) await act(async () => fold.click());
  }
  await until(() => !!more(id), `the ⋯ of ${id}`);
  const button = more(id)!;
  await act(async () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    button.click();
  });
  await until(() => !!menuOf(id), `the menu of ${id}`);
  return menuOf(id)!;
}

test.skipIf(!hasDom)("in a thread two agents share, the item on agent B's message sends one reply, to B's message, and nothing to A", async () => {
  const t = sample();
  await render(t);
  const menu = await openMenu(M2);
  // It leads with Reply, in their own group, where Take back sits on the person's messages.
  expect(labels(menu)).toEqual(['Reply', NEW_THREAD_FROM_MESSAGE_LABEL, 'Copy message', 'Copy link to message', 'Copy thread']);
  await act(async () => menu.querySelector<HTMLElement>('[data-new-thread-item]')!.click());
  await until(() => changed > 0, 'the thread read again');
  expect(posts).toHaveLength(1);
  // A reply to B's own message: the store hands it to the session that wrote it (B), never to A.
  expect(posts[0]!.path).toContain(`/api/inbox/messages/${M2}/reply`);
  for (const id of [M1, M5]) expect(posts[0]!.path).not.toContain(id);
  const words = String(posts[0]!.body.words);
  expect(words).toContain(M2);
  expect(words).toContain(`"${inboxReplyQuoteExcerpt(t.messages[1]!)}"`);
  // A plain reply: no picks sent, no other session aimed at, nothing else carried.
  expect(posts[0]!.body.questions).toEqual([]);
  expect(posts[0]!.body.to).toBeUndefined();
  expect(posts[0]!.body.tags).toBeUndefined();
  expect(typeof posts[0]!.body.idempotency_key).toBe('string');
  // Only that session: the sessions the person added to the thread are not handed it, no #tag is read from it.
  expect(posts[0]!.body.author_only).toBe(true);
  // Not the person's long reply: the page notes no reply's length for it (the one-time voice announcement).
  expect(lastReplySent()).toBeNull();
  expect(toasts).toEqual([]);
});

test.skipIf(!hasDom)('a second press while the first is on its way sends nothing, and the item is off until it lands', async () => {
  let land: () => void = () => {};
  const held = new Promise<void>((resolve) => (land = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' && path.includes('/reply')) {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      await held;
      return Response.json({ serverSession: 's', reply: { id: 'msg_reply' }, questions: [] });
    }
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({ serverSession: 's', attachments: [], annotations: [] });
  }) as typeof fetch;
  await render(sample());
  const first = await openMenu(M2);
  await act(async () => first.querySelector<HTMLElement>('[data-new-thread-item]')!.click());
  await until(() => posts.length === 1, 'the first send');
  await until(() => !menuOf(M2), 'the menu to close');
  const again = await openMenu(M2);
  const item = again.querySelector<HTMLElement>('[data-new-thread-item]')!;
  expect(item.hasAttribute('data-disabled') || item.getAttribute('aria-disabled') === 'true').toBe(true);
  await act(async () => item.click());
  await settle();
  expect(posts).toHaveLength(1);
  land();
  await until(() => changed > 0, 'the thread read again');
  expect(posts).toHaveLength(1);
  expect(toasts).toEqual([]);
});

test.skipIf(!hasDom)('a pictures-only message: the reply carries its id without a quoted part', async () => {
  await render(sample());
  const menu = await openMenu(M4);
  await act(async () => menu.querySelector<HTMLElement>('[data-new-thread-item]')!.click());
  await until(() => posts.length === 1, 'the reply');
  expect(posts[0]!.path).toContain(`/api/inbox/messages/${M4}/reply`);
  expect(String(posts[0]!.body.words)).toContain(`(${M4})`);
  expect(String(posts[0]!.body.words)).not.toContain('""');
});

test.skipIf(!hasDom)("the person's own message has no item", async () => {
  await render(sample());
  const menu = await openMenu(M3);
  expect(labels(menu)).not.toContain(NEW_THREAD_FROM_MESSAGE_LABEL);
  expect(menu.querySelector('[data-new-thread-item]')).toBeNull();
  expect(labels(menu)).toContain('Copy message');
});

test.skipIf(!hasDom)("an archived thread: a message from before the archive, which Reply no longer answers, has no item", async () => {
  await render(sample({ resolved_at: '2026-11-23T11:00:00.000Z', archive_seq: 9 }));
  const menu = await openMenu(M2);
  expect(labels(menu)).not.toContain(NEW_THREAD_FROM_MESSAGE_LABEL);
});

test.skipIf(!hasDom)('a reply the Inbox refuses says so in a toast and reads nothing again', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' && path.includes('/reply')) return Response.json({ code: 'thread_resolved', error: 'This thread is archived.' }, { status: 409 });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({ serverSession: 's', attachments: [], annotations: [] });
  }) as typeof fetch;
  await render(sample());
  const menu = await openMenu(M2);
  await act(async () => menu.querySelector<HTMLElement>('[data-new-thread-item]')!.click());
  await until(() => toasts.length > 0, 'the toast');
  // The Inbox's own sentence.
  expect(toasts[0]).toMatchObject({ icon: 'warn', lead: 'This thread is archived.' });
  expect(changed).toBe(0);
});
