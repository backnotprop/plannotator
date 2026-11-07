/**
 * Who gets the reply (approval "inbox-reply-recipient", option E): in a thread
 * with more than one agent, a pill under the reply box names the recipient;
 * its list switches it, adds a second one ("2 agents"), and the Reply arrow on
 * an older message aims it. The failure this catches: a reply that goes to
 * another agent than the one the pill names, a pill that moves when an agent
 * writes, or a one-agent thread that grows new UI.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'superfans-abcdef', name: 'superfans', root: '/work/superfans', created_at: '2026-11-01T10:00:00.000Z' };
const FAR = { id: 'prj_2', name: 'plannotator', root: '/work/plannotator' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
const GONE = { kind: 'agent' as const, host: 'codex', session: 'ses_gone', name: null };
const FARCLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_far', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';
const M3 = 'msg_01M4H7BBBBBBBBBBBBBBBBBBBB';
const M4 = 'msg_01M4H7CCCCCCCCCCCCCCCCCCCC';

function agentMessage(id: string, author: InboxMessageWire['author'], minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Accounts and usage' : null,
    body: `Message ${id.slice(-4)}.`,
    created_at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    ...extra,
  };
}

const QUESTION_BODY = ['Which totals?', '', ':::question', 'Which totals should the report use?', '', '- [ ] The old totals', '- [ ] The new totals', ':::'].join('\n');

/** The question of QUESTION_BODY on `messageId`, Claude Code's, picked and not sent yet. */
function pickedQuestion(messageId: string): InboxQuestion[] {
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
    asked_by_agent_id: 'ses_claude',
    orphaned: false,
    state: 'picked',
    answer: { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: ['The old totals'] },
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: '2026-11-01T10:42:00.000Z',
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
  }));
}

const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Accounts and usage', thread_name: null, resolved_at: null, messages });

function tagged(session: string, host: string, project: { id: string; name: string; root: string } = PROJECT): TaggableSession {
  return { session, host, kind: 'live', name: null, project, started_at: null, last_at: '2026-11-01T10:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let taggable: TaggableSession[] = [];
/** The draft the thread opens with (a reload's), or null. */
let savedDraft: Record<string, unknown> | null = null;
/** The live sessions the `@` model and the live list leave out (both read them as ended); a reply `to` one is the server's 409. */
let notLive = new Set<string>();
/** Sessions the sessions route's `?asker=` answers as ended. */
let askerGone = new Set<string>();
/** A reply `to` one of these is refused for now (429), nothing written: Send may be pressed again. */
let brokenTo = new Set<string>();

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  savedDraft = null;
  notLive = new Set();
  askerGone = new Set();
  brokenTo = new Set();
  taggable = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi'), tagged('ses_far', 'claude-code', FAR)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { thread_id: M1, body: body.body, updated_at: new Date(Date.now() + posted.length).toISOString(), ...(body.recipients ? { recipients: body.recipients } : {}) } });
      const to = body.to as { session?: string } | undefined;
      if (path.endsWith('/reply') && to?.session && notLive.has(to.session)) {
        return Response.json({ error: 'That session is not live any more: the reply was not sent.', code: 'session_not_live' }, { status: 409 });
      }
      if (path.endsWith('/reply') && to?.session && brokenTo.has(to.session)) {
        return Response.json({ error: 'Too many replies at once; try again.', code: 'rate_limited' }, { status: 429 });
      }
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: savedDraft });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: taggable });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      const sessions = taggable.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions, ...(asked ? { asker: { session: asked, live: !askerGone.has(asked) } } : {}) });
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

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function draw(thread: InboxThread, phone = false) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />
    </div>,
  );
}

