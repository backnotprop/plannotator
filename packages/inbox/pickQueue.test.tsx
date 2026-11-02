/**
 * A question card saves on every change, so a dictated "Other" answer changes
 * faster than it saves (the owner's debug log, 2026-11-02: 81 saves in a line,
 * a Send 7.2 s behind them, on a phone over a tailnet). While a save runs, each
 * question keeps only its newest answer waiting; a Send saves what the field
 * shows before its reply leaves, within a bound. The rule: no answer the person
 * typed is lost or sent stale. A reply names its questions by revision and the
 * server sends what is saved, so the fake server's saved answer at the moment
 * of the reply is what the Send carried.
 *
 * The queue's own rules run everywhere; the window's parts are DOM-gated: they
 * run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxToastModel } from './components/Toast';
import { createPickQueue } from './pickQueue';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_q', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-11-01T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01KPICKQUEUE00000000000001';
const ASK = [
  'Two choices.',
  '',
  ':::question',
  'Where should the retry live?',
  '',
  '- [ ] Pin it',
  '- [ ] Loosen it',
  ':::',
  '',
  ':::question',
  'How long should it wait?',
  '',
  '- [ ] One minute',
  '- [ ] Ten minutes',
  ':::',
].join('\n');

interface Saved {
  answer: QuestionAnswer | null;
  revision: number;
  superseded: boolean;
  sent: boolean;
}
interface PickPost {
  key: string;
  revision: number;
  answer: QuestionAnswer | null;
}
interface ReplyPost {
  questions: { message_id?: string; key: string; revision: number }[];
  /** What the server held for each question when the reply came: what the agent gets. */
  saved: Record<string, string | undefined>;
}

const parsed = parseInboxQuestionBlocks(ASK);
const [FIRST, SECOND] = [parsed[0]!.key, parsed[1]!.key];

/** The fake Inbox: what it saved, what it was asked, in order, and the gates a test holds saves at. */
let saved: Map<string, Saved>;
let log: ('pick' | 'reply' | 'reask')[];
let picks: PickPost[];
let replies: ReplyPost[];
let attachmentReads: number;
let toasts: Omit<InboxToastModel, 'id'>[];
/** Set: each save waits here until the test releases it, the POST already seen. */
let gate: (() => void)[] | null;
/** Each save takes this long. */
let saveMs: number;
/** What the next saves answer instead of saving, one per save. */
let refusals: { status: number; code: string; error: string }[];
/** Set: reading the thread again waits here. */
let changed: Promise<void> | null;
/** Set: reading the thread again brings nothing, as a read that failed on a bad network. */
let rereadFails: boolean;

const FULL = { status: 500, code: 'error', error: 'The disk is full.' };

function wire(): InboxQuestion[] {
  return parsed.map((q) => {
    const held = saved.get(q.key)!;
    return {
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
      asked_by_agent_id: AGENT.session,
      orphaned: false,
      state: held.superseded ? 'superseded' : held.sent ? 'sent' : held.answer ? 'picked' : 'open',
      answer: held.answer,
      revision: held.revision,
      sent_revision: held.sent ? held.revision : 0,
      picked_by: held.answer ? { kind: 'person' } : null,
      picked_at: held.answer ? '2026-11-01T10:20:00.000Z' : null,
      sent_reply_id: held.sent ? 'msg_reply' : null,
      message_id: M1,
      superseded_by: held.superseded ? { message_id: M1, key: null } : null,
    } as InboxQuestion;
  });
}

function threadNow(): InboxThread {
  const message: InboxMessageWire = {
    id: M1,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: null,
    author: AGENT,
    subject: 'Retry',
    body: ASK,
    created_at: '2026-11-01T10:15:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    seq: 1,
    questions: wire(),
  };
  return { thread_id: M1, project: { ...PROJECT }, subject: 'Retry', thread_name: null, resolved_at: null, messages: [message] };
}

