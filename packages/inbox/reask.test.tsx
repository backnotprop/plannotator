/**
 * Re-ask (approval "inbox-reask") as the window draws and sends it: the
 * item at the foot of the "N open questions" list when a question waits
 * (owner, 2026-10-23: no Re-ask button in the foot), one note per session,
 * the note's line and "Asked again" on the old cards while it waits, the
 * button gone while the note waits and right after the agent answered it,
 * and the ended-session choice ("Who should ask again?").
 *
 * The pure rules (reask.ts) run everywhere; the window's parts are
 * DOM-gated: they run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { reaskedIn, reaskNoteSentence, reaskOffered, reaskTargets, reaskTooltip } from './reask';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing', root: '/work/billing', created_at: '2026-10-20T10:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const B: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'pi', session: 'ses_b', name: null };
const M1 = 'msg_01M5DA00000000000000000001';
const M2 = 'msg_01M5DA00000000000000000002';
const M3 = 'msg_01M5DA00000000000000000003';
const NOTE = 'msg_01M5DA00000000000000000004';
const M5 = 'msg_01M5DA00000000000000000005';

const block = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const BODY1 = `Two calls.\n\n${block('Backfill ledger first?')}\n\n${block('Keep the old webhook?')}`;
const BODY2 = `One more.\n\n${block('Move refunds now?')}`;

function questionsOf(messageId: string, body: string, author = A): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
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
    asked_by_agent_id: author.session,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
  }));
}

function agent(id: string, body: string, at: string, author = A, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  const questions = questionsOf(id, body, author);
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Billing migration' : null,
    body,
    created_at: at,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    ...(questions.length > 0 ? { questions } : {}),
    ...extra,
  };
}

function note(ids: string[], replyTo = M2, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id: NOTE,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: replyTo,
    author: { kind: 'person' },
    subject: null,
    body: 'Please ask your 3 open questions in this thread again, together in one new message.',
    created_at: '2026-10-20T10:52:00.000Z',
    resolved_at: null,
    idempotency_key: 'k',
    reask: ids,
    ...extra,
  };
}

function thread(messages: InboxMessageWire[]): InboxThread {
  return { thread_id: M1, project: PROJECT, subject: 'Billing migration', thread_name: null, resolved_at: null, messages };
}

const base = () => [agent(M1, BODY1, '2026-10-20T10:42:00.000Z'), agent(M2, BODY2, '2026-10-20T10:45:00.000Z')];
const openIds = (messages: InboxMessageWire[]) => messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'open').map((q) => `${q.message_id}/${q.key}`));

describe('the rules (reask.ts)', () => {
  test('open action items (in `actions`) are asked again with the questions; one the person marked is left out', () => {
    const todo = (key: string, state: InboxQuestion['state'], marked = false): InboxQuestion =>
      ({
        ...questionsOf(M3, block('x'))[0]!,
        key,
        kind: 'action',
        prompt: `Do ${key}`,
        choices: [],
        state,
        message_id: M3,
        action: { where: null, where_url: null, run: null, watching: null },
        action_result: marked ? { outcome: 'done', note: null, at: '2026-10-20T10:50:00.000Z', by: 'person' } : null,
      }) as InboxQuestion;
    // One question and one open action item: offered, and the tooltip names both.
    const msgs = [agent(M1, `One.\n\n${block('Backfill ledger first?')}`, '2026-10-20T10:42:00.000Z'), agent(M3, 'Approve it.', '2026-10-20T10:46:00.000Z', A, { actions: [todo('a-00000001', 'open'), todo('a-00000002', 'picked', true)] })];
    const [t] = reaskTargets(msgs);
    expect(t).toMatchObject({ kind: 'reask', open: 2, actions: 1, picked: 0 });
    expect(t!.message.id).toBe(M3);
    expect(reaskOffered([t!], msgs)).toBe(true);
    expect(reaskTooltip([t!])).toBe(
      'Ask Claude Code to ask the 1 open question and 1 action item again, together in one message with fresh context. Those that no longer apply are closed; until then they stay open here.',
    );
    // A marked action item waits on nobody: beside one question it adds nothing, and alone there is nothing to offer.
    const marked = [agent(M1, `One.\n\n${block('Backfill ledger first?')}`, '2026-10-20T10:42:00.000Z'), agent(M3, 'Approve it.', '2026-10-20T10:46:00.000Z', A, { actions: [todo('a-00000002', 'picked', true)] })];
    expect(reaskTargets(marked)).toMatchObject([{ kind: 'reask', open: 1, actions: 0, picked: 0 }]);
    expect(reaskOffered(reaskTargets(marked), marked)).toBe(true);
    const markedOnly = [agent(M3, 'Approve it.', '2026-10-20T10:46:00.000Z', A, { actions: [todo('a-00000002', 'picked', true)] })];
    expect(reaskOffered(reaskTargets(markedOnly), markedOnly)).toBe(false);
    // One open action item alone: offered, in the singular.
    const oneTodo = [agent(M3, 'Approve it.', '2026-10-20T10:46:00.000Z', A, { actions: [todo('a-00000001', 'open')] })];
    expect(reaskOffered(reaskTargets(oneTodo), oneTodo)).toBe(true);
    expect(reaskTooltip(reaskTargets(oneTodo))).toBe(
      'Ask Claude Code to ask the open action item again, with fresh context. If it no longer applies, it is closed; until then it stays open here.',
    );
    // The note's line names the action items it asked about.
    expect(reaskNoteSentence('Claude Code', 2, 0, 1)).toBe('You asked Claude Code to ask the 1 open question and 1 action item again, together in one message. They stay open here until it does.');
    expect(reaskNoteSentence('Pi', 1, 0, 1)).toBe('You asked Pi to ask the open action item again. It stays open here until it does.');
  });

  test('one target per session, at its latest message with a question waiting; offered for one or more', () => {
    const one = reaskTargets(base());
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ session: 'ses_a', open: 3, picked: 0, name: 'Claude Code' });
    expect(one[0]!.message.id).toBe(M2);
    expect(reaskOffered(one)).toBe(true);
    // One question waiting (owner, 2026-10-23): offered too, worded in the singular.
    const single = reaskTargets([agent(M2, BODY2, '2026-10-20T10:45:00.000Z')]);
    expect(reaskOffered(single)).toBe(true);
    expect(reaskTooltip(single)).toBe(
      'Ask Claude Code to ask the open question again, with fresh context. If it no longer applies, it is closed; until then it stays open here.',
    );
    // Nothing waiting: nothing to offer.
    expect(reaskOffered(reaskTargets([agent(M2, 'Done with the refunds.', '2026-10-20T10:45:00.000Z')]))).toBe(false);
    const two = reaskTargets([...base(), agent(M3, block('Pin Node?'), '2026-10-20T10:47:00.000Z', B)]);
    expect(two.map((t) => [t.session, t.message.id, t.open])).toEqual([
      ['ses_a', M2, 3],
      ['ses_b', M3, 1],
    ]);
    expect(reaskTooltip(two)).toBe('Ask Claude Code and Pi to ask their 4 open questions again, each together in one message with fresh context. Questions that no longer apply are closed; until then they stay open here.');
  });

  test('picks count as waiting and go with it; a session whose questions are all picked is left out', () => {
    const msgs = base();
    const q = msgs[0]!.questions![0]!;
    msgs[0]!.questions![0] = { ...q, state: 'picked', answer: { v: 1, key: q.key, kind: q.kind as 'single', prompt: q.prompt, selected: ['Yes'] } };
    const [t] = reaskTargets(msgs);
    expect(t).toMatchObject({ open: 2, picked: 1 });
    expect(reaskTooltip([t!])).toContain('Your 1 pick is sent too.');
  });

  test('a session with only picks gets a plain reply carrying them, never stranded (A asks 2, B asks 1, B picked)', () => {
    const msgs = [agent(M1, BODY1, '2026-10-20T10:42:00.000Z'), agent(M3, block('Pin Node?'), '2026-10-20T10:47:00.000Z', B)];
    const qb = msgs[1]!.questions![0]!;
    msgs[1]!.questions![0] = { ...qb, state: 'picked', revision: 1, answer: { v: 1, key: qb.key, kind: qb.kind as 'single', prompt: qb.prompt, selected: ['Yes'] } };
    const targets = reaskTargets(msgs);
    expect(targets.map((t) => [t.kind, t.session, t.open, t.picked])).toEqual([
      ['reask', 'ses_a', 2, 0],
      ['picks', 'ses_b', 0, 1],
    ]);
    expect(targets[1]!.replies).toEqual([{ message: msgs[1], questions: [{ key: qb.key, revision: 1 }] }]);
    expect(reaskOffered(targets)).toBe(true);
    expect(reaskTooltip(targets)).toBe(
      'Ask Claude Code to ask the 2 open questions again, together in one message with fresh context. Questions that no longer apply are closed; until then they stay open here. Your 1 pick is sent too.',
    );
  });

  test('after a note sent to another session (the asker ended): blocked until that session writes, then what it left open can be asked again', () => {
    const msgs = base();
    const redirected = note(openIds(msgs), M2, { to: { host: 'claude-code', session: 'ses_c' } });
    expect(reaskTargets([...msgs, redirected])).toEqual([]);
    // The new session re-asked two and left the third neither replaced nor superseded.
    const old = msgs.map((m) => ({ ...m, questions: m.questions!.map((q) => (q.message_id === M2 ? q : { ...q, state: 'superseded' as const })) }));
    const C: typeof A = { ...A, session: 'ses_c' };
    const answer = agent(M5, `${block('Backfill ledger first?')}\n\n${block('Keep the old webhook?')}`, '2026-10-20T10:55:00.000Z', C, { reply_to: NOTE });
    const thread = [...old, redirected, answer];
    const after = reaskTargets(thread);
    // ses_c just answered the note (left out); ses_a's question it left open can be asked again: 3 wait in the thread.
    expect(after.map((t) => [t.kind, t.session, t.open])).toEqual([['reask', 'ses_a', 1]]);
    expect(reaskOffered(after, thread)).toBe(true);
  });

  test('left out while its note waits, and right after the agent answered it in one message', () => {
    const msgs = base();
    expect(reaskTargets([...msgs, note(openIds(msgs))])).toEqual([]);
    const answered = agent(M5, `${block('Backfill ledger first?')}\n\n${block('Keep the old webhook?')}`, '2026-10-20T10:55:00.000Z', A, { reply_to: NOTE });
    const old = msgs.map((m) => ({ ...m, questions: m.questions!.map((q) => ({ ...q, state: 'superseded' as const })) }));
    expect(reaskTargets([...old, note(openIds(msgs)), answered])).toEqual([]);
  });

  test('rule 2a: a note stops hiding its session once nothing it lists is open, even if that session never wrote', () => {
    const msgs = base();
    const [q1] = openIds(msgs);
    // The note listed only q1 (the others were picked then); someone else superseded q1 since.
    const gone = msgs.map((m) => ({ ...m, questions: m.questions!.map((q) => (`${q.message_id}/${q.key}` === q1 ? { ...q, state: 'superseded' as const } : q)) }));
    expect(reaskTargets([...msgs, note([q1!])]).map((t) => t.session)).toEqual([]);
    expect(reaskTargets([...gone, note([q1!])]).map((t) => [t.session, t.open])).toEqual([['ses_a', 2]]);
  });

  test('a question record that does not name its message (one that arrived while the thread was open) never throws, and the rules read its holder', () => {
    // The shape that blanked the thread: every waiting question in one message, and the
    // question's own `message_id` missing (or naming another message), so no message matched it.
    const strip = (m: InboxMessageWire, to?: string): InboxMessageWire => ({
      ...m,
      questions: m.questions!.map((q) => ({ ...q, message_id: to as unknown as string })),
    });
    const arrived = strip(agent(M2, BODY2, '2026-10-20T10:45:00.000Z'));
    const thread1 = [agent(M1, 'Starting the migration.', '2026-10-20T10:42:00.000Z'), arrived];
    let targets: ReturnType<typeof reaskTargets> = [];
    expect(() => (targets = reaskTargets(thread1))).not.toThrow();
    expect(targets.map((t) => [t.kind, t.message.id, t.open])).toEqual([['reask', M2, 1]]);
    expect(reaskOffered(targets, thread1)).toBe(true);
    // A stale `message_id` (another message's) is read the same way.
    expect(reaskTargets([thread1[0]!, strip(agent(M2, BODY2, '2026-10-20T10:45:00.000Z'), M3)]).map((t) => t.message.id)).toEqual([M2]);
    // Several open in that one message, answering a note: the session just answered it, so it is left out.
    const msgs = base();
    const answered = strip(agent(M5, `${block('Backfill ledger first?')}\n\n${block('Keep the old webhook?')}`, '2026-10-20T10:55:00.000Z', A, { reply_to: NOTE }));
    const old = msgs.map((m) => ({ ...m, questions: m.questions!.map((q) => ({ ...q, state: 'superseded' as const })) }));
    expect(reaskTargets([...old, note(openIds(msgs)), answered])).toEqual([]);
    // "Asked again" reads the holding message's id, not the record's.
    const listed = note([`${M2}/${arrived.questions![0]!.key}`]);
    expect(reaskedIn([...thread1, listed], M2, arrived.questions![0]!)?.id).toBe(NOTE);
    expect(reaskedIn([...thread1, listed], M1, arrived.questions![0]!)).toBeNull();
  });

  test("the note's line", () => {
    expect(reaskNoteSentence('Claude Code', 1, 0)).toBe('You asked Claude Code to ask the open question again. It stays open here until it does.');
    expect(reaskNoteSentence('Claude Code', 3, 0)).toBe('You asked Claude Code to ask the 3 open questions again, together in one message. They stay open here until it does.');
    expect(reaskNoteSentence('Claude Code', 2, 1)).toBe('You asked Claude Code to ask the 2 open questions again, together in one message. They stay open here until it does. Your 1 pick went with it.');
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let sessions: Record<string, unknown> = { sessions: [] };

const live = (session: string, hostName: string) => ({
  session,
  host: hostName,
  started_at: '2026-10-20T10:31:00.000Z',
  last_seen_at: '2026-10-20T10:50:00.000Z',
  busy: false,
  idle_since: '2026-10-20T10:48:00.000Z',
  wrote_thread: false,
});

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  sessions = { sessions: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ reply: {}, questions: [], replayed: false });
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

async function render(t: InboxThread) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={t} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  return host;
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
}

/**
 * Re-ask lives at the foot of the "N open questions" list (owner, 2026-10-23):
 * open the list and answer the item, or null when the list or the item is not there.
 */