async function render(thread: InboxThread, phone = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(thread, phone);
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

async function write(el: HTMLElement, words: string) {
  if (!el.querySelector('textarea')) {
    act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Reply').click());
    await settle();
  }
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  return text;
}

const pill = (el: HTMLElement) => el.querySelector('[data-recipient]') as HTMLButtonElement | null;
const pillName = (el: HTMLElement) => pill(el)?.querySelector('.ib-rto-full')?.textContent ?? null;
const rows = (el: HTMLElement) => [...el.querySelectorAll('[data-recipient-row]')].map((r) => [r.querySelector('.ib-rpick-l')?.textContent, r.querySelector('.ib-rpick-q')?.textContent ?? null]);
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const drafts = () => posted.filter((p) => p.path.endsWith('/draft'));
async function openList(el: HTMLElement) {
  act(() => pill(el)!.click());
  await settle();
}
async function only(el: HTMLElement, session: string) {
  act(() => (el.querySelector(`[data-recipient-row="${session}"] .ib-rpick-name`) as HTMLButtonElement).click());
  await settle();
}
async function send(el: HTMLElement) {
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
}

test.skipIf(!hasDom)('one agent: nothing new, no pill and no label above the box; a computer saves silently, and the bin sits in Send\'s row', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, CLAUDE, 45)));
  const text = await write(el, 'Ship it.');
  await settle(1100);
  expect(pill(el)).toBeNull();
  expect(text.getAttribute('aria-label')).toBe('Reply to Claude Code');
  const leaves = [...el.querySelectorAll('.ib-pfoot *')].filter((n) => n.children.length === 0).map((n) => n.textContent ?? '');
  expect(leaves.some((t) => t.startsWith('Reply to'))).toBe(false);
  // The draft saved (below), and nothing says so in the box; Discard is the bin in Send's row (approval "inbox-reply-box", T6).
  expect(el.querySelector('[data-draft-stamp]')).toBeNull();
  expect(el.querySelector('[data-reply-row] [data-reply-discard]')?.getAttribute('aria-label')).toBe('Discard draft');
  // The one-agent draft names no recipient.
  expect(drafts().at(-1)!.body.recipients).toBeUndefined();
});

test.skipIf(!hasDom)('on a phone the Draft line is nothing before the first save, then sits above the box, outside Send\'s row', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, CLAUDE, 45)), true);
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Reply').click());
  await settle();
  const above = el.querySelector('[data-draft-above]');
  expect(above).not.toBeNull();
  expect(above!.childNodes.length).toBe(0);
  expect(el.querySelector('[data-draft-stamp]')).toBeNull();
  await write(el, 'Ship it.');
  await settle(1100);
  // One line, above the box: none in Send's row.
  expect(el.querySelectorAll('[data-draft-stamp]').length).toBe(1);
  expect(el.querySelector('[data-reply-row] [data-draft-stamp]')).toBeNull();
  expect(above!.querySelector('[data-draft-stamp] [data-draft-discard]')).not.toBeNull();
  const box = el.querySelector('.ib-rbox')!;
  expect(above!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test.skipIf(!hasDom)('two agents: the pill names the last writer; a name picked, Send answers that agent\'s own latest message alone, and the draft keeps the choice', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, PI, 45)));
  await write(el, 'Use the old totals.');
  expect(pillName(el)).toBe('Pi');
  await openList(el);
  expect(rows(el)).toEqual([
    ['Claude Code', null],
    ['Pi', null],
  ]);
  await only(el, 'ses_claude');
  expect(pillName(el)).toBe('Claude Code');
  expect(el.querySelector('[data-recipient-list]')).toBeNull();
  // The words are saved with the choice (the server keeps it, approval server item 1).
  await settle(1100);
  expect(drafts().at(-1)!.body).toMatchObject({ body: 'Use the old totals.', recipients: ['ses_claude'] });
  expect((el.querySelector('textarea') as HTMLTextAreaElement).getAttribute('aria-label')).toBe('Reply to Claude Code');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
  expect(replies()[0]!.body).toMatchObject({ words: 'Use the old totals.' });
  expect(replies()[0]!.body.to).toBeUndefined();
  expect(replies()[0]!.body.tags).toBeUndefined();
});

