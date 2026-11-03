/**
 * Replying when the session that asked has ended (design record "replying
 * when the asking agent's session has ended", not in this repo), as the
 * window draws it: the quiet notice before replying, the recipient pill doing
 * the old choice's job at Send (approval "inbox-reply-recipient": its list
 * opens once, Esc, the race), Send at once when nothing is live, and the
 * delivered line's "(another session)". The route choice's own parts stay
 * tested below (Re-ask still opens it).
 * The failure this catches: a reply sent to a session that is gone without
 * the person knowing, or sent somewhere they did not pick.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { whenTime } from './format';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const ASKER = { kind: 'agent' as const, host: 'claude-code', session: 'ses_asker', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const R1 = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';
const BODY = ["I'm stopped on the retry policy.", '', ':::question', 'How should the nightly sync retry?', '', '- [ ] Retry 3 times with backoff', '- [ ] Retry once', ':::'].join('\n');
const WORDS = 'Go with backoff, but cap the total wait at 10 minutes.';

const live = (session: string, host: string, extra: Record<string, unknown> = {}) => ({
  session,
  host,
  started_at: '2026-10-11T10:31:00.000Z',
  last_seen_at: '2026-10-11T10:50:00.000Z',
  busy: false,
  idle_since: '2026-10-11T10:48:00.000Z',
  wrote_thread: false,
  ...extra,
});

function questions(picked: boolean, messageId = M1): InboxQuestion[] {
  return parseInboxQuestionBlocks(BODY).map((q) => ({
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
    asked_by_agent_id: 'ses_asker',
    orphaned: false,
    state: picked ? 'picked' : 'open',
    answer: picked ? { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: ['Retry 3 times with backoff'] } : null,
    revision: picked ? 1 : 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: picked ? '2026-10-11T10:51:00.000Z' : null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
  }));
}

/** The asking message; sent through a waking connection (`wakes`) unless said otherwise. */
function asking(picked = false, wakes = true): InboxMessageWire {
  return {
    id: M1,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: null,
    author: ASKER,
    subject: 'Retry policy for the nightly ledger sync',
    body: BODY,
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    questions: questions(picked),
    ...(wakes ? { wakes: true } : {}),
  };
}

function threadOf(...messages: InboxMessageWire[]): InboxThread {
  return { thread_id: M1, project: PROJECT, subject: 'Retry policy for the nightly ledger sync', thread_name: null, resolved_at: null, messages };
}

