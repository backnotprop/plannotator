/**
 * Floating reply drafts and Ask AI in the corner (approval "inbox-reply-floaters"), over a scripted Inbox (fetch
 * stubbed, nothing started). Failures to catch:
 * - a draft that does not float after the person typed and left (or closed the box), or that floats after they only
 *   read the thread;
 * - a floating draft's Send posting to the wrong thread or message, or leaving its draft behind (it would come back
 *   in the thread and float again); Discard leaving it; a thread with picks waiting sent without them;
 * - Ask's window listing drafts (the owner: separate windows, "no drafts in Ask's menu");
 * - Ask's return arrow pressable with nothing to ask, or not turning into Stop while an answer runs.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReplyDraft, InboxReplyDraftRow, InboxThread } from '@plannotator/core/inbox-types';
import { ChatWindowStore } from '@plannotator/ui/components/chat';

const hasDom = typeof document !== 'undefined';
const mods = (hasDom
  ? {
      ...(await import('./useReplyFloaters')),
      ...(await import('./model')),
      ...(await import('../ask/AskChat')),
      ...(await import('../ask/AskChatMenu')),
    }
  : {}) as typeof import('./useReplyFloaters') & typeof import('./model') & typeof import('../ask/AskChat') & typeof import('../ask/AskChatMenu');

const PROJECT = { id: 'prj_1', name: 'billing' };
const T0 = '2026-11-07T10:00:00.000Z';

interface Fake {
  drafts: Map<string, InboxReplyDraft>;
  threads: Map<string, InboxThread>;
  posts: { path: string; body: Record<string, unknown> }[];
  saves: number;
}
let fake: Fake;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let toasts: { lead: string }[] = [];
let opened: string[] = [];

function thread(id: string, agent = 'msg_' + id): InboxThread {
  return {
    thread_id: id,
    subject: `Subject ${id}`,
    project: { ...PROJECT, key: 'billing-1', root: '/w', created_at: T0 },
    messages: [
      {
        id: agent,
        thread_id: id,
        author: { kind: 'agent', name: 'Claude Code', host: 'claude-code', session: 'ses_' + id },
        body: 'I traced the double charge to the retry worker.',
        questions: [],
        created_at: T0,
      },
    ],
  } as unknown as InboxThread;
}

function draft(id: string, body: string, at = T0): InboxReplyDraft {
  return { v: 1, thread_id: id, body, created_at: T0, updated_at: at, files: [] };
}

function row(id: string, picks = 0): InboxReplyDraftRow {
  const saved = fake.drafts.get(id);
  return {
    thread_id: id,
    subject: `Subject ${id}`,
    thread_name: null,
    project: PROJECT,
    author: { kind: 'agent', name: 'Claude Code', host: 'claude-code', session: 'ses_' + id },
    unseen: 0,
    unsent: { reply_at: saved?.updated_at ?? null, picks, comments: 0 },
    reply_preview: saved?.body ?? null,
  } as unknown as InboxReplyDraftRow;
}

let stamp = 0;
const json = (value: unknown) => Response.json(value);

beforeEach(() => {
  if (!hasDom) return;
  fake = { drafts: new Map(), threads: new Map(), posts: [], saves: 0 };
  toasts = [];
  opened = [];
  window.localStorage.clear();
  mods.rereadFloatEntries();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://inbox.test');
    const path = url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'POST') fake.posts.push({ path, body });
    let m = path.match(/\/threads\/([^/]+)\/draft\/delete$/);
    if (m) {
      fake.drafts.delete(decodeURIComponent(m[1]!));
      return json({ ok: true, deleted: true });
    }
    m = path.match(/\/threads\/([^/]+)\/draft$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (init?.method === 'POST') {
        fake.saves += 1;
        const words = String(body.body ?? '');
        if (!words) {
          fake.drafts.delete(id);
          return json({ draft: null });
        }
        const next = draft(id, words, new Date(Date.parse(T0) + ++stamp * 1000).toISOString());
        fake.drafts.set(id, next);
        return json({ draft: next });
      }
      return json({ draft: fake.drafts.get(id) ?? null });
    }
    m = path.match(/\/messages\/([^/]+)\/reply$/);
    if (m) {
      const owner = [...fake.threads.values()].find((t) => t.messages.some((msg) => msg.id === decodeURIComponent(m![1]!)));
      // The server's compare-and-set clear: the draft named by `clear_draft` goes.
      if (owner && fake.drafts.get(owner.thread_id)?.updated_at === body.clear_draft) fake.drafts.delete(owner.thread_id);
      return json({ message_id: m[1], questions: [], reply: { id: 'msg_reply' }, replayed: false });
    }
    m = path.match(/\/threads\/([^/]+)$/);
    if (m) {
      const found = fake.threads.get(decodeURIComponent(m[1]!));
      return found ? json({ serverSession: 's', cursor: 1, thread: found }) : new Response('{}', { status: 404 });
    }
    if (path.includes('/sessions')) return json({ serverSession: 's', home: '/h', project: PROJECT, sessions: [] });
    if (path.endsWith('/ask')) return json({ chats: [{ thread_id: 'thr_ask', subject: 'Ledger schema review', project: 'billing', host: 'claude-code', at: T0, unread: false, answering: false }] });
    if (path.includes('/skills')) return json({ skills: [] });
    return json({});
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

function fakeAsk(over: Partial<import('../ask/useInboxAsk').AskCorner> = {}): import('../ask/useInboxAsk').AskCorner {
  const store = new ChatWindowStore();
  return { on: true, threadId: null, hasChat: false, unseen: false, host: 'claude-code', subject: null, minimized: true, store, open: () => {}, minimize: () => {}, ...over };
}

let setThreadId: (id: string | null) => void = () => {};
let setRows: (rows: InboxReplyDraftRow[]) => void = () => {};

function Harness({ start, rows: first, ask }: { start: string | null; rows: InboxReplyDraftRow[]; ask: import('../ask/useInboxAsk').AskCorner }) {
  const [threadId, setThread] = useState<string | null>(start);
  const [rows, setRowsState] = useState(first);
  setThreadId = setThread;
  setRows = setRowsState;
  const { layer } = mods.useReplyFloaters({
    rows,
    rowsRead: true,
    threadId,
    phone: false,
    off: false,
    ask,
    openThread: (id) => opened.push(id),
    openDrafts: () => opened.push('drafts'),
    refreshDrafts: () => setRowsState([...fake.drafts.keys()].map((id) => row(id))),
    toast: (next) => toasts.push({ lead: next.lead ?? '' }),
    dismissToast: () => {},
  });
  return <>{layer}</>;
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-rf-card="${id}"] .ib-rf-cardopen`);
const floating = () => mods.floatEntries().map((entry) => entry.id);

test('a draft floats once its thread is left after typing, or its box closed; a thread only read floats nothing', async () => {
  if (!hasDom) return;
  for (const id of ['thr_a', 'thr_b', 'thr_c']) fake.threads.set(id, thread(id));
  fake.drafts.set('thr_a', draft('thr_a', 'Do the small fix first'));
  fake.drafts.set('thr_b', draft('thr_b', 'Already here before the visit'));
  await act(async () => root!.render(<Harness start="thr_a" rows={[row('thr_a'), row('thr_b')]} ask={fakeAsk()} />));
  // Typed in A (its draft saved again), then left for B.
  fake.drafts.set('thr_a', draft('thr_a', 'Do the small fix first: key on invoice_id', '2026-11-07T10:01:00.000Z'));
  act(() => setThreadId('thr_b'));
  await until(() => floating().includes('thr_a'), 'A to float');
  act(() => setRows([row('thr_a'), row('thr_b')]));
  await until(() => card('thr_a') !== null, "A's row in the corner");
  // B only read: its draft is as it was when B opened. Leaving it floats nothing.
  act(() => setThreadId('thr_c'));
  await wait(600);
  expect(floating()).toEqual(['thr_a']);
  // T6's down arrow in C after typing: C floats, but shows only once the person is elsewhere.
  fake.drafts.set('thr_c', draft('thr_c', 'Write down the 23 reports', '2026-11-07T10:02:00.000Z'));
  act(() => setRows([row('thr_a'), row('thr_b'), row('thr_c')]));
  act(() => mods.replyBoxSetAside('thr_c'));
  await until(() => floating().includes('thr_c'), 'C to float on the down arrow');
  expect(card('thr_c')).toBeNull();
  act(() => setThreadId(null));
  await until(() => card('thr_c') !== null, "C's row once out of C");
  // A stray half word set aside floats nowhere.
  fake.threads.set('thr_d', thread('thr_d'));
  act(() => setThreadId('thr_d'));
  fake.drafts.set('thr_d', draft('thr_d', 'ok', '2026-11-07T10:03:00.000Z'));
  act(() => mods.replyBoxSetAside('thr_d'));
  await wait(700);
  expect(floating()).not.toContain('thr_d');
});

test('Send from a floating draft posts to that thread’s message and clears its draft; Discard removes it', async () => {
  if (!hasDom) return;
  fake.threads.set('thr_a', thread('thr_a', 'msg_agent_a'));
  fake.threads.set('thr_b', thread('thr_b', 'msg_agent_b'));
  fake.drafts.set('thr_a', draft('thr_a', 'Key the retry on invoice_id alone'));
  fake.drafts.set('thr_b', draft('thr_b', 'Leave the ledger for next sprint'));
  mods.floatThread('thr_b', Date.now() - 10_000);
  mods.floatThread('thr_a', Date.now() - 10_000);
  await act(async () => root!.render(<Harness start={null} rows={[row('thr_a'), row('thr_b')]} ask={fakeAsk()} />));
  await until(() => card('thr_a') !== null, 'the corner');
  // Two rows: a press spreads first, then opens.
  act(() => card('thr_a')!.click());
  act(() => card('thr_a')!.click());
  await until(() => document.querySelector<HTMLTextAreaElement>('[data-rf-box="thr_a"] textarea')?.value === 'Key the retry on invoice_id alone', "A's words in its window");
  // Only that draft: no other draft's words, and no Ask transcript.
  expect(document.querySelector('[data-rf-box="thr_a"]')!.textContent).not.toContain('Leave the ledger');
  await until(() => document.querySelector('[data-rf-box="thr_a"] [data-rf-peek]') !== null, 'the thread read');
  act(() => document.querySelector<HTMLElement>('[data-rf-box="thr_a"] [data-rf-send]')!.click());
  await until(() => fake.posts.some((p) => p.path.endsWith('/reply')), 'the reply');
  const reply = fake.posts.find((p) => p.path.endsWith('/reply'))!;
  expect(reply.path).toEndWith('/messages/msg_agent_a/reply');
  expect(reply.body.words).toBe('Key the retry on invoice_id alone');
  expect(reply.body.clear_draft).toBe(T0);
  await until(() => toasts.some((t) => t.lead === 'Sent to Claude Code'), 'the sent toast');
  expect(fake.drafts.has('thr_a')).toBe(false);
  expect(fake.drafts.has('thr_b')).toBe(true);
  expect(floating()).toEqual(['thr_b']);
  await until(() => document.querySelector('[data-rf-box]') === null, 'the window to close');

  // Discard, from the bin.
  await until(() => card('thr_b') !== null, "B's row");
  act(() => card('thr_b')!.click());
  await until(() => document.querySelector<HTMLTextAreaElement>('[data-rf-box="thr_b"] textarea')?.value === 'Leave the ledger for next sprint', "B's words");
  act(() => document.querySelector<HTMLElement>('[data-rf-box="thr_b"] [data-rf-discard]')!.click());
  await until(() => fake.posts.some((p) => p.path.endsWith('/threads/thr_b/draft/delete')), 'the discard');
  expect(fake.drafts.has('thr_b')).toBe(false);
  expect(floating()).toEqual([]);
  expect(toasts.at(-1)!.lead).toBe('Reply discarded');
  await until(() => document.querySelector('[data-rf-corner]') === null, 'the corner to go');
});

test('a draft whose thread holds picks hands its Send to the thread and posts nothing', async () => {
  if (!hasDom) return;
  fake.threads.set('thr_p', thread('thr_p'));
  fake.drafts.set('thr_p', draft('thr_p', 'And here is why I picked B'));
  mods.floatThread('thr_p', Date.now() - 10_000);
  await act(async () => root!.render(<Harness start={null} rows={[row('thr_p', 2)]} ask={fakeAsk()} />));
  await until(() => card('thr_p') !== null, 'the corner');
  act(() => card('thr_p')!.click());
  await until(() => document.querySelector('[data-rf-box="thr_p"] [data-rf-send]')?.textContent === 'Open to send', 'Open to send');
  act(() => document.querySelector<HTMLElement>('[data-rf-box="thr_p"] [data-rf-send]')!.click());
  await wait(100);
  expect(opened).toEqual(['thr_p']);
  expect(fake.posts.some((p) => p.path.endsWith('/reply'))).toBe(false);
});

test('the corner lists this thread’s Ask chat beside the drafts, and Ask’s own menu never lists a draft', async () => {
  if (!hasDom) return;
  fake.threads.set('thr_a', thread('thr_a'));
  fake.drafts.set('thr_a', draft('thr_a', 'Do the small fix first'));
  mods.floatThread('thr_a', Date.now() - 10_000);
  let asked = 0;
  const ask = fakeAsk({ threadId: 'thr_ask', hasChat: true, subject: 'Ledger schema review', open: () => (asked += 1) });
  await act(async () => root!.render(<Harness start="thr_ask" rows={[row('thr_a')]} ask={ask} />));
  await until(() => card('ask') !== null && card('thr_a') !== null, 'both rows');
  expect(document.querySelector('[data-rf-card="ask"] [data-ask-sparkle]')).not.toBeNull();
  expect(card('ask')!.textContent).toContain('Ask AI · Ledger schema review');
  act(() => card('ask')!.click());
  act(() => card('ask')!.click());
  expect(asked).toBe(1);
  expect(document.querySelector('[data-rf-box]')).toBeNull();
  act(() => root!.unmount());

  // Ask's header menu, with a draft floating: chats only.
  root = createRoot(host!);
  const chat = { thread_id: 'thr_ask', subject: 'Ledger schema review', project: 'billing', host: 'claude-code', at: T0, unread: false, answering: false };
  await act(async () => root!.render(<mods.AskChatMenu current={chat} phone={false} onPick={() => {}} />));
  const chip = document.querySelector<HTMLElement>('[data-ask-chip]')!;
  expect(chip.textContent).toContain('Ask AI · Ledger schema review');
  act(() => chip.click());
  await until(() => document.querySelector('[data-ask-menu] [data-ask-chat]') !== null, 'the menu');
  const menu = document.querySelector('[data-ask-menu]')!;
  expect(menu.textContent).not.toContain('Subject thr_a');
  expect(menu.textContent).not.toContain('Draft');
  expect([...menu.querySelectorAll('[role="menuitem"]')].every((item) => item.hasAttribute('data-ask-chat'))).toBe(true);
});

test('Ask’s return arrow is grey and off while the box is empty, sends once there are words, and is Stop while an answer runs', async () => {
  if (!hasDom) return;
  let sends = 0;
  let stops = 0;
  const box = (words: string, busy: boolean, phone = false) => (
    <mods.AskBox words={words} onWords={() => {}} onSend={() => (sends += 1)} onStop={() => (stops += 1)} busy={busy} posting={false} disabled={false} phone={phone} composerRef={createRef()} notices={null} />
  );
  await act(async () => root!.render(box('', false)));
  const ask = () => document.querySelector<HTMLButtonElement>('[aria-label="Ask"]')!;
  expect(ask().disabled).toBe(true);
  expect(ask().hasAttribute('data-ready')).toBe(false);
  expect(ask().querySelector('[data-ask-glyph="enter"]')).not.toBeNull();
  act(() => ask().click());
  expect(sends).toBe(0);
  await act(async () => root!.render(box('Why did the retry charge twice?', false)));
  expect(ask().disabled).toBe(false);
  expect(ask().hasAttribute('data-ready')).toBe(true);
  act(() => ask().click());
  expect(sends).toBe(1);
  // It sits at the right end of the row (the bin's place on a computer), never as the thread's Send pill.
  expect(ask().closest('.ib-rrow')).not.toBeNull();
  expect(ask().classList.contains('ib-rsend')).toBe(false);
  await act(async () => root!.render(box('Why did the retry charge twice?', true)));
  expect(document.querySelector('[aria-label="Ask"]')).toBeNull();
  act(() => document.querySelector<HTMLElement>('[aria-label="Stop"]')!.click());
  expect(stops).toBe(1);
  // A phone draws an up arrow (its Enter makes a new line).
  await act(async () => root!.render(box('', false, true)));
  expect(ask().querySelector('[data-ask-glyph="up"]')).not.toBeNull();
  expect(ask().disabled).toBe(true);
});