test.skipIf(!hasDom)('a circle adds a second agent: "2 agents", and the reply to the first carries the second as a tag; an ended agent\'s circle is off', async () => {
  const el = await render(threadOf(agentMessage(M1, GONE, 39), agentMessage(M2, CLAUDE, 41), agentMessage(M3, PI, 45)));
  await write(el, 'Both of you, please.');
  await openList(el);
  // Live first, the ended agent last.
  expect(rows(el)).toEqual([
    ['Claude Code', null],
    ['Pi', null],
    ['Codex', 'ended'],
  ]);
  expect((el.querySelector('[data-recipient-tick="ses_gone"]') as HTMLButtonElement).disabled).toBe(true);
  act(() => (el.querySelector('[data-recipient-tick="ses_claude"]') as HTMLButtonElement).click());
  await settle();
  expect(pill(el)?.querySelector('.ib-rto-full')?.textContent).toBe('2 agents');
  expect(el.querySelector('[data-recipient-tick="ses_claude"]')?.getAttribute('aria-checked')).toBe('true');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M3}/reply`]);
  expect(replies()[0]!.body.tags).toEqual([expect.objectContaining({ host: 'claude-code', session: 'ses_claude' })]);
});

test.skipIf(!hasDom)('the Reply arrow on an older message aims the pill at its agent and keeps the words; a new message does not move it', async () => {
  const thread = threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, PI, 45));
  const el = await render(thread);
  const text = await write(el, 'About your first point.');
  expect(pillName(el)).toBe('Pi');
  const arrow = el.querySelector(`[data-message-article="${M1}"] button[aria-label="Reply"]`) as HTMLButtonElement;
  act(() => arrow.click());
  await settle();
  expect(pillName(el)).toBe('Claude Code');
  expect(text.value).toBe('About your first point.');
  // Pi writes again: the reply still goes to Claude Code.
  act(() => draw({ ...thread, messages: [...thread.messages, agentMessage(M3, PI, 47)] }));
  await settle();
  expect(pillName(el)).toBe('Claude Code');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
});

test.skipIf(!hasDom)('an agent from another folder: its head reads "in plannotator", and the pill and list name each Claude Code by its folder', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M4, FARCLAUDE, 45, { from_project: { name: FAR.name, root: FAR.root } })));
  expect(el.querySelector(`[data-message-article="${M4}"] .ib-fl-in bdi`)?.textContent).toBe('plannotator');
  expect(el.querySelector(`[data-message-article="${M1}"] .ib-fl-in bdi`)?.textContent).toBe('superfans');
  await write(el, 'Which folder?');
  expect(pillName(el)).toBe('Claude Code (plannotator)');
  await openList(el);
  expect(rows(el)).toEqual([
    ['Claude Code (superfans)', null],
    ['Claude Code (plannotator)', null],
  ]);
});

test.skipIf(!hasDom)('Send to an agent that ended opens the list once; pressed again, the reply goes to it and waits', async () => {
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, GONE, 45)));
  await write(el, 'Are you there?');
  expect(pill(el)?.hasAttribute('data-ended')).toBe(true);
  await send(el);
  expect(replies()).toEqual([]);
  expect(el.querySelector('[data-recipient-list]')).not.toBeNull();
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M2}/reply`]);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('the only live agent is on an older Plannotator (it can\'t be tagged, but it takes a reply): Send to the ended agent still opens the list first', async () => {
  taggable = taggable.map((t) => (t.session === 'ses_claude' ? { ...t, taggable: false } : t));
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, GONE, 45)));
  await write(el, 'Are you there?');
  await send(el);
  expect(replies()).toEqual([]);
  expect(el.querySelector('[data-recipient-list]')).not.toBeNull();
  expect(nameRow(el, 'ses_claude').disabled).toBe(false);
});

/** The person's reply that tagged Codex (`ses_gone`): Codex is in the thread, but never wrote in it. */
const TAGGED_GONE = (): InboxMessageWire => ({
  ...agentMessage(M2, { kind: 'person' } as InboxMessageWire['author'], 43, { wakes: undefined }),
  tags: [{ host: 'codex', session: 'ses_gone', wakes: true }],
});
const sentTo = () => replies().map((r) => (r.body.to as { session?: string } | undefined)?.session ?? null);
const tagSessions = () => replies().flatMap((r) => ((r.body.tags as { session: string }[] | undefined) ?? []).map((t) => t.session));

const nameRow = (el: HTMLElement, session: string) => el.querySelector(`[data-recipient-row="${session}"] .ib-rpick-name`) as HTMLButtonElement;
const tick = (el: HTMLElement, session: string) => el.querySelector(`[data-recipient-tick="${session}"]`) as HTMLButtonElement;
async function tap(button: HTMLButtonElement) {
  act(() => button.click());
  await settle();
}
/** The person's reply that tagged Cursor, an agent that reads the Inbox (MCP): in the thread, never wrote in it. */
const TAGGED_READER = (): InboxMessageWire => ({ ...TAGGED_GONE(), tags: [{ host: 'cursor', session: 'ses_cursor', wakes: false }] });
const reader = (): TaggableSession => ({ ...tagged('ses_cursor', 'cursor'), kind: 'mcp' });

test.skipIf(!hasDom)('a tagged agent that ended and never wrote here can\'t be picked alone (no reply could reach it): its name and circle are off, and the reply stays with the agent that wrote', async () => {
  notLive = new Set(['ses_gone']);
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), TAGGED_GONE()));
  await write(el, 'Codex, are you there?');
  await openList(el);
  expect(rows(el)).toEqual([
    ['Claude Code', null],
    ['Codex', 'ended'],
  ]);
  expect(nameRow(el, 'ses_gone').disabled).toBe(true);
  expect(tick(el, 'ses_gone').disabled).toBe(true);
  expect(nameRow(el, 'ses_claude').disabled).toBe(false);
  await tap(nameRow(el, 'ses_gone'));
  expect(pillName(el)).toBe('Claude Code');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
  expect(sentTo()).toEqual([null]);
  expect(tagSessions()).toEqual([]);
});

