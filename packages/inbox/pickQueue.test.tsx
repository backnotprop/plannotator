/**
 * A question card saves on every change, so a dictated "Other" answer changes
 * faster than it saves (the owner's debug log, 2026-11-02: 81 saves in a line,
 * a Send 7.2 s behind them, on a phone over a tailnet). While a save runs, each
 * question keeps only its newest answer waiting; a Send waits for the save
 * running and that answer, and nothing else. A reply names its questions by
 * revision and the server sends what is saved, so the fake server's saved
 * answer at the moment of the reply is what the Send carried.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';

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
let log: ('pick' | 'reply')[];
let picks: PickPost[];
let replies: ReplyPost[];
let attachmentReads: number;
/** Set: each save waits here until the test releases it, the POST already seen. */
let gate: (() => void)[] | null;
/** Each save takes this long. */
let saveMs: number;
/** What the next saves answer instead of saving, one per save. */
let refusals: { status: number; code: string; error: string }[];

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
      state: held.superseded ? 'superseded' : held.answer ? 'picked' : 'open',
      answer: held.answer,
      revision: held.revision,
      sent_revision: 0,
      picked_by: held.answer ? { kind: 'person' } : null,
      picked_at: held.answer ? '2026-11-01T10:20:00.000Z' : null,
      sent_reply_id: null,
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

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  saved = new Map(parsed.map((q) => [q.key, { answer: null, revision: 3, superseded: false }]));
  log = [];
  picks = [];
  replies = [];
  attachmentReads = 0;
  gate = null;
  saveMs = 0;
  refusals = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/picks') && init?.method === 'POST') {
      const entry = (JSON.parse(String(init.body)) as { questions: PickPost[] }).questions[0]!;
      picks.push(entry);
      log.push('pick');
      const waiting = gate;
      if (waiting) await new Promise<void>((resolve) => waiting.push(resolve));
      else if (saveMs > 0) await new Promise((resolve) => setTimeout(resolve, saveMs));
      const refusal = refusals.shift();
      if (refusal) return Response.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
      const held = saved.get(entry.key)!;
      if (held.superseded) return Response.json({ error: 'Replaced.', code: 'question_superseded' }, { status: 422 });
      // As the store does: a stale revision is refused, so a test that passes sent the right one.
      if (held.revision !== entry.revision) return Response.json({ error: 'Stale revision.', code: 'question_revision_conflict' }, { status: 409 });
      saved.set(entry.key, { ...held, answer: entry.answer, revision: held.revision + 1 });
      return Response.json({ message_id: M1, questions: wire(), reply: null });
    }
    if (path.endsWith('/reply') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { questions: ReplyPost['questions'] };
      log.push('reply');
      replies.push({ questions: body.questions, saved: Object.fromEntries([...saved].map(([key, held]) => [key, held.answer?.other ?? held.answer?.selected[0]])) });
      return Response.json({ reply: { id: 'msg_reply', thread_id: M1, author: { kind: 'person' } }, questions: wire(), replayed: false });
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
      onChanged={async () => setThread(threadNow())}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
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
  await until(() => sendButton(el) !== null, 'the Send');
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

test.skipIf(!hasDom)('80 changes behind a slow save: one POST for the lot, and the Send goes right after it with the final answer', async () => {
  const el = await render();
  type(el, 'p');
  await until(() => saved.get(FIRST)!.answer !== null, 'the first answer saved');
  await until(() => sendButton(el) !== null, 'the Send');

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
  expect(replies[0]!.questions).toEqual([{ message_id: M1, key: FIRST, revision: 6 }]);
});

test.skipIf(!hasDom)('a question changing 80 times against a slow server: far fewer POSTs, the last with the final text', async () => {
  const el = await render();
  saveMs = 12;
  const steps = Array.from({ length: 80 }, (_, i) => `answer ${i}`);
  for (const step of steps) {
    type(el, step);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const final = steps.at(-1)!;
  await until(() => saved.get(FIRST)!.answer?.other === final, 'the final answer saved');
  await settle(30);
  expect(picks.length).toBeLessThan(20);
  expect(picks.at(-1)!.answer?.other).toBe(final);
  // Each one went with the revision the one before made.
  expect(picks.map((pick) => pick.revision)).toEqual(picks.map((_, i) => 3 + i));
  expect(otherField(el).value).toBe(final);
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
  type(el, 'p');
  await until(() => sendButton(el) !== null, 'the Send');
  gate = [];
  refusals = [{ status: 500, code: 'error', error: 'The disk is full.' }];
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

test.skipIf(!hasDom)('the newest answer refused: the Send stops and says why, never sending the older answer', async () => {
  const el = await render();
  type(el, 'older');
  await until(() => sendButton(el) !== null, 'the Send');
  gate = [];
  type(el, 'older, then more');
  await until(() => picks.length === 2, 'the save in flight');
  refusals = [{ status: 500, code: 'error', error: 'The disk is full.' }];
  await press(el);
  await release();
  await until(() => el.textContent?.includes('The disk is full.') === true, 'the refusal said');
  await settle(5);
  expect(replies).toHaveLength(0);
  // Not stuck: the next Send goes, with what the card shows now.
  gate = null;
  await press(el);
  await until(() => replies.length === 1, 'the next Send');
  expect(replies[0]!.saved[FIRST]).toBe('older');
  expect(otherField(el)?.value ?? 'older').toBe('older');
});

test.skipIf(!hasDom)('a question replaced behind the saves: no error, and the Send still goes with the rest', async () => {
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
  // The newest answer is refused too: it asks nothing of the person.
  await until(() => picks.length === 3, 'the newest answer');
  await release();
  await until(() => replies.length === 1, 'the reply');
  expect(replies[0]!.questions.map((q) => q.key)).toEqual([SECOND]);
  expect(el.textContent).not.toContain('Replaced.');
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
