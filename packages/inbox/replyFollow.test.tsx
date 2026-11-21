/**
 * Who gets the reply follows the agent that wrote last while the reply box is empty (the owner's decision of
 * 2026-11-21, "Yes, follow until I type or pick"; thread/replyAim.ts), in a thread with more than one agent. The
 * failure this catches, the one that sends words to the wrong agent: a chip that changes under words being written,
 * when an agent writes between a keystroke and Send. Also: an empty box that keeps naming an agent who is no longer
 * the last to write, a pick or a draft that a new message takes back, an ended agent followed, a one-agent thread that
 * grows a chip.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';
import type { RecipientRow } from './replyRecipients';
import { followedSession } from './thread/replyAim';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'orders-abcdef', name: 'orders', root: '/work/orders', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
/** Not in the live list: ended. */
const GONE = { kind: 'agent' as const, host: 'codex', session: 'ses_gone', name: null };
const PERSON = { kind: 'person' } as InboxMessageWire['author'];
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';
const M3 = 'msg_01M4H7BBBBBBBBBBBBBBBBBBBB';
const M4 = 'msg_01M4H7CCCCCCCCCCCCCCCCCCCC';
const M5 = 'msg_01M4H7DDDDDDDDDDDDDDDDDDDD';

function message(id: string, author: InboxMessageWire['author'], minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Order summary' : null,
    body: `Message ${id.slice(-4)}.`,
    created_at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: author.kind === 'agent' ? true : undefined,
    ...extra,
  };
}

const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Order summary', thread_name: null, resolved_at: null, messages });
const tagged = (session: string, host: string): TaggableSession => ({ session, host, kind: 'live', name: null, project: PROJECT, started_at: null, last_at: '2026-11-01T10:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedXhr: typeof XMLHttpRequest;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let savedDraft: Record<string, unknown> | null = null;

/** An upload that never finishes: the tile stays in the box, uploading. */
class HeldXhr {
  status = 0;
  responseText = '';
  upload = { onprogress: null };
  onload = null;
  onerror = null;
  onabort = null;
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {}
}

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  savedXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = HeldXhr as unknown as typeof XMLHttpRequest;
  posted = [];
  savedDraft = null;
  const taggable = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { thread_id: M1, body: body.body, updated_at: new Date(Date.now() + posted.length).toISOString(), ...(body.recipients ? { recipients: body.recipients } : {}) } });
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: savedDraft });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: taggable });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const sessions = taggable.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions });
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
  globalThis.XMLHttpRequest = savedXhr;
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

let phoneNow = false;
function draw(thread: InboxThread) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phoneNow} />
    </div>,
  );
}

async function render(thread: InboxThread, phone = false) {
  phoneNow = phone;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(thread);
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

const field = (el: HTMLElement) => el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement | null;
async function openBox(el: HTMLElement) {
  if (!field(el)) {
    act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Reply').click());
    await settle();
  }
}
/** The field's words become `words`, as a key or a paste does (no settling: the caller decides what comes next). */
function type(el: HTMLElement, words: string) {
  const text = field(el)!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
  text.dispatchEvent(new Event('input', { bubbles: true }));
}
async function write(el: HTMLElement, words: string) {
  await openBox(el);
  act(() => type(el, words));
  await settle();
}

const chip = (el: HTMLElement) => el.querySelector('[data-recipient]') as HTMLButtonElement | null;
/** Who the control names: a computer's chip shows the name, a phone's says it in its accessible name. */
const named = (el: HTMLElement) => (phoneNow ? (chip(el)?.getAttribute('aria-label') ?? null) : (chip(el)?.querySelector('.ib-rto-full')?.textContent ?? null));
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const answered = () => replies().map((r) => r.path.split('/').at(-2));
async function pick(el: HTMLElement, session: string) {
  act(() => chip(el)!.click());
  await settle();
  act(() => (el.querySelector(`[data-recipient-row="${session}"] .ib-rpick-name`) as HTMLButtonElement).click());
  await settle();
}
async function send(el: HTMLElement) {
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
}

/** The thread as it grows: each call adds one message and draws it, as a thread read does. */
function growing(...messages: InboxMessageWire[]) {
  let thread = threadOf(...messages);
  return {
    get thread() {
      return thread;
    },
    add(next: InboxMessageWire) {
      thread = { ...thread, messages: [...thread.messages, next] };
      draw(thread);
    },
  };
}

test.skipIf(!hasDom)('an empty box follows the agent that wrote last: each new message moves the chip to its agent', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Claude Code');
  act(() => t.add(message(M4, PI, 48)));
  await settle();
  expect(named(el)).toBe('Pi');
});