const held = () => Object.fromEntries([...saved].map(([key, q]) => [key, q.answer?.other ?? q.answer?.selected[0]]));

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  saved = new Map(parsed.map((q) => [q.key, { answer: null, revision: 3, superseded: false, sent: false }]));
  log = [];
  picks = [];
  replies = [];
  attachmentReads = 0;
  toasts = [];
  gate = null;
  saveMs = 0;
  refusals = [];
  changed = null;
  rereadFails = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/picks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { questions: PickPost[]; unsent_only?: boolean };
      const entry = body.questions[0]!;
      picks.push(entry);
      log.push('pick');
      const waiting = gate;
      if (waiting) await new Promise<void>((resolve) => waiting.push(resolve));
      else if (saveMs > 0) await new Promise((resolve) => setTimeout(resolve, saveMs));
      const refusal = refusals.shift();
      if (refusal) return Response.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
      const question = saved.get(entry.key)!;
      if (question.superseded) return Response.json({ error: 'Replaced.', code: 'question_superseded' }, { status: 422 });
      // As the store does: a stale revision is refused, so a test that passes sent the right one.
      if (question.revision !== entry.revision) return Response.json({ error: 'That question changed since you read it.', code: 'question_revision_conflict' }, { status: 409 });
      if (body.unsent_only === true && question.sent) return Response.json({ error: 'Already sent.', code: 'question_already_sent' }, { status: 409 });
      saved.set(entry.key, { ...question, answer: entry.answer, revision: question.revision + 1, sent: false });
      return Response.json({ message_id: M1, questions: wire(), reply: null });
    }
    if (path.endsWith('/reply') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { questions: ReplyPost['questions'] };
      log.push('reply');
      replies.push({ questions: body.questions, saved: held() });
      for (const q of body.questions) {
        const question = saved.get(q.key)!;
        if (question.superseded) return Response.json({ error: 'Replaced.', code: 'question_superseded' }, { status: 422 });
        if (question.revision !== q.revision) return Response.json({ error: 'That question changed since you read it.', code: 'question_revision_conflict' }, { status: 409 });
      }
      for (const q of body.questions) saved.set(q.key, { ...saved.get(q.key)!, sent: true });
      return Response.json({ reply: { id: 'msg_reply', thread_id: M1, author: { kind: 'person' } }, questions: wire(), replayed: false });
    }
    if (path.endsWith('/reask') && init?.method === 'POST') {
      log.push('reask');
      return Response.json({ message: { id: 'msg_note', thread_id: M1 } });
    }
    if (path.includes('/attachments')) {
      attachmentReads += 1;
      return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    }
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The pane as App holds it: a save's questions go into the thread, a read takes it whole. */
function Pane() {
  const [thread, setThread] = useState(threadNow);
  return (
    <ThreadPane
      thread={thread}
      sent={null}
      onQuestions={(messageId, questions) =>
        setThread((current) => ({ ...current, messages: current.messages.map((m) => (m.id === messageId ? { ...m, questions } : m)) }))
      }
      onChanged={async () => {
        await changed;
        if (!rereadFails) setThread(threadNow());
      }}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
      onToast={(toast) => {
        toasts.push(toast);
      }}
    />
  );
}

async function render() {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Pane />);
  });
  await settle();
  return host;
}

const otherField = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label="Other answer to question 1"]')!;