test.skipIf(!hasDom)('a tagged agent that only reads the Inbox can\'t be picked alone, but its circle tags it; taking away the agent that wrote leaves the reader second, never first', async () => {
  taggable = [...taggable, reader()];
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), TAGGED_READER()));
  await write(el, 'Cursor, read this too.');
  await openList(el);
  expect(rows(el)).toEqual([
    ['Claude Code', null],
    ['Cursor', 'Not woken'],
  ]);
  expect(nameRow(el, 'ses_cursor').disabled).toBe(true);
  expect(tick(el, 'ses_cursor').disabled).toBe(false);
  await tap(tick(el, 'ses_cursor'));
  expect(pillName(el)).toBe('2 agents');
  // Claude Code's circle off: Cursor would be left alone, so nothing changes.
  await tap(tick(el, 'ses_claude'));
  expect(pillName(el)).toBe('2 agents');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
  expect(sentTo()).toEqual([null]);
  expect(tagSessions()).toEqual(['ses_cursor']);
  expect(el.querySelector('.ib-error[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)('a restored draft led by an agent that can\'t take the reply alone falls back to the agent that wrote, and the pill says so; an unknown session is dropped', async () => {
  savedDraft = { v: 1, thread_id: M1, body: 'Still on the migration?', created_at: '2026-11-01T10:46:00.000Z', updated_at: '2026-11-01T10:46:00.000Z', recipients: ['ses_unknown', 'ses_gone'] };
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), TAGGED_GONE()));
  // The draft's box is open, with its words.
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Still on the migration?');
  expect(pillName(el)).toBe('Claude Code');
  await send(el);
  expect(replies().map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`]);
  expect(sentTo()).toEqual([null]);
  expect(tagSessions()).toEqual([]);
});

test.skipIf(!hasDom)('a tagged live agent that ends as the words go: the refusal says so once, and pressed again nothing is posted (its row can\'t be picked alone now)', async () => {
  const piTagged: InboxMessageWire = { ...TAGGED_GONE(), tags: [{ host: 'pi', session: 'ses_pi', wakes: true }] };
  const el = await render(threadOf(agentMessage(M1, CLAUDE, 41), piTagged));
  const text = await write(el, 'Pi, take this one.');
  await openList(el);
  await only(el, 'ses_pi');
  expect(pillName(el)).toBe('Pi');
  notLive = new Set(['ses_pi']);
  await send(el);
  expect(replies().map((r) => r.body.to)).toEqual([{ host: 'pi', session: 'ses_pi' }]);
  expect(el.querySelector('.ib-error[role="alert"]')?.textContent).toBe('That Pi session ended before your reply went. Nothing was sent.');
  expect(nameRow(el, 'ses_pi').disabled).toBe(true);
  await send(el);
  await send(el);
  expect(replies()).toHaveLength(1);
  expect(el.querySelector('[data-recipient-list]')).not.toBeNull();
  expect(text.value).toBe('Pi, take this one.');
});

test.skipIf(!hasDom)('aimed at a tagged live agent while answering the writer\'s own question: the answers go to the writer with no words, the words to the picked agent alone, and a retry sends neither twice', async () => {
  const asked = agentMessage(M1, CLAUDE, 41, { body: QUESTION_BODY, questions: pickedQuestion(M1) });
  const piTagged: InboxMessageWire = { ...TAGGED_GONE(), tags: [{ host: 'pi', session: 'ses_pi', wakes: true }] };
  const el = await render(threadOf(asked, piTagged));
  // The pick waits as a draft: the foot opens the box with Edit draft.
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Edit draft').click());
  await settle();
  await write(el, 'Pi, take the totals from here.');
  await openList(el);
  await only(el, 'ses_pi');
  expect(pillName(el)).toBe('Pi');
  // The words' POST is refused for now: the answers already went to Claude Code.
  brokenTo = new Set(['ses_pi']);
  await send(el);
  const firstTry = replies();
  expect(firstTry.map((r) => r.path)).toEqual([`/api/inbox/messages/${M1}/reply`, `/api/inbox/messages/${M1}/reply`]);
  const [answers, words] = firstTry;
  expect(answers!.body.words).toBe('');
  expect((answers!.body.questions as unknown[]).length).toBe(1);
  expect(answers!.body.to).toBeUndefined();
  expect(answers!.body.tags).toBeUndefined();
  expect(words!.body).toMatchObject({ words: 'Pi, take the totals from here.', questions: [], to: { host: 'pi', session: 'ses_pi' } });
  expect(words!.body.tags).toBeUndefined();
  expect(words!.body.idempotency_key).not.toBe(answers!.body.idempotency_key);
  // Pressed again: each half keeps its key, so the server replays the answers and the words go once.
  brokenTo = new Set();
  posted = [];
  await send(el);
  const retry = replies();
  expect(retry.map((r) => r.body.idempotency_key)).toEqual([answers!.body.idempotency_key, words!.body.idempotency_key]);
  expect(retry.filter((r) => r.body.words !== '').map((r) => (r.body.to as { session: string }).session)).toEqual(['ses_pi']);
});

test.skipIf(!hasDom)('aimed at a tagged live agent while answering the questions of an asker that ended: both go to the picked agent, so one reply carries them', async () => {
  taggable = taggable.filter((t) => t.session !== 'ses_claude');
  askerGone = new Set(['ses_claude']);
  notLive = new Set(['ses_claude']);
  const asked = agentMessage(M1, CLAUDE, 41, { body: QUESTION_BODY, questions: pickedQuestion(M1) });
  const piTagged: InboxMessageWire = { ...TAGGED_GONE(), tags: [{ host: 'pi', session: 'ses_pi', wakes: true }] };
  const el = await render(threadOf(asked, piTagged));
  act(() => button(el.querySelector('.ib-pfoot') as HTMLElement, 'Edit draft').click());
  await settle();
  await write(el, 'Pi, take the totals from here.');
  await openList(el);
  await only(el, 'ses_pi');
  expect(pillName(el)).toBe('Pi');
  await send(el);
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.path).toBe(`/api/inbox/messages/${M1}/reply`);
  expect(replies()[0]!.body).toMatchObject({ words: 'Pi, take the totals from here.', to: { host: 'pi', session: 'ses_pi' } });
  expect((replies()[0]!.body.questions as unknown[]).length).toBe(1);
});

/** Types into the box as a person does (the `@` list reads the caret). */
async function typeBox(text: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, value);
    text.selectionStart = text.selectionEnd = value.length;
    text.dispatchEvent(new Event('input', { bubbles: true }));
    text.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
  await settle(10);
}
async function key(target: HTMLElement, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle(10);
}
/** Tags one agent with `@` from the box's list, as typed. */
async function tagWith(text: HTMLTextAreaElement, typed: string) {
  await typeBox(text, `${text.value}@${typed}`);
  for (let i = 0; i < 40 && !document.querySelector('[data-tag-picker]'); i++) await settle(25);
  expect(document.querySelector('[data-tag-picker]')).not.toBeNull();
  await key(text, 'ArrowDown');
  await key(text, 'Enter');
  await typeBox(text, `${text.value} `);
}

test.skipIf(!hasDom)('agents tagged with `@` count toward the nine: with two typed, the seventh circle is off and a Send carries eight tags at most', async () => {
  const writers = Array.from({ length: 8 }, (_, i) => `ses_c${i + 1}`);
  taggable = [...writers.map((s) => tagged(s, 'claude-code')), tagged('ses_pi', 'pi'), tagged('ses_codex', 'codex')];
  const ids = [M1, M2, M3, M4, 'msg_01M4H7DDDDDDDDDDDDDDDDDDDD', 'msg_01M4H7EEEEEEEEEEEEEEEEEEEE', 'msg_01M4H7FFFFFFFFFFFFFFFFFFFF', 'msg_01M4H7GGGGGGGGGGGGGGGGGGGG'];
  const el = await render(threadOf(...writers.map((s, i) => agentMessage(ids[i]!, { ...CLAUDE, session: s }, 30 + i))));
  const text = await write(el, 'All hands. ');
  await tagWith(text, 'pi');
  await tagWith(text, 'codex');
  // The last writer and the two typed.
  expect(pillName(el)).toBe('3 agents');
  await openList(el);
  for (const s of writers.slice(0, 6)) await tap(tick(el, s));
  expect(pillName(el)).toBe('9 agents');
  expect(tick(el, 'ses_c7').disabled).toBe(true);
  await send(el);
  expect(replies()).toHaveLength(1);
  const tags = (replies()[0]!.body.tags as { session: string }[]).map((t) => t.session);
  expect(tags.length).toBe(8);
  expect(new Set(tags)).toEqual(new Set([...writers.slice(0, 6), 'ses_pi', 'ses_codex']));
});
