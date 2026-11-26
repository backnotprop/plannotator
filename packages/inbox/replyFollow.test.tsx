/**
 * Who gets the reply follows the agent that wrote last while the reply box is empty (the owner's decision of
 * 2026-11-21, "Yes, follow until I type or pick"; thread/replyAim.ts), in a thread with more than one agent. The
 * failure this catches, the one that sends words to the wrong agent: a chip that changes under words being written,
 * when an agent writes between a keystroke, a pick saving, dictation or a failed Send and the Send. Also: an empty box
 * that keeps naming an agent who is no longer the last to write, a pick or a draft that a new message takes back, an
 * agent that ended passed over (its thread still takes a message; the chip says it ended and Send stops once, as
 * before), a one-agent thread that grows a chip.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';
import type { RecipientRow } from './replyRecipients';
import { followedSession } from './thread/replyAim';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'orders-abcdef', name: 'orders', root: '/work/orders', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
/** A session the Inbox wakes itself (Codex), off the live list: ended to the window, yet its thread takes a message. */
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
/** Each thread's draft as the last save left it (its route's path), read back when the thread opens again. */
let drafts = new Map<string, Record<string, unknown> | null>();
/** The live sessions (the `@` model and the live list); one taken out reads as ended at the next read. */
let live: TaggableSession[] = [];
/** How many Sends are refused for now (429, nothing written) before they go. */
let replyFails = 0;
/** A pick's save never answers while set: the pick is still saving. */
let holdPicks = false;

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
  drafts = new Map();
  replyFails = 0;
  holdPicks = false;
  live = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) {
        const draft = { v: 1, thread_id: path.split('/').at(-2), body: body.body, created_at: '2026-11-01T10:40:00.000Z', updated_at: new Date(Date.now() + posted.length).toISOString(), ...(body.recipients ? { recipients: body.recipients } : {}) };
        drafts.set(path, String(body.body ?? '') === '' ? null : draft);
        return Response.json({ draft });
      }
      if (path.endsWith('/picks') && holdPicks) return new Promise<Response>(() => {});
      if (path.endsWith('/reply') && replyFails > 0) {
        replyFails -= 1;
        return Response.json({ error: 'Too many replies at once; try again.', code: 'rate_limited' }, { status: 429 });
      }
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: drafts.has(path) ? drafts.get(path) : savedDraft });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: live });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const sessions = live.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      // `?asker=`: whether the session asked is live, as the live list says.
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions, ...(asked ? { asker: { session: asked, live: live.some((t) => t.session === asked) } } : {}) });
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

test.skipIf(!hasDom)('an agent that ended is still followed (the chip says it ended); the person\'s own message and an Inbox note move nothing', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, GONE, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Codex');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(true);
  act(() => t.add(message(M3, PI, 46)));
  await settle();
  expect(named(el)).toBe('Pi');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(false);
  act(() => t.add(message(M4, GONE, 47)));
  await settle();
  expect(named(el)).toBe('Codex');
  act(() => t.add(message(M5, PERSON, 48)));
  await settle();
  expect(named(el)).toBe('Codex');
  act(() => t.add(message('msg_01M4H7EEEEEEEEEEEEEEEEEEEE', PERSON, 49, { ack_of: M4 })));
  await settle();
  expect(named(el)).toBe('Codex');
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

test('followedSession: the newest agent message, an ended session\'s too; a permission prompt, a routine\'s change line, a session not in the list and a person\'s message are passed over', () => {
  const rows = [row('ses_claude'), row('ses_pi'), row('ses_gone', 'ended'), row('ses_reader', 'reader'), row('ses_old', 'old'), row('perm:ses_claude')];
  const base = [message(M1, CLAUDE, 41), message(M2, PI, 45)];
  expect(followedSession(threadOf(...base), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, GONE, 46)), rows, 'x')).toBe('ses_gone');
  expect(followedSession(threadOf(...base, message(M3, PERSON, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, { ...CLAUDE, session: 'perm:ses_claude' }, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, CLAUDE, 46, { scheduled_change: { at: 'x' } as unknown as InboxMessageWire['scheduled_change'] })), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, { ...CLAUDE, session: 'ses_stranger' }, 46)), rows, 'x')).toBe('ses_pi');
  expect(followedSession(threadOf(...base, message(M3, { ...PI, session: 'ses_reader' }, 46)), rows, 'x')).toBe('ses_reader');
  expect(followedSession(threadOf(...base, message(M3, { ...PI, session: 'ses_old' }, 46)), rows, 'x')).toBe('ses_old');
  expect(followedSession(threadOf(message(M1, PERSON, 41)), rows, 'fallback')).toBe('fallback');
  expect(followedSession(threadOf(...base), [], 'fallback')).toBe('fallback');
});