/** One step of a keyboard or a phone's dictation in the first question's "Other…" field. */
function type(el: HTMLElement, words: string) {
  const field = otherField(el);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const sendButton = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Send') ?? null;

async function press(el: HTMLElement) {
  await until(() => sendButton(el) !== null && !sendButton(el)!.disabled, 'the Send');
  await act(async () => sendButton(el)!.click());
}

const option = (el: HTMLElement, words: string) =>
  [...el.querySelectorAll<HTMLElement>('[data-question-option]')].find((row) => row.textContent?.includes(words))!.querySelector<HTMLInputElement>('input')!;

/** Lets the save the test holds go on. */
async function release() {
  const resolve = gate!.shift();
  if (!resolve) throw new Error('no save is held');
  await act(async () => resolve());
}

/** The first answer saved, and the Send drawn: the state a person dictating is in. */
async function answered(el: HTMLElement, words = 'p') {
  type(el, words);
  await until(() => saved.get(FIRST)!.answer?.other === words, 'the first answer saved');
  await until(() => sendButton(el) !== null, 'the Send');
}

test.skipIf(!hasDom)('80 changes behind a slow save: one POST for the lot, and the Send goes right after it with the final answer', async () => {
  const el = await render();
  await answered(el);
  gate = [];
  type(el, 'pi');
  await until(() => picks.length === 2, 'the save in flight');
  const steps = Array.from({ length: 80 }, (_, i) => `pin the retry ${i}`);
  for (const step of steps) type(el, step);
  const final = steps.at(-1)!;
  await settle();
  // The save in flight stays alone: no step of the 80 went behind it, and none is on its way.
  expect(picks).toHaveLength(2);

  await press(el);
  await settle(5);
  expect(replies).toHaveLength(0);

  // The save in flight answers: the newest answer goes, with the revision that save made.
  await release();
  await until(() => picks.length === 3, 'the newest answer');
  expect(picks[2]!.answer?.other).toBe(final);
  expect(picks[2]!.revision).toBe(5);
  await settle(5);
  expect(replies).toHaveLength(0);

  await release();
  await until(() => replies.length === 1, 'the reply');
  expect(log).toEqual(['pick', 'pick', 'pick', 'reply']);
  expect(replies[0]!.saved[FIRST]).toBe(final);
  expect(replies[0]!.questions.map((q) => [q.key, q.revision])).toEqual([[FIRST, 6]]);
});

test.skipIf(!hasDom)('a question changing 80 times against a slow server: far fewer POSTs, the last with the final text', async () => {
  const el = await render();
  saveMs = 60;
  const steps = Array.from({ length: 80 }, (_, i) => `answer ${i}`);
  for (const step of steps) {
    type(el, step);
    await settle(1);
  }
  const final = steps.at(-1)!;
  await until(() => saved.get(FIRST)!.answer?.other === final, 'the final answer saved');
  await settle(70);
  expect(picks.length).toBeLessThan(20);
  expect(picks.at(-1)!.answer?.other).toBe(final);
  // Each one went with the revision the one before made.
  expect(picks.map((pick) => pick.revision)).toEqual(picks.map((_, i) => 3 + i));
  expect(otherField(el).value).toBe(final);
});

test.skipIf(!hasDom)('the last key and the Send in one tick, nothing saving: the reply carries that key', async () => {
  const el = await render();
  await answered(el, 'almost');
  saveMs = 5;
  type(el, 'almost there');
  await act(async () => sendButton(el)!.click());
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved[FIRST]).toBe('almost there');
  expect(log).toEqual(['pick', 'pick', 'reply']);
});

test.skipIf(!hasDom)('two questions answered behind a slow save: both save, each once, and the Send carries both', async () => {
  const el = await render();
  await act(async () => option(el, 'One minute').click());
  await until(() => saved.get(SECOND)!.answer !== null, 'the second question saved');
  gate = [];
  type(el, 'first');
  await until(() => picks.length === 2, 'the save in flight');
  // Behind it: the other question, then the first one again. The other's place in the line holds.
  await act(async () => option(el, 'Ten minutes').click());
  type(el, 'first answer');
  type(el, 'first answer, final');
  await press(el);

  await release();
  await until(() => picks.length === 3, 'the next save');
  await release();
  await until(() => picks.length === 4, 'the last save');
  expect(picks.slice(2).map((pick) => pick.key)).toEqual([SECOND, FIRST]);
  await release();

  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved).toEqual({ [FIRST]: 'first answer, final', [SECOND]: 'Ten minutes' });
  expect(replies[0]!.questions.map((q) => [q.key, q.revision])).toEqual([[FIRST, 5], [SECOND, 5]]);
});

test.skipIf(!hasDom)('a save refused with a newer answer waiting: the newer one goes and decides, and no error stays', async () => {
  const el = await render();
  await answered(el);
  gate = [];
  refusals = [FULL];
  type(el, 'pi');
  await until(() => picks.length === 2, 'the save in flight');
  type(el, 'pin it');
  await press(el);
  await release();
  await until(() => picks.length === 3, 'the newer answer');
  // The refused save raised nothing: the same revision again, and the store takes it.
  expect(picks[2]!.revision).toBe(4);
  await release();
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved[FIRST]).toBe('pin it');
  expect(el.textContent).not.toContain('The disk is full.');
});

test.skipIf(!hasDom)('the newest answer refused while the Send waits: the words stay, the error shows, nothing older goes, and the next Send saves them', async () => {
  const el = await render();
  await answered(el, 'older');
  gate = [];
  type(el, 'older, then more');
  await until(() => picks.length === 2, 'the save in flight');
  refusals = [FULL];
  await press(el);
  await release();
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(replies).toHaveLength(0);
  expect(otherField(el).value).toBe('older, then more');

  gate = null;
  await press(el);
  await until(() => replies.length === 1, 'the next Send');
  expect(replies[0]!.saved[FIRST]).toBe('older, then more');
  expect(el.textContent).not.toContain('The disk is full.');
});