function personReply(extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id: R1,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: M1,
    author: { kind: 'person' },
    subject: null,
    body: `Answered 1 question.\n\n${WORDS}`,
    created_at: '2026-10-11T10:52:00.000Z',
    resolved_at: null,
    idempotency_key: 'k',
    ...extra,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let sessions: { sessions: ReturnType<typeof live>[]; asker?: { session: string; live: boolean } } = { sessions: [] };
let replyAnswer: () => Response = () => new Response('{}');
let annotations: InboxAnnotationRecord[] = [];
/** Which sessions are still there, by id (answers `?asker=` for any session); null: `sessions.asker` as set. */
let liveness: Record<string, boolean> | null = null;
/**
 * A session whose `?asker=` reads wait (a slow /sessions round trip): each read waits on its own, in order, until
 * `held[i]` is called; null: none waits.
 */
let holdAsker: { session: string; held: (() => void)[] } | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  liveness = null;
  holdAsker = null;
  annotations = [];
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/reply')) return replyAnswer();
      return Response.json({ questions: [] });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations });
    if (path.includes('/sessions')) {
      // With `liveness`, `?asker=` is answered for whichever session the window asks about.
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      if (holdAsker && asked === holdAsker.session) {
        const held = holdAsker.held;
        await new Promise<void>((resolve) => held.push(resolve));
      }
      const asker = liveness && asked ? { session: asked, live: liveness[asked] ?? false } : sessions.asker;
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, ...sessions, ...(asker ? { asker } : {}) });
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(thread: InboxThread, sent: { at: string; checked_at: string | null } | null = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={thread}
          sent={sent}
          onQuestions={() => {}}
          onChanged={async () => {}}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
        />
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

async function writeReply(el: HTMLElement, words = WORDS) {
  act(() => button(el, 'Reply').click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return text;
}

const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
/** The recipient pill under the box (approval "inbox-reply-recipient"), its list, and the list's rows in order. */
const pill = (el: HTMLElement) => el.querySelector('[data-recipient]') as HTMLButtonElement | null;
const pillList = (el: HTMLElement) => el.querySelector('[data-recipient-list]');
const pillRows = (el: HTMLElement) => [...el.querySelectorAll('[data-recipient-row]')].map((r) => [r.getAttribute('data-recipient-row'), r.querySelector('.ib-rpick-l')?.textContent, r.querySelector('.ib-rpick-q')?.textContent ?? null]);
const pickOnly = (el: HTMLElement, session: string) => act(() => (el.querySelector(`[data-recipient-row="${session}"] .ib-rpick-name`) as HTMLButtonElement).click());

test.skipIf(!hasDom)('ended, live sessions exist: "session ended" on the asking message, the note above the closed reply, and with the box open the pill says "ended" in its place', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  expect(el.querySelector(`[data-message-article="${M1}"] .ib-to`)?.textContent).toBe('to you · session ended');
  const note = el.querySelector('[data-asker-ended]') as HTMLElement;
  expect(note.getAttribute('data-asker-ended')).toBe('live');
  expect(note.textContent).toContain('The Claude Code session that asked has ended.');
  // The note lives in one always-mounted status region.
  const region = el.querySelector('[data-asker-note]') as HTMLElement;
  expect(region.getAttribute('role')).toBe('status');
  expect(region.contains(note)).toBe(true);
  // The box open: the pill under it names the asker, ended (approval "inbox-reply-recipient"), and the note goes.
  await writeReply(el);
  expect(el.querySelector('[data-asker-ended]')).toBeNull();
  expect(pill(el)?.hasAttribute('data-ended')).toBe(true);
  expect(pill(el)?.getAttribute('aria-label')).toBe('To Claude Code, ended. Change who gets this reply');
});

test.skipIf(!hasDom)('a session with no evidence it wakes (MCP-only, OpenCode 1) is never "ended": no mark, no note, Send sends to it with no choice', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking(false, false)));
  expect(el.querySelector('[data-session-ended]')).toBeNull();
  await writeReply(el);
  expect(el.querySelector('[data-asker-ended]')).toBeNull();
  // The status region stays mounted, empty.
  expect(el.querySelector('[data-asker-note]')?.textContent).toBe('');
  act(() => button(el, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('the session that asked is live: no note, no mark, and Send sends to it with no choice', async () => {
  sessions = { sessions: [live('ses_asker', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')], asker: { session: 'ses_asker', live: true } };
  const el = await render(threadOf(asking()));
  expect(el.querySelector('[data-session-ended]')).toBeNull();
  await writeReply(el);
  expect(el.querySelector('[data-asker-ended]')).toBeNull();
  act(() => button(el, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('the pill does the old choice\'s job: Send opens its list once (live first, the asker ended last), nothing goes; a name picked, Send sends `to` that session', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code'), live('ses_pi', 'pi', { busy: true, idle_since: null })], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  const text = await writeReply(el);
  expect(pillList(el)).toBeNull();
  act(() => button(el, 'Send').click());
  await settle();
  expect(replies()).toEqual([]);
  // "Where should this reply go?" is gone (approval "inbox-reply-recipient").
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(pillRows(el)).toEqual([
    ['ses_other', 'Claude Code 2', null],
    ['ses_pi', 'Pi', null],
    ['ses_asker', 'Claude Code', 'ended'],
  ]);
  // An ended agent can't be a second recipient; a live one can.
  expect((el.querySelector('[data-recipient-tick="ses_pi"]') as HTMLButtonElement).disabled).toBe(false);
  expect(text.value).toBe(WORDS);
  pickOnly(el, 'ses_pi');
  await settle();
  expect(pill(el)?.querySelector('.ib-rto-full')?.textContent).toBe('Pi');
  expect(pill(el)?.hasAttribute('data-ended')).toBe(false);
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body).toMatchObject({ words: WORDS, to: { host: 'pi', session: 'ses_pi' } });
  expect(replies()[0]!.body.tags).toBeUndefined();
});

test.skipIf(!hasDom)('Esc closes the pill\'s list with the words kept; Send pressed again leaves the reply for the asker, with no `to`', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  const text = await writeReply(el);
  key(text, { key: 'Enter', metaKey: true });
  await settle();
  expect(pillList(el)).not.toBeNull();
  expect(replies()).toEqual([]);
  // Escape closes the list before anything else hears it (the window's own Esc closes the thread otherwise).
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => void text.dispatchEvent(esc));
  await settle();
  expect(esc.defaultPrevented).toBe(true);
  expect(pillList(el)).toBeNull();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe(WORDS);
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(pillList(el)).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('the race: the session picked ended before the reply went; nothing sent, the list opens with it ended and its circle off, the error says so', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code'), live('ses_pi', 'pi')], asker: { session: 'ses_asker', live: false } };
  replyAnswer = () => {
    // The server's live list no longer has it either (the 409 came from that list).
    sessions = { ...sessions, sessions: sessions.sessions.filter((s) => s.session !== 'ses_other') };
    return Response.json({ error: 'That session is not live any more.', code: 'session_not_live' }, { status: 409 });
  };
  const el = await render(threadOf(asking()));
  await writeReply(el);
  act(() => button(el, 'Send').click());
  await settle();
  pickOnly(el, 'ses_other');
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toEqual({ host: 'claude-code', session: 'ses_other' });
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(pillRows(el).find((r) => r[0] === 'ses_other')?.[2]).toBe('ended');
  expect((el.querySelector('[data-recipient-tick="ses_asker"]') as HTMLButtonElement).disabled).toBe(true);
  expect(el.textContent).toContain('That Claude Code session ended before your reply went. Nothing was sent.');
  // Pi picked: it goes there.
  pickOnly(el, 'ses_pi');
  await settle();
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies().at(-1)!.body.to).toEqual({ host: 'pi', session: 'ses_pi' });
});

test.skipIf(!hasDom)('picks with no text: Send from the foot opens the box with the pill\'s list, and nothing goes', async () => {
  sessions = { sessions: [live('ses_pi', 'pi')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking(true)));
  expect(el.querySelector('[data-asker-ended]')?.getAttribute('data-asker-ended')).toBe('live');
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(el.querySelector('textarea')).not.toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(replies()).toEqual([]);
  // The asker's answer follows the agent picked.
  pickOnly(el, 'ses_pi');
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toEqual({ host: 'pi', session: 'ses_pi' });
});

test.skipIf(!hasDom)('none live: the note says the reply will wait, Send sends at once with no `to`, and the saved line says the asker ended', async () => {
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  await writeReply(el);
  const note = el.querySelector('[data-asker-ended]') as HTMLElement;
  expect(note.getAttribute('data-asker-ended')).toBe('none-live');
  expect(note.textContent).toContain('and no agent is running in ledger now. Your reply will wait here until an agent reads this thread.');
  act(() => button(el, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();

  act(() => root?.unmount());
  host?.remove();
  const after = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  expect(after.querySelector('[data-delivery]')?.textContent).toBe(
    'Saved for Claude Code. The session that asked has ended, so it waits here until an agent reads this thread.',
  );
  // The note is for before replying: once the reply is the last message, its own line says where it went.
  expect(after.querySelector('[data-asker-ended]')).toBeNull();
});

test.skipIf(!hasDom)('while the choice is open: a session that ends greys ("Ended just now."), and the asking session coming back goes to the top, selected', async () => {
  const { mergeRouteRows, CLOSED_ROUTE } = await import('./components/ReplyRoute');
  const asker = { message: asking(), session: 'ses_asker', host: 'claude-code', name: 'Claude Code' };
  const model = (list: ReturnType<typeof live>[]) => ({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: list });
  const open = mergeRouteRows({ ...CLOSED_ROUTE, open: true }, asker, model([live('ses_other', 'claude-code'), live('ses_pi', 'pi')]));
  expect(open.selected).toBe('ses_other');
  const ended = mergeRouteRows(open, asker, model([live('ses_pi', 'pi')]));
  expect(ended.rows.map((r) => [r.live.session, r.ended])).toEqual([['ses_other', true], ['ses_pi', false]]);
  expect(ended.selected).toBe('ses_pi');
  const back = mergeRouteRows(ended, asker, model([live('ses_pi', 'pi'), live('ses_asker', 'claude-code', { wrote_thread: true })]));
  expect(back.rows[0]).toMatchObject({ asker: true, ended: false, live: { session: 'ses_asker' } });
  expect(back.selected).toBe('ses_asker');
});

test.skipIf(!hasDom)('delivered to another session: "(another session)" only when the host is the asker\'s own', async () => {
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  const at = '2026-10-11T10:52:00.000Z';
  const same = await render(
    threadOf(asking(), personReply({ to: { host: 'claude-code', session: 'ses_other' }, delivery: { state: 'delivered', host: 'claude-code', session: 'ses_other', at } })),
    { at, checked_at: at },
  );
  // The day too when it is not today (format.ts whenTime).
  const time = whenTime(at);
  expect(same.querySelector(`[data-message-article="${R1}"] .ib-to`)?.textContent).toBe('to Claude Code (another session)');
  expect(same.querySelector('[data-delivery]')?.textContent).toBe(`Delivered to Claude Code (another session), ${time}`);

  act(() => root?.unmount());
  host?.remove();
  const other = await render(
    threadOf(asking(), personReply({ to: { host: 'pi', session: 'ses_pi' }, delivery: { state: 'delivered', host: 'pi', session: 'ses_pi', at } })),
    { at, checked_at: at },
  );
  expect(other.querySelector(`[data-message-article="${R1}"] .ib-to`)?.textContent).toBe('to Pi');
  expect(other.querySelector('[data-delivery]')?.textContent).toBe(`Delivered to Pi, ${time}`);
});

test.skipIf(!hasDom)('a Send answering two sessions: `to` rides only the ended asker\'s message; when it is refused after the other went, the error says what went', async () => {
  const M0 = 'msg_01M4H5AAAAAAAAAAAAAAAAAAAA';
  const other: InboxMessageWire = {
    ...asking(true),
    id: M0,
    author: { kind: 'agent', host: 'pi', session: 'ses_pi_asker', name: null },
    created_at: '2026-10-11T10:30:00.000Z',
    questions: questions(true, M0),
  };
  const mine: InboxMessageWire = { ...asking(true), reply_to: M0 };
  sessions = { sessions: [live('ses_other', 'claude-code'), live('ses_pi', 'pi')], asker: { session: 'ses_asker', live: false } };
  replyAnswer = () =>
    posted.at(-1)!.path.includes(M1)
      ? Response.json({ error: 'That session is not live any more.', code: 'session_not_live' }, { status: 409 })
      : Response.json({ reply: {}, questions: [], replayed: false });
  const el = await render({ ...threadOf(other, mine), thread_id: M0 });
  // The pill names the ended asker (it wrote last): Send opens its list, and a live session is picked there.
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toEqual([]);
  pickOnly(el, 'ses_other');
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies().map((r) => [r.path.includes(M0) ? 'other' : 'asker', r.body.to ?? null])).toEqual([
    ['other', null],
    ['asker', { host: 'claude-code', session: 'ses_other' }],
  ]);
  expect(el.textContent).toContain('That Claude Code session ended before all of your reply went. 1 of 2 agents got their reply; the rest did not.');
  expect(pillList(el)).not.toBeNull();
});

test.skipIf(!hasDom)('"Show N more": a selected row past the first five shows in its place, and stays there when the rest opens', async () => {
  const { RouteChoice, CLOSED_ROUTE } = await import('./components/ReplyRoute');
  const rows = Array.from({ length: 8 }, (_, i) => ({ live: live(`ses_${i}`, 'pi'), ended: false, asker: false }));
  const state = { ...CLOSED_ROUTE, open: true, rows, selected: 'ses_6' };
  const asker = { message: asking(), session: 'ses_asker', host: 'claude-code', name: 'Claude Code' };
  host = document.createElement('div');
  document.body.appendChild(host);
  const draw = (showAll: boolean) =>
    act(() => {
      root ??= createRoot(host!);
      root.render(
        <RouteChoice name="route-t" asking={asker} project="ledger" state={{ ...state, showAll }} sending={false} onSelect={() => {}} onSubmit={() => {}} onBack={() => {}} onShowAll={() => {}} />,
      );
    });
  const order = () => [...host!.querySelectorAll('[data-route-session]')].map((n) => n.getAttribute('data-route-session'));
  draw(false);
  expect(order()).toEqual(['ses_0', 'ses_1', 'ses_2', 'ses_3', 'ses_4', 'ses_5', 'ses_6', 'leave']);
  expect(button(host!, 'Show 1 more')).toBeTruthy();
  draw(true);
  expect(order()).toEqual(['ses_0', 'ses_1', 'ses_2', 'ses_3', 'ses_4', 'ses_5', 'ses_6', 'ses_7', 'leave']);
});

// Two sessions in one thread: A asked (its question picked), then B posted a
// later update with no question. A Send of picks only answers A alone, so the
// asker the window watches (and offers a choice for) is A, never B.
const B = 'msg_01M4HB2W6Q8X0P5T7R9V3K1N4D';
function laterUpdate(): InboxMessageWire {
  return {
    id: B,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: M1,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_b', name: null },
    subject: null,
    body: 'Update: the nightly sync ran clean last night.',
    created_at: '2026-10-11T10:45:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
  };
}

test.skipIf(!hasDom)("picks only on A's older question, the latest message from B, B ended: no choice opens, A gets the answer, B gets nothing", async () => {
  liveness = { ses_asker: true, ses_b: false };
  sessions = { sessions: [live('ses_asker', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  expect(el.querySelector('[data-asker-ended]')).toBeNull();
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)("picks only on A's older question, the latest message from B, A ended: A's answers go to B, the live agent the pill names, with no choice", async () => {
  liveness = { ses_asker: false, ses_b: true };
  sessions = { sessions: [live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  await settle();
  // The pill takes the route choice's place (approval "inbox-reply-recipient"): its agent, B, gets the ended asker's answer.
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.to ?? null])).toEqual([['A', { host: 'claude-code', session: 'ses_b' }]]);
});

// Handoff "multi-agent-thread-model", failure 2: a pick on ended A's question while the words go to live B.
// The words' session is live, so A's answer used to go to A, which had ended, and sat there undelivered with no
// line. Every session a Send reaches is checked now: A's answer follows the live agent the pill names.
test.skipIf(!hasDom)("a pick on ended A's question and words for live B: A's answer follows the agent the pill names (B), B gets the words", async () => {
  liveness = { ses_asker: false, ses_b: true };
  sessions = { sessions: [live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  // The pick waits in the draft: the foot opens it with Edit draft.
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(pill(el)?.hasAttribute('data-ended')).toBe(false);
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.words, r.body.to ?? null])).toEqual([
    ['A', '', { host: 'claude-code', session: 'ses_b' }],
    ['B', 'And keep the logs bucket.', null],
  ]);
});

// The same Send pressed before the read of A lands (the words moved the Send's sessions from A alone to B and A):
// "not read yet" used to read as "not ended", so A's answer went to A, ended.
test.skipIf(!hasDom)("a pick on ended A's question, words for live B, Send before A's read lands: Send waits for it, then A's answer follows B", async () => {
  liveness = { ses_asker: false, ses_b: true };
  sessions = { sessions: [live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  holdAsker = { session: 'ses_asker', held: [] };
  const release = () => holdAsker!.held.splice(0).forEach((go) => go());
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  // A's read has not landed: nothing goes yet.
  expect(replies()).toEqual([]);
  await act(async () => {
    release();
  });
  await settle();
  await settle();
  // "Not read yet" never sends A's answer to A: it follows B, the pill's agent.
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.to ?? null])).toEqual([
    ['A', { host: 'claude-code', session: 'ses_b' }],
    ['B', null],
  ]);
});

// The same Send pressed twice while the first waits for A's read: the second press must not send too, or the first,
// when its read lands, posts every reply again with new keys.
test.skipIf(!hasDom)("a pick on A's question, words for B, both live, Send pressed twice before A's read lands: the replies go once", async () => {
  liveness = { ses_asker: true, ses_b: true };
  sessions = { sessions: [live('ses_asker', 'claude-code', { wrote_thread: true }), live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  holdAsker = { session: 'ses_asker', held: [] };
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  // The effect's read of A waits; the first Send waits on its own read of A.
  act(() => button(el, 'Send').click());
  await settle();
  expect(holdAsker.held.length).toBe(2);
  // The effect's read lands (A is read now), and Send is pressed again while the first still waits.
  await act(async () => {
    holdAsker!.held.shift()!();
  });
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  await act(async () => {
    holdAsker!.held.splice(0).forEach((go) => go());
  });
  await settle();
  await settle();
  expect(replies().map((r) => (r.path.includes(M1) ? 'A' : 'B'))).toEqual(['A', 'B']);
});

// A Send that waited for the ended check went on with what the press saw. Both cases below hold A's read, as above.
async function typeInBox(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function waitingSend(words: string) {
  liveness = { ses_asker: true, ses_b: true };
  sessions = { sessions: [live('ses_asker', 'claude-code', { wrote_thread: true }), live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  holdAsker = { session: 'ses_asker', held: [] };
  act(() => button(el, 'Edit draft').click());
  await settle();
  await typeInBox(el, words);
  act(() => button(el, 'Send').click());
  await settle();
  expect(replies()).toEqual([]);
  return el;
}

async function releaseHeld() {
  await act(async () => {
    holdAsker!.held.splice(0).forEach((go) => go());
  });
  await settle();
  await settle();
}

test.skipIf(!hasDom)('a Send waiting for the ended check, and the person opens another thread: nothing of the first thread goes to the other', async () => {
  await waitingSend('Words for thread one.');
  const T2 = 'msg_01M4HC9Z8Y7X6W5V4T3S2R1Q0P';
  const other: InboxThread = {
    thread_id: T2,
    project: PROJECT,
    subject: 'Another thread',
    thread_name: null,
    resolved_at: null,
    messages: [{ ...laterUpdate(), id: T2, thread_id: T2, reply_to: null, author: { kind: 'agent', host: 'pi', session: 'ses_other', name: null }, subject: 'Another thread', body: 'Shall I bump the cache?' }],
  };
  // The pane stays mounted (no key per thread): the same ThreadPane draws the other thread.
  act(() =>
    root!.render(
      <div className="pn-inbox">
        <ThreadPane thread={other} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    ),
  );
  await settle();
  await releaseHeld();
  expect(replies()).toEqual([]);
});

test.skipIf(!hasDom)('a Send waiting for the ended check, and the person types more: the words in the box when it goes are the ones sent', async () => {
  const el = await waitingSend('First part.');
  await typeInBox(el, 'First part. And the rest.');
  await releaseHeld();
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.words])).toEqual([
    ['A', ''],
    ['B', 'First part. And the rest.'],
  ]);
});

test.skipIf(!hasDom)('a comment only, Send from the foot with the list of comments open: the box opens with the pill\'s list, the comments list goes, nothing is sent', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  annotations = [{ id: 'ann_1', project_id: PROJECT.id, thread_id: M1, message_id: M1, attachment_id: '', path: M1, version: 'current', message: { at: '2026-10-11T10:41:00.000Z' }, annotation: { id: 'ann_1', type: 'COMMENT', text: 'Why three?', originalText: 'retry policy' }, created_at: '2026-10-11T10:50:00.000Z', updated_at: '2026-10-11T10:50:00.000Z', removed_at: null, sent_reply_id: null }];
  const el = await render(threadOf(asking()));
  const list = () => el.querySelector('[data-comments-list]');
  act(() => (el.querySelector('[data-comments-link]') as HTMLElement).click());
  expect(list()).not.toBeNull();
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Send').click());
  await settle();
  await settle();
  expect(replies()).toEqual([]);
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(list()).toBeNull();
});