test('followedSession: a thread handed to another session keeps the hand-off\'s owner, so the former owner writing again does not take the words back', () => {
  const rows = [row('ses_claude'), row('ses_pi')];
  const handoff = message(M3, PERSON, 46, { tags: [{ host: 'pi', session: 'ses_pi', wakes: true }], handoff: {} as InboxMessageWire['handoff'], to: { host: 'pi', session: 'ses_pi' } } as Partial<InboxMessageWire>);
  expect(followedSession(threadOf(message(M1, CLAUDE, 41), handoff, message(M4, CLAUDE, 47)), rows, 'ses_pi')).toBe('ses_pi');
});

const QUESTION_BODY = ['Which totals?', '', ':::question', 'Which totals should the report use?', '', '- [ ] The old totals', '- [ ] The new totals', ':::'].join('\n');

/** QUESTION_BODY's question on `messageId`, asked by `session`: open, or picked and not sent yet. */
function question(messageId: string, session: string, state: 'open' | 'picked'): InboxQuestion[] {
  return parseInboxQuestionBlocks(QUESTION_BODY).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: null,
    suggested_text: null,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: session,
    orphaned: false,
    state,
    answer: state === 'picked' ? { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: ['The old totals'] } : null,
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: state === 'picked' ? '2026-11-01T10:42:00.000Z' : null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
  }));
}
const asking = (id: string, author: InboxMessageWire['author'], minute: number, state: 'open' | 'picked') =>
  message(id, author, minute, { body: QUESTION_BODY, questions: question(id, author.kind === 'agent' ? author.session! : '', state) });
const wordsReply = () => replies().filter((r) => typeof r.body.words === 'string' && r.body.words !== '');

test.skipIf(!hasDom)('the closed foot\'s Send with an answer picked on the question of an agent that ended and wrote last: it stops once and posts nothing; a live agent picked in the list, the answer goes to it', async () => {
  const el = await render(threadOf(message(M1, CLAUDE, 41), asking(M2, GONE, 45, 'picked')));
  expect(field(el)).toBeNull();
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toEqual([]);
  expect(el.querySelector('[data-recipient-list]')).not.toBeNull();
  // The chip names the agent that asked, ended, as it did before the follow rule.
  expect(named(el)).toBe('Codex');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(true);
  act(() => (el.querySelector('[data-recipient-row="ses_claude"] .ib-rpick-name') as HTMLButtonElement).click());
  await settle();
  expect(named(el)).toBe('Claude Code');
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies().map((r) => [r.path.split('/').at(-2), r.body.to ?? null, (r.body.questions as unknown[] | undefined)?.length ?? 0])).toEqual([[M2, { host: 'claude-code', session: 'ses_claude' }, 1]]);
});