test.skipIf(!hasDom)('the newest answer refused just before the press: one try per press, and the Send stops until it lands', async () => {
  const el = await render();
  await answered(el, 'older');
  refusals = [FULL];
  type(el, 'older, then more');
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(otherField(el).value).toBe('older, then more');
  const tries = picks.length;

  // Still refused: nothing goes, older or newer, and only this press tried again.
  refusals = [FULL];
  await press(el);
  await until(() => picks.length === tries + 1, 'the try of this press');
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said again');
  await settle(10);
  expect(picks).toHaveLength(tries + 1);
  expect(replies).toHaveLength(0);
  expect(otherField(el).value).toBe('older, then more');

  await press(el);
  await until(() => replies.length === 1, 'the Send once it saves');
  expect(replies[0]!.saved[FIRST]).toBe('older, then more');
});

test.skipIf(!hasDom)('a first answer refused stays on the card, and later keys build on it', async () => {
  const el = await render();
  refusals = [FULL];
  type(el, 'never saved');
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(otherField(el).value).toBe('never saved');
  type(el, 'never saved, until now');
  await until(() => saved.get(FIRST)!.answer?.other === 'never saved, until now', 'the answer saved');
  expect(el.textContent).not.toContain('The disk is full.');
});

test.skipIf(!hasDom)('another window took the revision: the words stay, the conflict shows, and the Send goes with what the field shows', async () => {
  const el = await render();
  await answered(el, 'mine');
  saved.set(FIRST, { ...saved.get(FIRST)!, answer: { ...saved.get(FIRST)!.answer!, other: 'theirs' }, revision: 9 });
  type(el, 'mine, longer');
  await until(() => el.textContent?.includes('That question changed since you read it.') === true, 'the conflict said');
  await settle(5);
  expect(otherField(el).value).toBe('mine, longer');
  await press(el);
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved[FIRST]).toBe('mine, longer');
});

test.skipIf(!hasDom)('a change after the press, the save running refused: the newer save decides and the Send goes', async () => {
  const el = await render();
  await answered(el);
  gate = [];
  type(el, 'pi');
  await until(() => picks.length === 2, 'the save in flight');
  refusals = [FULL];
  await press(el);
  type(el, 'pin it');
  await release();
  await until(() => picks.length === 3, 'the newer answer');
  await release();
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved[FIRST]).toBe('pin it');
  expect(el.textContent).not.toContain('The disk is full.');
});

test.skipIf(!hasDom)('a change after the press, both saves refused: the error shows and the Send is back, never a silent stop', async () => {
  const el = await render();
  await answered(el);
  gate = [];
  type(el, 'pi');
  await until(() => picks.length === 2, 'the save in flight');
  refusals = [FULL, FULL];
  await press(el);
  type(el, 'pin it');
  await release();
  await until(() => picks.length === 3, 'the newer answer');
  await release();
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await until(() => sendButton(el)?.disabled === false, 'the Send back');
  expect(replies).toHaveLength(0);
  expect(otherField(el).value).toBe('pin it');
});

test.skipIf(!hasDom)('the error cleared while a refused save is read back: the stopped Send still says why', async () => {
  const el = await render();
  await answered(el);
  gate = [];
  refusals = [FULL];
  type(el, 'pi');
  await until(() => picks.length === 2, 'the save in flight');
  await press(el);
  let reread!: () => void;
  changed = new Promise<void>((resolve) => (reread = resolve));
  await release();
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  // Answering the other question clears the error while the refused save still reads the thread again.
  gate = null;
  await act(async () => option(el, 'One minute').click());
  expect(el.textContent).not.toContain('The disk is full.');
  await act(async () => reread());
  await until(() => el.textContent?.includes('The pick was not saved.') === true, 'why the Send stopped');
  expect(replies).toHaveLength(0);
});

