import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxMessageWire, InboxProject, InboxQuestion, InboxRun, InboxThread } from '@plannotator/core/inbox-types';
import { whenTime } from './format';

const hasDom = typeof document !== 'undefined';
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
let sessions: { sessions: ReturnType<typeof live>[]; asker?: { session: string; live: boolean; stuck?: string[] } } = { sessions: [] };
let replyAnswer: () => Response = () => new Response('{}');
let annotations: InboxAnnotationRecord[] = [];
let liveness: Record<string, boolean> | null = null;
let moveRefusal: string | null = null;
let holdAsker: { session: string; held: (() => void)[] } | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  liveness = null;
  moveRefusal = null;
  holdAsker = null;
  annotations = [];
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (moveRefusal && path.endsWith('/to')) return Response.json({ code: moveRefusal, error: 'Refused.' }, { status: 422 });
      if (path.endsWith('/reply')) return replyAnswer();
      return Response.json({ questions: [] });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations });
    if (path.includes('/sessions')) {
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

async function render(thread: InboxThread, sent: { at: string; checked_at: string | null; read_by?: string } | null = null, run?: InboxRun | null, options: { phone?: boolean } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={thread}
          sent={sent}
          {...(run === undefined ? {} : { run })}
          phone={options.phone === true}
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
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return text;
}

const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
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
  expect(note.querySelector('b')?.textContent).toBe('This Claude Code session has ended.');
  const region = el.querySelector('[data-asker-note]') as HTMLElement;
  expect(region.getAttribute('role')).toBe('status');
  expect(region.contains(note)).toBe(true);
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
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(pillRows(el)).toEqual([
    ['ses_other', 'Claude Code 2', null],
    ['ses_pi', 'Pi', null],
    ['ses_asker', 'Claude Code', 'ended'],
  ]);
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
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => void text.dispatchEvent(esc));
  await settle();
  expect(esc.defaultPrevented).toBe(true);
  expect(pillList(el)).toBeNull();
  expect((el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement).value).toBe(WORDS);
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
  expect(el.querySelector('textarea:not([data-question-other])')).not.toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(replies()).toEqual([]);
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
  expect(note.textContent).toContain('A reply waits here until that session is resumed.');
  act(() => button(el, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();

  act(() => root?.unmount());
  host?.remove();
  const after = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  expect(after.querySelector('[data-delivery]')?.textContent).toBe(
    "Saved for Claude Code. That session has ended; it gets this only if it's resumed.",
  );
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
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.to ?? null])).toEqual([['A', { host: 'claude-code', session: 'ses_b' }]]);
});