test.skipIf(!hasDom)('a session the Inbox wakes itself that dropped off the live list and wrote last: the chip names it, ended, and Send stops once, then goes to it and waits', async () => {
  const el = await render(threadOf(message(M1, CLAUDE, 41), message(M2, PI, 45), message(M3, GONE, 47)));
  await write(el, 'Still on the export?');
  expect(named(el)).toBe('Codex');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(true);
  await send(el);
  expect(replies()).toEqual([]);
  expect(el.querySelector('[data-recipient-list]')).not.toBeNull();
  await send(el);
  expect(answered()).toEqual([M3]);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('an answer saved and a new message from another agent in ONE thread read: the choice holds on the name that was painted', async () => {
  const t = growing(asking(M1, CLAUDE, 41, 'open'), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Pi');
  act(() => {
    const read = { ...t.thread, messages: [asking(M1, CLAUDE, 41, 'picked'), message(M2, PI, 45), message(M3, CLAUDE, 47)] };
    draw(read);
  });
  await settle();
  expect(named(el)).toBe('Pi');
  await write(el, 'And use them for March.');
  await send(el);
  expect(wordsReply().map((r) => r.path.split('/').at(-2))).toEqual([M2]);
});

test.skipIf(!hasDom)('an answer still saving holds the choice: a new message before the save answers does not move it', async () => {
  holdPicks = true;
  const t = growing(message(M1, CLAUDE, 41), asking(M2, PI, 45, 'open'));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Pi');
  const option = [...el.querySelectorAll<HTMLElement>('[data-question-option]')].find((r) => r.textContent?.includes('The new totals'))!.querySelector('input')!;
  act(() => option.click());
  await settle();
  expect(posted.some((p) => p.path.endsWith('/picks'))).toBe(true);
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
});

test.skipIf(!hasDom)('a Send refused for now, another agent writes, Send again: the same agent, the same message and the same idempotency key', async () => {
  replyFails = 1;
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await write(el, 'Use the old totals.');
  await send(el);
  expect(answered()).toEqual([M2]);
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
  await send(el);
  expect(answered()).toEqual([M2, M2]);
  expect(replies()[1]!.body.idempotency_key).toBe(replies()[0]!.body.idempotency_key as string);
});

test.skipIf(!hasDom)('typed (no pick), to another thread and back after an agent wrote there: the words and their agent come back', async () => {
  const X = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(X.thread);
  await write(el, 'Half a thought');
  await settle(1100);
  const other = 'msg_01M4H9ZZZZZZZZZZZZZZZZZZZZ';
  act(() => draw({ ...threadOf({ ...message(other, CLAUDE, 30), thread_id: other, reply_to: null }), thread_id: other }));
  await settle();
  await settle();
  act(() => X.add(message(M3, CLAUDE, 47)));
  await settle();
  await settle();
  expect(field(el)?.value).toBe('Half a thought');
  expect(named(el)).toBe('Pi');
});

test.skipIf(!hasDom)('a pick that comes back with its draft (another thread and back, or a reload) holds after its words are deleted; a Discard or a Send lets it follow again', async () => {
  const X = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(X.thread);
  await openBox(el);
  await pick(el, 'ses_claude');
  await write(el, 'Half a thought');
  await settle(1100);
  const other = 'msg_01M4H9ZZZZZZZZZZZZZZZZZZZZ';
  act(() => draw({ ...threadOf({ ...message(other, CLAUDE, 30), thread_id: other, reply_to: null }), thread_id: other }));
  await settle();
  await settle();
  act(() => X.add(message(M3, PI, 47)));
  await settle();
  await settle();
  expect(field(el)?.value).toBe('Half a thought');
  expect(named(el)).toBe('Claude Code');
  await write(el, '');
  act(() => X.add(message(M4, PI, 48)));
  await settle();
  expect(named(el)).toBe('Claude Code');
  // Discard: the box closes, and the next one follows the newest writer.
  act(() => (el.querySelector('[data-reply-discard]') as HTMLButtonElement).click());
  await settle();
  await openBox(el);
  expect(named(el)).toBe('Pi');
  act(() => root?.unmount());
  host?.remove();
  posted = [];

  // A reload: the draft comes back with the pick, the words are deleted, and it still holds until a Send.
  savedDraft = { v: 1, thread_id: M1, body: 'Still on it?', created_at: '2026-11-01T10:46:00.000Z', updated_at: '2026-11-01T10:46:00.000Z', recipients: ['ses_claude'] };
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const again = await render(t.thread);
  expect(named(again)).toBe('Claude Code');
  await write(again, '');
  act(() => t.add(message(M3, PI, 47)));
  await settle();
  expect(named(again)).toBe('Claude Code');
  await write(again, 'Done.');
  await send(again);
  expect(answered()).toEqual([M1]);
  await openBox(again);
  expect(named(again)).toBe('Pi');
});

test.skipIf(!hasDom)('a quote alone holds the chip: the Reply arrow on the person\'s own message, nothing typed, and a newer agent message moves nothing; taking the quote away follows again', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PERSON, 43), message(M3, PI, 45));
  const el = await render(t.thread);
  act(() => (el.querySelector(`[data-message-article="${M2}"] button[aria-label="Reply"]`) as HTMLButtonElement).click());
  await settle();
  expect(el.querySelector(`[data-reply-quote="${M2}"]`)).not.toBeNull();
  expect(field(el)?.value).toBe('');
  expect(named(el)).toBe('Pi');
  act(() => t.add(message(M4, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Pi');
  act(() => (el.querySelector('[data-reply-quote-remove]') as HTMLButtonElement).click());
  await settle();
  expect(named(el)).toBe('Claude Code');
});

test.skipIf(!hasDom)('the followed agent ends while the box is empty: the chip still names the newest writer, now marked ended, and follows the next one', async () => {
  const t = growing(message(M1, CLAUDE, 41), message(M2, PI, 45));
  const el = await render(t.thread);
  await openBox(el);
  expect(named(el)).toBe('Pi');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(false);
  live = live.filter((s) => s.session !== 'ses_pi');
  // The open box reads who is live every 10 seconds (TagPicker.tsx).
  await settle(10_300);
  expect(named(el)).toBe('Pi');
  expect(chip(el)!.hasAttribute('data-ended')).toBe(true);
  act(() => t.add(message(M3, CLAUDE, 47)));
  await settle();
  expect(named(el)).toBe('Claude Code');
}, 20_000);