test.skipIf(!hasDom)('changes after the press go in the Send, up to the point the line closes; one after that never reopens the question', async () => {
  const el = await render();
  await answered(el, 'a');
  gate = [];
  type(el, 'ab');
  await until(() => picks.length === 2, 'the save running at the press');
  await press(el);

  type(el, 'abc');
  await release();
  await until(() => picks.length === 3, 'the first change after the press');
  type(el, 'abcd');
  await release();
  await until(() => picks.length === 4, 'the second change after the press');
  expect(picks[3]!.answer?.other).toBe('abcd');
  // The third round has started, so the line is closed: this one waits for the reply.
  type(el, 'abcde');
  await release();
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.saved[FIRST]).toBe('abcd');
  expect(replies[0]!.questions.map((q) => [q.key, q.revision])).toEqual([[FIRST, 7]]);

  // It leaves after the reply, and the sent question stays as sent.
  await until(() => picks.length === 5, 'the late change');
  expect(log.indexOf('reply')).toBeLessThan(log.lastIndexOf('pick'));
  await release();
  await until(() => toasts.length === 1, 'the notice');
  // Pinned on purpose: the only word the person gets that their last change did not go (wording reported to the owner).
  expect(toasts[0]!.lead).toBe('Pick not saved. That question was already sent, so your last change did not go.');
  expect(saved.get(FIRST)!.answer?.other).toBe('abcd');
  expect(saved.get(FIRST)!.sent).toBe(true);
});

test.skipIf(!hasDom)('dictation that never stops cannot hold the Send: it goes within the rounds, and no save runs beside it', async () => {
  const el = await render();
  await answered(el, 'word');
  saveMs = 4;
  let words = 'word';
  for (let i = 0; i < 5; i += 1) {
    words += ' more';
    type(el, words);
    await settle(1);
  }
  await until(() => sendButton(el)?.disabled === false, 'the Send');
  await act(async () => sendButton(el)!.click());
  const atPress = picks.length;
  for (let i = 0; i < 400 && replies.length === 0; i += 1) {
    words += ' more';
    type(el, words);
    await settle(1);
  }
  expect(replies).toHaveLength(1);
  // The save running, then the answers of three rounds: never one per change.
  expect(picks.length - atPress).toBeLessThanOrEqual(4);
  // The server took the reply at the revision it named: no save raced it.
  expect(saved.get(FIRST)!.sent).toBe(true);
  expect(el.textContent).not.toContain('That question changed since you read it.');
  await settle(30);
});

test.skipIf(!hasDom)('a question replaced behind the saves, with an answer saved on it: nothing goes until the person has read that', async () => {
  const el = await render();
  await answered(el, 'first');
  gate = [];
  type(el, 'first answer');
  await until(() => picks.length === 2, 'the save in flight');
  saved.set(FIRST, { ...saved.get(FIRST)!, superseded: true });
  await press(el);
  await release();
  await until(() => el.textContent?.includes('will not be sent.') === true, 'the guard');
  expect(replies).toHaveLength(0);
});

test.skipIf(!hasDom)('a first answer on a question replaced during the wait: the words were the only copy, so a notice says so and the Send stops for the guard', async () => {
  const el = await render();
  await act(async () => option(el, 'One minute').click());
  await until(() => saved.get(SECOND)!.answer !== null, 'the second question saved');
  await until(() => sendButton(el) !== null, 'the Send');
  gate = [];
  type(el, 'first');
  await until(() => picks.length === 2, 'the save in flight');
  type(el, 'first answer');
  saved.set(FIRST, { ...saved.get(FIRST)!, superseded: true });
  await press(el);
  await release();
  // The newest answer is refused too: only it speaks.
  await until(() => picks.length === 3, 'the newest answer');
  await release();
  await until(() => toasts.length > 0, 'the notice');
  // Pinned on purpose: the only word the person gets that these words were the only copy (wording reported to the owner).
  expect(toasts.map((toast) => toast.lead)).toEqual(["Pick not saved. That question was replaced, so this answer won't be sent."]);
  await until(() => el.textContent?.includes('Your pick on it will not be sent.') === true, 'the guard');
  expect(replies).toHaveLength(0);
  expect(el.textContent).not.toContain('Replaced.');

  // Having read it, the person sends the rest.
  await act(async () => el.querySelector<HTMLElement>('[data-guard-send-rest]')!.click());
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.questions.map((q) => q.key)).toEqual([SECOND]);
});