test.skipIf(!hasDom)('a phone follows the same rule: its control says the newest agent while the box is empty, and holds once a character is typed', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread, true);
  await openBox(el);
  expect(named(el)).toBe('Reply goes to Pi. Change');
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Reply goes to Claude Code. Change');
  await write(el, 'O');
  act(() => t.add(message(M4, PI, 48)));
  await settle();
  expect(named(el)).toBe('Reply goes to Claude Code. Change');
});

test.skipIf(!hasDom)('once anything is typed (a single space too) the chip holds: an agent writing after never moves it, and Send answers the agent it names', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await write(el, ' ');
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
  await write(el, ' Use the old totals.');
  act(() => t.add(message(M4, CLAUDE, 48)));
  await settle();
  expect(named(el)).toBe('Pi');
  await send(el);
  expect(answered()).toEqual([M2]);
  expect(replies()[0]!.body).toMatchObject({ words: 'Use the old totals.' });
});

test.skipIf(!hasDom)('the race: an agent writes between the last keystroke and Send, or in the same moment as the first keystroke; the words still go to the agent the chip named', async () => {
  // Between the last key and the press, with no paint in between: the thread read lands while the Send is on its way.
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await write(el, 'Ship the old totals.');
  act(() => {
    t.add(message(M3, CLAUDE, 47));
    button(el, 'Send').click();
  });
  await settle();
  await settle();
  expect(answered()).toEqual([M2]);
  act(() => root?.unmount());
  host?.remove();
  posted = [];

  // The first key and the new message in one act(): the name shown before the key is the one kept.
  const u = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const again = await render(u.thread);
  await openBox(again);
  expect(named(again)).toBe('Pi');
  act(() => {
    type(again, 'S');
    u.add(message(M3, CLAUDE, 47));
  });
  await settle();
  expect(named(again)).toBe('Pi');
  // The key, the message and the press, all before React paints.
  act(() => type(again, 'Ship it.'));
  act(() => {
    u.add(message(M4, CLAUDE, 48));
    button(again, 'Send').click();
  });
  await settle();
  await settle();
  expect(answered()).toEqual([M2]);
});

test.skipIf(!hasDom)('a file attached holds the chip as words do', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  const input = el.querySelector<HTMLInputElement>('.ib-rbox input[type="file"][data-reply-attach]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'summary.txt', { type: 'text/plain' })] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
});

test.skipIf(!hasDom)('a pick holds in an empty box, and after its words are deleted; with no pick, deleting the words lets it follow again', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  await pick(el, 'ses_claude');
  act(() => t.add(message(M3, PI, 47)));
  await settle();
  expect(named(el)).toBe('Claude Code');
  await write(el, 'x');
  await write(el, '');
  act(() => t.add(message(M4, PI, 48)));
  await settle();
  expect(named(el)).toBe('Claude Code');
  act(() => root?.unmount());
  host?.remove();

  // No pick: typed, deleted, and it follows again.
  const u = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const again = await render(u.thread);
  await write(again, 'x');
  act(() => u.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(again)).toBe('Pi');
  await write(again, '');
  expect(named(again)).toBe('Claude Code');
  act(() => u.add(message(M4, PI, 48)));
  await settle();
  expect(named(again)).toBe('Pi');
});

test.skipIf(!hasDom)('the Reply arrow on a message is a pick: a newer agent message does not take it back', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  act(() => (el.querySelector(`[data-message-article="${M1}"] button[aria-label="Reply"]`) as HTMLButtonElement).click());
  await settle();
  expect(named(el)).toBe('Claude Code');
  act(() => t.add(message(M3, PI, 47)));
  await settle();
  expect(named(el)).toBe('Claude Code');
});

test.skipIf(!hasDom)('after a Send the next reply follows again: the box opens on the newest agent and moves with the next message', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  await pick(el, 'ses_claude');
  await write(el, 'Done.');
  await send(el);
  expect(answered()).toEqual([M1]);
  act(() => t.add(message(M3, PI, 47)));
  await settle();
  await openBox(el);
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M4, CLAUDE, 48)));
  await settle();
  expect(named(el)).toBe('Claude Code');
});