test.skipIf(!hasDom)("a pick on ended A's question and words for live B: A's answer follows the agent the pill names (B), B gets the words", async () => {
  liveness = { ses_asker: false, ses_b: true };
  sessions = { sessions: [live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
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

test.skipIf(!hasDom)("a pick on ended A's question, words for live B, Send before A's read lands: Send waits for it, then A's answer follows B", async () => {
  liveness = { ses_asker: false, ses_b: true };
  sessions = { sessions: [live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  holdAsker = { session: 'ses_asker', held: [] };
  const release = () => holdAsker!.held.splice(0).forEach((go) => go());
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  expect(replies()).toEqual([]);
  await act(async () => {
    release();
  });
  await settle();
  await settle();
  expect(replies().map((r) => [r.path.includes(M1) ? 'A' : 'B', r.body.to ?? null])).toEqual([
    ['A', { host: 'claude-code', session: 'ses_b' }],
    ['B', null],
  ]);
});

test.skipIf(!hasDom)("a pick on A's question, words for B, both live, Send pressed twice before A's read lands: the replies go once", async () => {
  liveness = { ses_asker: true, ses_b: true };
  sessions = { sessions: [live('ses_asker', 'claude-code', { wrote_thread: true }), live('ses_b', 'claude-code', { wrote_thread: true }), live('ses_other', 'pi')] };
  const el = await render(threadOf(asking(true), laterUpdate()));
  holdAsker = { session: 'ses_asker', held: [] };
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  expect(holdAsker.held.length).toBe(2);
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

async function typeInBox(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
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

const inFoot = (el: HTMLElement, text: string) => [...el.querySelectorAll('[data-foot-buttons] button')].some((b) => b.textContent?.trim() === text);

test.skipIf(!hasDom)('ended, another live: Send to another session and Archive sit with Reply; the first opens the box with the list, the second archives', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  expect(inFoot(el, 'Reply')).toBe(true);
  expect(inFoot(el, 'Send to another session')).toBe(true);
  expect(inFoot(el, 'Archive')).toBe(true);
  const order = [...el.querySelectorAll('[data-foot-buttons] button')];
  const archiveAt = order.findIndex((b) => b.hasAttribute('data-ended-archive'));
  expect(archiveAt).toBeGreaterThan(order.findIndex((b) => b.hasAttribute('data-reply-button')));
  expect(order.findIndex((b) => b.hasAttribute('data-open-questions'))).toBe(archiveAt + 1);
  expect(el.querySelector('[data-foot-buttons] > [data-foot-ended]')!.nextElementSibling!.hasAttribute('data-open-questions')).toBe(true);

  act(() => button(el, 'Send to another session').click());
  await settle();
  expect(el.querySelector('textarea:not([data-question-other])')).not.toBeNull();
  expect(pillList(el)).not.toBeNull();
  expect(pillRows(el).map((r) => r[0])).toContain('ses_other');

  act(() => root?.unmount());
  host?.remove();
  const again = await render(threadOf(asking()));
  act(() => button(again, 'Archive').click());
  await settle();
  expect(posted.some((p) => p.path.endsWith(`/messages/${M1}/resolve`) && p.body.resolved === true)).toBe(true);
});

test.skipIf(!hasDom)('ended, on a phone: Send to another session and Archive come after the open questions, last in the row; the first opens the box with the sheet of who gets the reply', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()), null, undefined, { phone: true });
  const parts = [...el.querySelector('[data-foot-buttons]')!.children];
  const at = (sel: string) => parts.findIndex((p) => p.matches(sel));
  expect(at('[data-reply-button]')).toBeGreaterThanOrEqual(0);
  expect(at('[data-open-questions]')).toBeGreaterThan(at('[data-reply-button]'));
  expect(at('[data-foot-ended]')).toBe(parts.length - 1);
  const pair = [...parts[parts.length - 1]!.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(pair).toEqual(['Send to another session', 'Archive']);
  act(() => button(el, 'Send to another session').click());
  await settle();
  await settle();
  const sheet = pillList(el) as HTMLElement;
  expect(sheet.getAttribute('role')).toBe('dialog');
  expect(pill(el)?.closest('[data-reply-row]') != null).toBe(true);
  expect(pill(el)?.getAttribute('aria-expanded')).toBe('true');
  expect(pill(el)?.getAttribute('aria-label')).toBe('Reply goes to Claude Code, ended. Change');
  expect([...sheet.querySelectorAll('[data-recipient-row]')].map((r) => [r.getAttribute('data-recipient-row'), r.querySelector('.ib-sheet-t')?.textContent, r.querySelector('.ib-sheet-d')?.textContent ?? null])).toEqual([
    ['ses_other', 'Claude Code 2', 'ledger'],
    ['ses_asker', 'Claude Code', 'ended'],
  ]);
  await act(async () => (sheet.querySelector('[data-recipient-row="ses_other"]') as HTMLElement).click());
  await settle();
  expect(pill(el)?.getAttribute('aria-expanded')).toBe('false');
  expect(pill(el)?.getAttribute('data-recipient-chosen')).toBe('ses_other');
  expect(pill(el)?.getAttribute('aria-label')).toBe('Reply goes to Claude Code 2. Change');
});

test.skipIf(!hasDom)('ended, nothing live: only Archive, since nothing could take the reply', async () => {
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  expect(inFoot(el, 'Send to another session')).toBe(false);
  expect(inFoot(el, 'Archive')).toBe(true);
});

test.skipIf(!hasDom)('the session is live, or the host cannot tell: no note and neither button', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: true } };
  const alive = await render(threadOf(asking()));
  expect(alive.querySelector('[data-foot-ended]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const noSignal = await render(threadOf(asking(false, false)));
  expect(noSignal.querySelector('[data-foot-ended]')).toBeNull();
  expect(noSignal.querySelector('[data-asker-ended]')).toBeNull();
});

test.skipIf(!hasDom)('a reply saved for a session that ended can move: the plain reply posts to its own `/to`', async () => {
  sessions = { sessions: [live('ses_other', 'pi')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  act(() => (el.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  act(() => (el.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(posted.find((p) => p.path.endsWith(`/messages/${R1}/to`))?.body.to).toEqual({ host: 'pi', session: 'ses_other' });
});

test.skipIf(!hasDom)('a reply its live session took and will never deliver (`asker.stuck`): the line stops saying it is on its way, and it can move', async () => {
  sessions = { sessions: [live('ses_asker', 'claude-code'), live('ses_other', 'pi')], asker: { session: 'ses_asker', live: true } };
  const waiting = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  expect(waiting.querySelector('[data-delivery]')?.getAttribute('data-delivery')).not.toBe('undelivered');
  expect(!!waiting.querySelector('[data-readdress-open]')).toBe(false);
  act(() => root?.unmount());
  host?.remove();
  sessions = { sessions: [live('ses_asker', 'claude-code'), live('ses_other', 'pi')], asker: { session: 'ses_asker', live: true, stuck: [R1] } };
  const el = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  const line = el.querySelector('[data-delivery]');
  expect(line?.getAttribute('data-delivery')).toBe('undelivered');
  expect(line?.textContent).not.toContain('gets this');
  expect(line?.textContent).not.toContain('still gets it');
  act(() => (el.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  expect([...el.querySelectorAll('[data-readdress-session]')].map((row) => row.getAttribute('data-readdress-session'))).toEqual(['ses_other']);
  act(() => (el.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(posted.find((p) => p.path.endsWith(`/messages/${R1}/to`))?.body.to).toEqual({ host: 'pi', session: 'ses_other' });
});

test.skipIf(!hasDom)('a session the reply already tags is not offered; with no other, neither is the move', async () => {
  sessions = { sessions: [live('ses_b', 'pi'), live('ses_c', 'pi')], asker: { session: 'ses_asker', live: false } };
  const tagged = () => personReply({ tags: [{ host: 'pi', session: 'ses_b', wakes: true, delivery: { host: 'pi', session: 'ses_b', state: 'delivered', at: '2026-10-11T10:51:00.000Z' } }] });
  const both = await render(threadOf(asking(), tagged()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  act(() => (both.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  expect([...both.querySelectorAll('[data-readdress-session]')].map((row) => row.getAttribute('data-readdress-session'))).toEqual(['ses_c']);
  act(() => root?.unmount());
  host?.remove();
  sessions = { sessions: [live('ses_b', 'pi')], asker: { session: 'ses_asker', live: false } };
  const only = await render(threadOf(asking(), tagged()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  expect(!!only.querySelector('[data-readdress-open]')).toBe(false);
});

test.skipIf(!hasDom)('a tag not delivered yet, or a session the reply was handed away from, is still offered', async () => {
  sessions = { sessions: [live('ses_b', 'pi'), live('ses_c', 'pi')], asker: { session: 'ses_asker', live: false } };
  const at = '2026-10-11T10:51:00.000Z';
  const reply = personReply({
    tags: [
      { host: 'pi', session: 'ses_b', wakes: true },
      { host: 'pi', session: 'ses_c', wakes: true, handed_away: true, delivery: { host: 'pi', session: 'ses_c', state: 'delivered', at } },
    ],
  });
  const el = await render(threadOf(asking(), reply), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  act(() => (el.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  expect([...el.querySelectorAll('[data-readdress-session]')].map((row) => row.getAttribute('data-readdress-session'))).toEqual(['ses_b', 'ses_c']);
});

test.skipIf(!hasDom)('a reply the session itself already read is not offered', async () => {
  sessions = { sessions: [live('ses_other', 'pi')], asker: { session: 'ses_asker', live: false } };
  const opened = asking();
  const el = await render(threadOf({ ...opened, agent_checked_seq: 9 }, personReply({ seq: 2 })), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  expect(!!el.querySelector('[data-delivery]')).toBe(true);
  expect(!!el.querySelector('[data-readdress-open]')).toBe(false);
});

test.skipIf(!hasDom)('the session came back as the person moved the reply: the form closes, with no refusal to read', async () => {
  sessions = { sessions: [live('ses_other', 'pi')], asker: { session: 'ses_asker', live: false } };
  moveRefusal = 'session_still_live';
  const el = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  act(() => (el.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  act(() => (el.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(!!el.querySelector('[data-readdress-choice]')).toBe(false);
  expect(!!el.querySelector('.ib-route-error')).toBe(false);
});

test.skipIf(!hasDom)('an older linked machine refuses a plain move: the form stays open and says so', async () => {
  sessions = { sessions: [live('ses_other', 'pi')], asker: { session: 'ses_asker', live: false } };
  moveRefusal = 'not_addressed';
  const el = await render(threadOf(asking(), personReply()), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  act(() => (el.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  act(() => (el.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(!!el.querySelector('[data-readdress-choice]')).toBe(true);
  expect(el.querySelector('.ib-route-error')?.textContent).toBe('Refused.');
});

test.skipIf(!hasDom)('after a move: the next reply answers the moved one, and it is to the new session', async () => {
  sessions = { sessions: [live('ses_other', 'pi')] };
  liveness = { ses_asker: false, ses_other: true };
  const moved = personReply({ to: { host: 'pi', session: 'ses_other' }, took_over: true, delivery: { host: 'pi', session: 'ses_other', state: 'delivered', at: '2026-10-11T10:53:00.000Z' } });
  const el = await render(threadOf(asking(), moved), { at: '2026-10-11T10:52:00.000Z', checked_at: null });
  await writeReply(el);
  expect(pill(el)?.getAttribute('aria-label')).toContain('To Pi');
  expect(pill(el)?.getAttribute('aria-label')).not.toContain('ended');
  act(() => button(el, 'Send').click());
  await settle();
  expect(pillList(el)).toBeNull();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.path).toEndWith(`/messages/${R1}/reply`);
});

const LAUNCHED_ROOT = 'msg_01M4H6G73M9H3Z32T859E72L00';
const LAUNCHED_ASKER = { kind: 'agent' as const, host: 'claude-code', session: 'ses_launched', name: null };
const TAGGED_AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_tagged', name: null };
const stoppedRun = { state: 'stopped', launch_id: 'lch_a', agent: 'claude-code', project: 'ledger', folder: '/work/ledger', since: '2026-10-11T10:50:00.000Z', again: false, stopped_by_person: true, cause: null, untrusted: false, attach_command: null } as InboxRun;

function launchedThread(picked: boolean): InboxThread {
  const inThread = { project_id: PROJECT.id, thread_id: LAUNCHED_ROOT, subject: null, resolved_at: null, idempotency_key: null };
  return {
    thread_id: LAUNCHED_ROOT,
    project: PROJECT,
    subject: 'Fix the sync',
    thread_name: null,
    resolved_at: null,
    messages: [
      {
        ...inThread,
        id: LAUNCHED_ROOT,
        reply_to: null,
        author: { kind: 'person' },
        started_by_person: true,
        to: { host: 'claude-code', session: 'ses_launched' },
        subject: 'Fix the sync',
        body: 'Fix the sync.',
        created_at: '2026-10-11T10:40:00.000Z',
        idempotency_key: 'k-root',
        launch: { id: 'lch_a', agent: 'claude-code', session_ref: 'sa', folder: '/work/ledger', scratch: false, started_at: '2026-10-11T10:40:00.000Z' },
      } as InboxMessageWire,
      { ...inThread, id: M1, reply_to: LAUNCHED_ROOT, author: LAUNCHED_ASKER, body: BODY, created_at: '2026-10-11T10:41:00.000Z', questions: questions(picked).map((q) => ({ ...q, asked_by_agent_id: 'ses_launched' })), wakes: true },
      { ...inThread, id: R1, reply_to: M1, author: TAGGED_AGENT, body: 'Tagged in: the bucket is yours to choose.', created_at: '2026-10-11T10:45:00.000Z', wakes: true },
    ],
  };
}

test.skipIf(!hasDom)('a launched thread, its stopped agent the only one: never "ended", and the reply goes to it, which starts it again', async () => {
  liveness = { ses_launched: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const el = await render({ ...thread, messages: thread.messages.slice(0, 2) }, null, stoppedRun);
  expect(el.querySelector('[data-session-ended]')).toBeNull();
  expect(el.querySelector('[data-asker-ended]')).toBeNull();
  await writeReply(el);
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(replies().map((r) => [r.path, r.body.to ?? null])).toEqual([[`/api/inbox/messages/${M1}/reply`, null]]);
});

const SAVED_REPLY = 'msg_01M4H6G73M9H3Z32T859E72L09';
const savedIn = (asked: InboxMessageWire, replyTo: string, to?: { host: string; session: string }) =>
  ({ ...asked, id: SAVED_REPLY, reply_to: replyTo, author: { kind: 'person' }, questions: undefined, wakes: undefined, ...(to ? { to } : {}), body: 'Carry on.', created_at: '2026-10-11T10:50:00.000Z', idempotency_key: 'k-saved' }) as InboxMessageWire;
const SAVED_AT = { at: '2026-10-11T10:52:00.000Z', checked_at: null };

test.skipIf(!hasDom)('a launched thread, a plain reply for its own agent: stopped, the reply starts it, so no move; gone, the line offers the move', async () => {
  liveness = { ses_launched: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked] = thread.messages as [InboxMessageWire, InboxMessageWire];
  const withSaved = { ...thread, messages: [rootMessage, asked, savedIn(asked, M1)] };
  const stopped = await render(withSaved, SAVED_AT, stoppedRun);
  expect(stopped.querySelector('[data-run]')?.getAttribute('data-run')).toBe('stopped');
  expect(!!stopped.querySelector('[data-readdress-open]')).toBe(false);
  act(() => root?.unmount());
  host?.remove();
  const gone = await render(withSaved, SAVED_AT, { ...stoppedRun, state: 'missing' });
  expect(gone.querySelector('[data-run]')?.textContent).toContain('or send the reply to another session');
  act(() => (gone.querySelector('[data-readdress-open]') as HTMLButtonElement).click());
  await settle();
  act(() => (gone.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(posted.find((p) => p.path.endsWith(`/messages/${SAVED_REPLY}/to`))?.body.to).toEqual({ host: 'pi', session: 'ses_other' });
});

test.skipIf(!hasDom)('a launched thread, its agent gone: the words and the form only while the reply can move', async () => {
  liveness = { ses_launched: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked] = thread.messages as [InboxMessageWire, InboxMessageWire];
  const gone = { ...stoppedRun, state: 'missing' } as typeof stoppedRun;
  const OFFER = 'or send the reply to another session';
  const read = async (t: InboxThread) => {
    const el = await render(t, SAVED_AT, gone);
    const seen = { words: !!el.querySelector('[data-run]')?.textContent?.includes(OFFER), form: !!el.querySelector('[data-readdress-open]') };
    act(() => root?.unmount());
    host?.remove();
    return seen;
  };
  const saved = savedIn(asked, M1);
  const withSaved = { ...thread, messages: [rootMessage, asked, saved] };
  expect(await read(withSaved)).toEqual({ words: true, form: true });
  const taken = { ...saved, delivery: { host: 'claude-code', session: 'ses_launched', state: 'delivered', at: '2026-10-11T10:51:00.000Z' } } as InboxMessageWire;
  expect(await read({ ...thread, messages: [rootMessage, asked, taken] })).toEqual({ words: false, form: false });
  const read9 = { ...rootMessage, agent_checked_seq: 9 } as InboxMessageWire;
  expect(await read({ ...thread, messages: [read9, asked, { ...saved, seq: 2 } as InboxMessageWire] })).toEqual({ words: false, form: false });
  const at = '2026-10-11T11:00:00.000Z';
  expect(await read({ ...thread, resolved_at: at, messages: [{ ...rootMessage, resolved_at: at }, asked, saved] })).toEqual({ words: false, form: false });
  const tagged = { ...saved, tags: [{ host: 'pi', session: 'ses_other', wakes: true, delivery: { host: 'pi', session: 'ses_other', state: 'delivered', at: '2026-10-11T10:51:00.000Z' } }] } as InboxMessageWire;
  expect(await read({ ...thread, messages: [rootMessage, asked, tagged] })).toEqual({ words: false, form: false });
  sessions = { sessions: [] };
  expect((await read(withSaved)).words).toBe(false);
});

test.skipIf(!hasDom)('a launched thread, a plain reply for a tagged agent that ended: a move, and no line saying the reply starts the launched agent', async () => {
  liveness = { ses_launched: false, ses_tagged: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked, tagged] = thread.messages as [InboxMessageWire, InboxMessageWire, InboxMessageWire];
  const el = await render({ ...thread, messages: [rootMessage, asked, tagged, savedIn(asked, R1)] }, SAVED_AT, stoppedRun);
  expect(!!el.querySelector('[data-readdress-open]')).toBe(true);
  expect(!!el.querySelector('[data-run]')).toBe(false);
});

test.skipIf(!hasDom)('a launched thread, its agent stopped, a reply aimed at a session that ended: a move, and no line saying the reply starts the launched agent', async () => {
  liveness = { ses_launched: false, ses_c: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked] = thread.messages as [InboxMessageWire, InboxMessageWire];
  const el = await render({ ...thread, messages: [rootMessage, asked, savedIn(asked, M1, { host: 'pi', session: 'ses_c' })] }, SAVED_AT, stoppedRun);
  expect(!!el.querySelector('[data-run]')).toBe(false);
  expect(!!el.querySelector('[data-readdress-open]')).toBe(true);
});

test.skipIf(!hasDom)('a launched root moved before it started, a reply on the session it moved to: no "isn\'t on this computer" line and no move', async () => {
  liveness = { ses_c: true };
  sessions = { sessions: [live('ses_c', 'pi'), live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked] = thread.messages as [InboxMessageWire, InboxMessageWire];
  const moved = { ...rootMessage, to: { host: 'pi', session: 'ses_c' }, launch: { ...rootMessage.launch!, session_ref: null } } as InboxMessageWire;
  const el = await render({ ...thread, messages: [moved, savedIn(asked, LAUNCHED_ROOT, { host: 'pi', session: 'ses_c' })] }, SAVED_AT, { ...stoppedRun, state: 'missing' });
  expect(!!el.querySelector('[data-run]')).toBe(false);
  expect(!!el.querySelector('[data-readdress-open]')).toBe(false);
});

test.skipIf(!hasDom)('a launched root moved to another session that then ended: that session reads as ended, though the launched agent would start again', async () => {
  liveness = { ses_launched: false, ses_c: false };
  sessions = { sessions: [live('ses_other', 'pi')] };
  const thread = launchedThread(false);
  const [rootMessage, asked] = thread.messages as [InboxMessageWire, InboxMessageWire];
  const moved = { ...rootMessage, to: { host: 'pi', session: 'ses_c' }, launch: { ...rootMessage.launch!, session: 'ses_launched' } } as InboxMessageWire;
  const answered = { ...asked, reply_to: LAUNCHED_ROOT, author: { kind: 'agent', host: 'pi', session: 'ses_c', name: null }, questions: undefined, wakes: true } as InboxMessageWire;
  const el = await render({ ...thread, messages: [moved, answered] }, null, stoppedRun);
  expect(el.querySelector(`[data-message-article="${M1}"] [data-session-ended]`)).not.toBeNull();
});

test.skipIf(!hasDom)('a launched thread, the words going to a tagged agent that ended: the ended note shows, so the reply does not wait on it unsaid', async () => {
  liveness = { ses_launched: true, ses_tagged: false };
  sessions = { sessions: [live('ses_launched', 'claude-code', { wrote_thread: true })] };
  const el = await render(launchedThread(false), null, null);
  expect(el.querySelector(`[data-message-article="${R1}"] [data-session-ended]`)).not.toBeNull();
  expect(el.querySelector('[data-asker-ended]')).not.toBeNull();
});

test.skipIf(!hasDom)("a launched thread: a pick on the stopped launched session's question, the words for a live agent: no ended choice, the answer goes to the launched session, which it starts again", async () => {
  liveness = { ses_launched: false, ses_tagged: true };
  sessions = { sessions: [live('ses_tagged', 'claude-code', { wrote_thread: true })] };
  const el = await render(launchedThread(true), null, stoppedRun);
  act(() => button(el, 'Edit draft').click());
  await settle();
  const text = el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'And keep the logs bucket.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await settle();
  expect(el.querySelector(`[data-message-article="${M1}"] [data-session-ended]`)).toBeNull();
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  expect(pillList(el)).toBeNull();
  expect(replies().map((r) => [r.path.includes(M1) ? 'launched' : 'tagged', r.body.words, r.body.to ?? null])).toEqual([
    ['launched', '', null],
    ['tagged', 'And keep the logs bucket.', null],
  ]);
});

test.skipIf(!hasDom)('a reply no connection wakes, settled by another agent\'s read: the line says who read it; with no record, Delivered', async () => {
  const at = '2026-10-11T18:25:00.000Z';
  const noWake = threadOf({ ...asking(false, false), author: { ...ASKER, host: 'cursor', session: 'cursor-1' } }, personReply());
  const read = await render(noWake, { at: '2026-10-11T10:52:00.000Z', checked_at: at, read_by: 'claude-code' });
  expect(read.querySelector('[data-delivery]')?.textContent).toBe(`Read by Claude Code, ${whenTime(at)}`);
  act(() => root?.unmount());
  host?.remove();
  const old = await render(noWake, { at: '2026-10-11T10:52:00.000Z', checked_at: at });
  expect(old.querySelector('[data-delivery]')?.textContent).toBe(`Delivered to Cursor, ${whenTime(at)}`);
});