test.skipIf(!hasDom)('a save refused after the pane closed: a notice says so, naming the thread', async () => {
  const el = await render();
  gate = [];
  refusals = [FULL];
  type(el, 'left behind');
  await until(() => picks.length === 1, 'the save in flight');
  act(() => root!.unmount());
  root = null;
  await release();
  await until(() => toasts.length === 1, 'the notice');
  expect(toasts[0]!.icon).toBe('warn');
  // Pinned on purpose: with the pane gone, this is the only word the person gets, and it names the thread (wording reported to the owner).
  expect(toasts[0]!.lead).toBe('Pick not saved. Your answer in "Retry" did not reach the Inbox.');
});

test.skipIf(!hasDom)('leaving the pane with words not saved: a notice says so as it closes', async () => {
  const el = await render();
  refusals = [FULL];
  type(el, 'left behind');
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(toasts).toHaveLength(0);
  act(() => root!.unmount());
  root = null;
  // Pinned on purpose: as above, the only word the person gets once the pane is gone.
  expect(toasts.map((toast) => toast.lead)).toEqual(['Pick not saved. Your answer in "Retry" did not reach the Inbox.']);
});

test.skipIf(!hasDom)('replaced during the wait and the thread read after it failed: the stopped Send says why, never a silent stop', async () => {
  const el = await render();
  await act(async () => option(el, 'One minute').click());
  await until(() => saved.get(SECOND)!.answer !== null, 'the second question saved');
  await until(() => sendButton(el) !== null, 'the Send');
  gate = [];
  rereadFails = true;
  type(el, 'first');
  await until(() => picks.length === 2, 'the save in flight');
  saved.set(FIRST, { ...saved.get(FIRST)!, superseded: true });
  await press(el);
  await release();
  await until(() => toasts.length === 1, 'the notice');
  // The thread on screen does not show the question replaced, so no guard can draw: the error says why.
  await until(() => el.textContent?.includes('The pick was not saved.') === true, 'why the Send stopped');
  expect(el.textContent).not.toContain('will not be sent.');
  expect(replies).toHaveLength(0);
});

test.skipIf(!hasDom)('after a Send the guard stopped past its wait, a new answer still saves', async () => {
  const el = await render();
  await act(async () => option(el, 'One minute').click());
  await until(() => saved.get(SECOND)!.answer !== null, 'the second question saved');
  await until(() => sendButton(el) !== null, 'the Send');
  gate = [];
  type(el, 'first');
  await until(() => picks.length === 2, 'the save in flight');
  saved.set(FIRST, { ...saved.get(FIRST)!, superseded: true });
  await press(el);
  await release();
  await until(() => el.textContent?.includes('will not be sent.') === true, 'the guard');
  gate = null;
  await act(async () => option(el, 'Ten minutes').click());
  await until(() => saved.get(SECOND)!.answer?.selected[0] === 'Ten minutes', 'the new answer saved');
  expect(replies).toHaveLength(0);
});

test.skipIf(!hasDom)('a saved pick reads the files once at most: only a read of the thread reads them again', async () => {
  const el = await render();
  await until(() => attachmentReads === 1, 'the first read of the files');
  saveMs = 1;
  for (const words of ['a', 'ab', 'abc', 'abcd']) {
    type(el, words);
    await until(() => saved.get(FIRST)!.answer?.other === words, 'the save');
    await settle(2);
  }
  expect(picks).toHaveLength(4);
  expect(attachmentReads).toBe(1);
});

/** Re-ask, at the foot of the open questions' list. */
async function reask(el: HTMLElement) {
  const trigger = el.querySelector<HTMLElement>('[data-open-questions]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.click();
  });
  for (let i = 0; i < 30 && !document.querySelector('[data-open-questions-list]'); i += 1) await settle();
  const item = document.querySelector<HTMLElement>('[data-open-questions-list] [data-reask]')!;
  await act(async () => item.click());
}

test.skipIf(!hasDom)('Re-ask waits for the newest answer: the note goes after it lands', async () => {
  const el = await render();
  gate = [];
  type(el, 'first');
  await until(() => picks.length === 1, 'the save in flight');
  await reask(el);
  await settle(5);
  expect(log).toEqual(['pick']);
  await release();
  await until(() => log.includes('reask'), 'the note');
  expect(log).toEqual(['pick', 'reask']);
});