test.skipIf(!hasDom)('a saved draft holds its own target: a newer agent message moves nothing, and Send answers the draft\'s agent', async () => {
  savedDraft = { v: 1, thread_id: M1, body: 'Still on the summary?', created_at: '2026-11-01T10:46:00.000Z', updated_at: '2026-11-01T10:46:00.000Z', recipients: ['ses_pi'] };
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45), message(M3, CLAUDE, 46));
  const el = await render(t.thread);
  expect(field(el)?.value).toBe('Still on the summary?');
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M4, CLAUDE, 48)));
  await settle();
  expect(named(el)).toBe('Pi');
  await send(el);
  expect(answered()).toEqual([M2]);
});

test.skipIf(!hasDom)('an agent that ended, the person\'s own message and an Inbox note move nothing: it follows the newest agent that can take a reply', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, GONE, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Claude Code');
  act(() => t.add(message(M3, PI, 46)));
  await settle();
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M4, GONE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M5, PERSON, 48)));
  await settle();
  expect(named(el)).toBe('Pi');
  act(() => t.add(message('msg_01M4H7EEEEEEEEEEEEEEEEEEEE', PERSON, 49, { ack_of: M3 })));
  await settle();
  expect(named(el)).toBe('Pi');
});

test.skipIf(!hasDom)('one agent: no chip and no indent, before or after it writes again; the reply goes to its newest message', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, CLAUDE, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(chip(el)).toBeNull();
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(chip(el)).toBeNull();
  expect(el.querySelector('[data-field-lead]')).toBeNull();
  await write(el, 'Thanks.');
  await send(el);
  expect(answered()).toEqual([M3]);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('a second agent writes into a one-agent thread while the person types: the chip appears on the agent the words were going to, and Send answers it', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, CLAUDE, 45));
  const el = await render(t.thread);
  await write(el, 'Use the old totals.');
  expect(chip(el)).toBeNull();
  act(() => t.add(message(M3, PI, 47)));
  await settle();
  expect(named(el)).toBe('Claude Code');
  await send(el);
  expect(answered()).toEqual([M2]);
});

const row = (session: string, state: RecipientRow['state'] = 'live', extra: Partial<RecipientRow> = {}): RecipientRow => ({ session, host: 'pi', label: session, short: session, state, ...extra });

test('followedSession: the newest agent message whose session can take a reply; a permission prompt, a routine\'s change line, an ended or unknown session and a person\'s message are passed over', () => {
  const rows = [row('ses_claude'), row('ses_pi'), row('ses_gone', 'ended'), row('ses_reader', 'reader'), row('ses_old', 'old'), row('perm:ses_claude')];
  const base = [message(M1, CLAUDE, 41), message(M2, PI, 45)];
  expect(followedSession(threadOf(...base), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, GONE, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, PERSON, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, { ...CLAUDE, session: 'perm:ses_claude' }, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, CLAUDE, 46, { scheduled_change: { at: 'x' } as unknown as InboxMessageWire['scheduled_change'] })), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, { ...CLAUDE, session: 'ses_stranger' }, 46)), rows, 'x')).toBe('ses_pi');
  // An agent that reads the Inbox, or one on an older Plannotator, still takes a reply.
  expect(followedSession(threadOf(...base, message(M3, { ...PI, session: 'ses_reader' }, 46)), rows, 'x')).toBe('ses_reader');
  expect(followedSession(threadOf(...base, message(M3, { ...PI, session: 'ses_old' }, 46)), rows, 'x')).toBe('ses_old');
  // Nobody can take it: the words' own default.
  expect(followedSession(threadOf(message(M1, GONE, 41)), rows, 'ses_gone')).toBe('ses_gone');
  expect(followedSession(threadOf(...base), [], 'fallback')).toBe('fallback');
});

test('followedSession: a thread handed to another session keeps the hand-off\'s owner, so the former owner writing again does not take the words back', () => {
  const rows = [row('ses_claude'), row('ses_pi')];
  const handoff = message(M3, PERSON, 46, { tags: [{ host: 'pi', session: 'ses_pi', wakes: true }], handoff: {} as InboxMessageWire['handoff'], to: { host: 'pi', session: 'ses_pi' } } as Partial<InboxMessageWire>);
  expect(followedSession(threadOf(message(M1, CLAUDE, 41), handoff, message(M4, CLAUDE, 47)), rows, 'ses_pi')).toBe('ses_pi');
});