async function reaskButton(el: HTMLElement): Promise<HTMLElement | null> {
  expect(el.querySelector('[data-foot-buttons] [data-reask]')).toBeNull();
  const trigger = el.querySelector<HTMLElement>('[data-open-questions]');
  if (!trigger) return null;
  if (trigger.getAttribute('aria-expanded') !== 'true') await press(trigger);
  for (let i = 0; i < 30 && !document.querySelector('[data-open-questions-list]'); i += 1) await settle();
  return document.querySelector<HTMLElement>('[data-open-questions-list] [data-reask]');
}

test.skipIf(!hasDom)('Re-ask sits at the foot of the open-questions list, named by its text, and posts one note to the latest asking message', async () => {
  const el = await render(thread(base()));
  const foot = [...el.querySelectorAll('.ib-pfoot .ib-acts button')].map((b) => b.textContent?.trim());
  expect(foot.slice(0, 2)).toEqual(['Reply', '3 open questions']);
  const button = (await reaskButton(el))!;
  expect(button.getAttribute('role')).toBe('menuitem');
  expect(button.textContent?.trim()).toBe('Re-ask in one new message');
  await act(async () => button.click());
  await settle();
  const reasks = posted.filter((p) => p.path.endsWith('/reask'));
  expect(reasks.map((p) => p.path)).toEqual([`/api/inbox/messages/${M2}/reask`]);
  expect(typeof reasks[0]!.body.idempotency_key).toBe('string');
  expect(reasks[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('two sessions asked: one note each, to each session\'s own message', async () => {
  const el = await render(thread([...base(), agent(M3, block('Pin Node?'), '2026-10-20T10:47:00.000Z', B)]));
  const item = (await reaskButton(el))!;
  await act(async () => item.click());
  await settle();
  expect(posted.filter((p) => p.path.endsWith('/reask')).map((p) => p.path)).toEqual([`/api/inbox/messages/${M2}/reask`, `/api/inbox/messages/${M3}/reask`]);
});

test.skipIf(!hasDom)('while the note waits: no Re-ask, the note reads as one line, and the old cards say they were asked again', async () => {
  const msgs = base();
  const el = await render(thread([...msgs, note(openIds(msgs))]));
  expect(await reaskButton(el)).toBeNull();
  const line = el.querySelector('[data-reask-note] .ib-reask-l')!;
  expect(line.textContent).toBe('You asked Claude Code to ask the 3 open questions again, together in one message. They stay open here until it does.');
  expect(el.querySelector('[data-reask-note] summary')?.textContent).toBe('What Claude Code was sent');
  expect(el.textContent).toContain('Asked again');
});

test.skipIf(!hasDom)('A asks 2, B asks 1 and B is picked: one press sends A its note and B a plain reply with the pick', async () => {
  const msgs = [agent(M1, BODY1, '2026-10-20T10:42:00.000Z'), agent(M3, block('Pin Node?'), '2026-10-20T10:47:00.000Z', B)];
  const qb = msgs[1]!.questions![0]!;
  msgs[1]!.questions![0] = { ...qb, state: 'picked', revision: 1, picked_at: '2026-10-20T10:48:00.000Z', answer: { v: 1, key: qb.key, kind: qb.kind as 'single', prompt: qb.prompt, selected: ['Yes'] } };
  const el = await render(thread(msgs));
  const item = (await reaskButton(el))!;
  await act(async () => item.click());
  await settle();
  expect(posted.map((p) => p.path)).toEqual([`/api/inbox/messages/${M3}/reply`, `/api/inbox/messages/${M1}/reask`]);
  expect(posted[0]!.body).toMatchObject({ words: '', questions: [{ key: qb.key, revision: 1 }] });
  expect(typeof posted[0]!.body.idempotency_key).toBe('string');
});

test.skipIf(!hasDom)('one question waiting, no pick: Re-ask shows and posts the note; the note reads in the singular', async () => {
  const msgs = [agent(M1, block('Move refunds now?'), '2026-10-20T10:45:00.000Z')];
  const el = await render(thread(msgs));
  const button = (await reaskButton(el))!;
  expect(button.textContent?.trim()).toBe('Re-ask in a new message');
  await act(async () => button.click());
  await settle();
  expect(posted.filter((p) => p.path.endsWith('/reask')).map((p) => p.path)).toEqual([`/api/inbox/messages/${M1}/reask`]);
  act(() => root?.unmount());
  host?.remove();
  const after = await render(thread([...msgs, note(openIds(msgs), M1)]));
  expect(await reaskButton(after)).toBeNull();
  expect(after.querySelector('[data-reask-note] .ib-reask-l')?.textContent).toBe('You asked Claude Code to ask the open question again. It stays open here until it does.');
});

test.skipIf(!hasDom)('one question already picked: no Re-ask (Send carries it)', async () => {
  const msgs = [agent(M1, block('Move refunds now?'), '2026-10-20T10:45:00.000Z')];
  const q = msgs[0]!.questions![0]!;
  msgs[0]!.questions![0] = { ...q, state: 'picked', revision: 1, picked_at: '2026-10-20T10:46:00.000Z', answer: { v: 1, key: q.key, kind: q.kind as 'single', prompt: q.prompt, selected: ['Yes'] } };
  const el = await render(thread(msgs));
  expect(el.querySelector('.ib-pfoot')?.textContent).toContain('Send');
  expect(await reaskButton(el)).toBeNull();
});

test.skipIf(!hasDom)('the session that asked has ended: Re-ask opens the choice, and the pick goes as `to`', async () => {
  sessions = { sessions: [live('ses_other', 'claude-code')], asker: { session: 'ses_a', live: false } };
  const el = await render(thread(base()));
  await settle();
  expect(el.querySelector('[data-asker-ended]')?.getAttribute('data-asker-ended')).toBe('live');
  const item = (await reaskButton(el))!;
  await act(async () => item.click());
  await settle();
  const form = el.querySelector('[data-route-choice]') as HTMLElement;
  expect(form.querySelector('legend')?.textContent).toBe('Who should ask again?');
  expect(posted.filter((p) => p.path.endsWith('/reask'))).toHaveLength(0);
  const send = form.querySelector('[data-route-send]') as HTMLButtonElement;
  expect(send.textContent?.trim()).toBe('Ask Claude Code to re-ask');
  await act(async () => send.click());
  await settle();
  const reasks = posted.filter((p) => p.path.endsWith('/reask'));
  expect(reasks).toHaveLength(1);
  expect(reasks[0]!.body.to).toEqual({ host: 'claude-code', session: 'ses_other' });
});