test.skipIf(!hasDom)('after a Re-ask, a new answer still saves', async () => {
  const el = await render();
  type(el, 'first');
  await until(() => saved.get(FIRST)!.answer?.other === 'first', 'the first answer saved');
  await reask(el);
  await until(() => log.includes('reask'), 'the note');
  await settle(5);
  type(el, 'first, then more');
  await until(() => saved.get(FIRST)!.answer?.other === 'first, then more', 'the new answer saved');
});

test.skipIf(!hasDom)('Re-ask stops on an answer not saved: the error shows and nothing is asked', async () => {
  const el = await render();
  gate = [];
  refusals = [FULL];
  type(el, 'first');
  await until(() => picks.length === 1, 'the save in flight');
  await reask(el);
  await release();
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(log).toEqual(['pick']);
  expect(otherField(el).value).toBe('first');
});

/** Mod+Enter, with the layout happy-dom has none of: the Send counts as on screen while `shown()` says so. */
function modEnterLayout(shown: () => boolean) {
  const real = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (shown() ? [new DOMRect(0, 0, 100, 30)] : []) as unknown as DOMRectList;
  };
  return () => {
    HTMLElement.prototype.getClientRects = real;
  };
}

async function modEnter(from: Element) {
  await act(async () => {
    from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)('Mod+Enter before the Send is drawn waits for the save, then sends the newest answer', async () => {
  const restore = modEnterLayout(() => true);
  try {
    const el = await render();
    gate = [];
    type(el, 'first');
    await until(() => picks.length === 1, 'the save in flight');
    await modEnter(otherField(el));
    // Past the eight frames the key gives the Send to draw: only a wait for the save can still press it.
    await settle(200);
    expect(replies).toHaveLength(0);
    await release();
    await until(() => replies.length === 1, 'the reply');
    expect(replies[0]!.saved[FIRST]).toBe('first');
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('Mod+Enter on an answer not saved: the key is spent, the error shows and nothing goes', async () => {
  let shown = false;
  const restore = modEnterLayout(() => shown);
  try {
    const el = await render();
    await answered(el);
    gate = [];
    refusals = [FULL];
    type(el, 'pi');
    await until(() => picks.length === 2, 'the save in flight');
    await modEnter(otherField(el));
    shown = true;
    await release();
    await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
    await settle(200);
    expect(picks).toHaveLength(2);
    expect(replies).toHaveLength(0);
    expect(otherField(el).value).toBe('pi');
  } finally {
    restore();
  }
});

/** The queue, on its own: a save held until the test says. */
function heldSave(ran: string[], name: string) {
  let finish!: (saved: boolean) => void;
  const done = new Promise<boolean>((resolve) => (finish = resolve));
  return {
    save: () => {
      ran.push(name);
      return done;
    },
    finish,
  };
}

test('a newer answer keeps the place its question first took in the line', async () => {
  const ran: string[] = [];
  const queue = createPickQueue();
  const first = heldSave(ran, 'a');
  queue.put('a', first.save);
  const stale = heldSave(ran, 'stale b');
  queue.put('b', stale.save);
  const c = heldSave(ran, 'c');
  queue.put('c', c.save);
  const newest = heldSave(ran, 'newest b');
  queue.put('b', newest.save);
  first.finish(true);
  await Bun.sleep(0);
  newest.finish(true);
  await Bun.sleep(0);
  c.finish(true);
  await queue.settled();
  expect(ran).toEqual(['a', 'newest b', 'c']);
});

test('a save that throws saved nothing, and the line goes on', async () => {
  const queue = createPickQueue();
  let reached = false;
  queue.put('a', () => Promise.reject(new Error('thrown')));
  queue.put('b', async () => {
    reached = true;
    return true;
  });
  await queue.settled();
  await Bun.sleep(0);
  expect(reached).toBe(true);
  expect(queue.unsaved()).toBe(1);
});

test('the questions saving are reported as they change, and none once the last lands', async () => {
  const seen: string[][] = [];
  const queue = createPickQueue((ids) => seen.push([...ids]));
  const a = heldSave([], 'a');
  queue.put('a', a.save);
  const b = heldSave([], 'b');
  queue.put('b', b.save);
  a.finish(true);
  await Bun.sleep(0);
  b.finish(true);
  await Bun.sleep(0);
  expect(seen).toEqual([['a'], ['a', 'b'], ['b'], []]);
});
