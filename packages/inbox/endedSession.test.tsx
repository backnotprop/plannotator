/**
 * Replying when the session that asked has ended (design record "replying
 * when the asking agent's session has ended", not in this repo), as the
 * window draws it: the quiet notice before replying, the choice at Send (one
 * radio group, the button naming the result, Esc / Back, the race), Send at
 * once when nothing is live, and the delivered line's "(another session)".
 * The failure this catches: a reply sent to a session that is gone without
 * the person knowing, or sent somewhere they did not pick.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

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

function questions(picked: boolean): InboxQuestion[] {
  return parseInboxQuestionBlocks(BODY).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: null,
    suggested_text: null,
    decision_on_answer: false,
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
    decision_id: null,
    message_id: M1,
    decision_recording: false,
    decision_draft: null,
    superseded_by: null,
  }));
}

function asking(picked = false): InboxMessageWire {
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

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  sessions = { sessions: [], asker: { session: 'ses_asker', live: false } };
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false, decisions_refused: [] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/reply')) return replyAnswer();
      return Response.json({ questions: [] });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, ...sessions });
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
          decisions={[]}
          onOpenDecisionPage={() => {}}
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
const radio = (el: HTMLElement, session: string) => el.querySelector(`[data-route-session="${session}"] input`) as HTMLInputElement;
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

test.skipIf(!hasDom)('ended, live sessions exist: "session ended" on the asking message and the note above the reply, describing the box', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  expect(el.querySelector(`[data-message-article="${M1}"] .ib-to`)?.textContent).toBe('to you · session ended');
  const text = await writeReply(el);
  const note = el.querySelector('[data-asker-ended]') as HTMLElement;
  expect(note.getAttribute('data-asker-ended')).toBe('live');
  expect(note.getAttribute('role')).toBe('status');
  expect(note.textContent).toContain('The Claude Code session that asked has ended.');
  expect(note.textContent).toContain('pick a live session in ledger');
  expect(text.getAttribute('aria-describedby')).toBe(note.id);
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

test.skipIf(!hasDom)('choose: Send asks where the reply goes; the first live row is selected and focused, the button names it; Send to sends `to` that session', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code'), live('ses_pi', 'pi', { busy: true, idle_since: null })], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  const text = await writeReply(el);
  act(() => button(el, 'Send').click());
  await settle();
  expect(replies()).toEqual([]);
  const choice = el.querySelector('[data-route-choice]') as HTMLElement;
  expect(choice.querySelector('legend')?.textContent).toBe('Where should this reply go?');
  expect(choice.textContent).toContain('The Claude Code session that asked has ended. Your reply stays as you wrote it.');
  expect(choice.textContent).toContain('Send to a live session in ledger');
  expect(choice.textContent).toContain('Leave it for the next agent');
  // The reply stays above it, as written.
  expect(text.value).toBe(WORDS);
  expect(radio(el, 'ses_other').checked).toBe(true);
  expect(document.activeElement).toBe(radio(el, 'ses_other'));
  expect((el.querySelector('[data-route-send]') as HTMLElement).textContent).toBe('Send to Claude Code');
  // The label follows the selection.
  act(() => radio(el, 'ses_pi').click());
  expect((el.querySelector('[data-route-send]') as HTMLElement).textContent).toBe('Send to Pi');
  act(() => radio(el, 'leave').click());
  expect((el.querySelector('[data-route-send]') as HTMLElement).textContent).toBe('Leave it for the next agent');
  act(() => radio(el, 'ses_pi').click());
  // Enter on the selected radio submits.
  key(radio(el, 'ses_pi'), { key: 'Enter' });
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body).toMatchObject({ words: WORDS, to: { host: 'pi', session: 'ses_pi' } });
  expect(el.querySelector('[data-route-choice]')).toBeNull();
});

test.skipIf(!hasDom)('keyboard: Esc goes back with the text and focus at its end; Cmd+Enter in the box opens the choice again with the choice kept; Leave sends with no `to`', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking()));
  const text = await writeReply(el);
  key(text, { key: 'Enter', metaKey: true });
  await settle();
  expect(document.activeElement).toBe(radio(el, 'ses_other'));
  act(() => radio(el, 'leave').click());
  key(radio(el, 'leave'), { key: 'Escape' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  const again = el.querySelector('textarea') as HTMLTextAreaElement;
  expect(again.value).toBe(WORDS);
  expect(document.activeElement).toBe(again);
  expect(again.selectionStart).toBe(WORDS.length);

  key(again, { key: 'Enter', ctrlKey: true });
  await settle();
  expect(radio(el, 'leave').checked).toBe(true);
  expect(document.activeElement).toBe(radio(el, 'leave'));
  // Back to the reply does the same as Esc.
  act(() => button(el, 'Back to the reply').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).toBeNull();
  act(() => button(el, 'Send').click());
  await settle();
  act(() => (el.querySelector('[data-route-send]') as HTMLButtonElement).click());
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('the race: the chosen session ended before the reply went; nothing sent, the row greys, the next is selected and focused, the error says so', async () => {
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
  act(() => (el.querySelector('[data-route-send]') as HTMLButtonElement).click());
  await settle();
  await settle();
  const row = el.querySelector('[data-route-session="ses_other"]') as HTMLElement;
  expect(row.hasAttribute('data-ended')).toBe(true);
  expect(radio(el, 'ses_other').disabled).toBe(true);
  expect(row.textContent).toContain('Ended just now.');
  expect(radio(el, 'ses_pi').checked).toBe(true);
  expect(document.activeElement).toBe(radio(el, 'ses_pi'));
  expect(el.querySelector('.ib-route-error')?.textContent).toBe('That Claude Code session ended before your reply went. Nothing was sent. Pi is selected now.');
  expect((el.querySelector('[data-route-send]') as HTMLElement).textContent).toBe('Send to Pi');
});

test.skipIf(!hasDom)('picks with no text: the same choice from the foot, and Back returns focus to Send', async () => {
  sessions = { sessions: [live('ses_pi', 'pi')], asker: { session: 'ses_asker', live: false } };
  const el = await render(threadOf(asking(true)));
  expect(el.querySelector('[data-asker-ended]')?.getAttribute('data-asker-ended')).toBe('live');
  act(() => button(el, 'Send').click());
  await settle();
  expect(el.querySelector('[data-route-choice]')).not.toBeNull();
  expect(replies()).toEqual([]);
  act(() => button(el, 'Back to the reply').click());
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  expect(document.activeElement?.textContent).toBe('Send');
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
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
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
