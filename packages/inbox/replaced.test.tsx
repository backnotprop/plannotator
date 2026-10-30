/**
 * Replaced questions as the window draws them (direction A "Quiet"): the old
 * card keeps its prompt, what replaced it and the person's unsent pick, with
 * no answer controls; the newer card says what it replaces; and the stale
 * guard stops a Send that would drop a pick the agent replaced while the
 * person was answering (once per replacement, and on the server's 422).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-10T10:00:00.000Z' };
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H8QK2V7D9C1X5RZ3N0AB4T';

const BODY1 = [
  'Two things before I go on.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  'Stopped: the retry worker cannot ship without this.',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job and send it to the dead-letter queue',
  ':::',
  '',
  ':::question',
  'Ship the retry behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const BODY2 = [
  'You moved the 409 handling into the jobs queue.',
  '',
  ':::question',
  'How many times should the jobs queue retry a Stripe 409?',
  '',
  '- [ ] 3 times over 10 minutes',
  '- [ ] Once, then dead-letter',
  ':::',
].join('\n');

const WITHDRAW = 'You settled this in our session: neither question applies any more.';

function questionsOf(messageId: string, body: string): InboxQuestion[] {
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
    asked_by_agent_id: 'ses_a',
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

function message(id: string, body: string, at: string, questions: InboxQuestion[]): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author: AGENT,
    subject: id === M1 ? 'Which way should the worker go on a Stripe 409?' : null,
    body,
    created_at: at,
    resolved_at: null,
    idempotency_key: null,
    ...(questions.length > 0 ? { questions } : {}),
  };
}

const PICK = 'Fail the job and send it to the dead-letter queue';

/** The thread before the replacement: question 1 picked at 10:51, not sent. */
function before(): InboxThread {
  const [q1, q2] = questionsOf(M1, BODY1);
  const picked: InboxQuestion = { ...q1!, state: 'picked', revision: 1, picked_at: '2026-10-10T10:51:00.000Z', answer: { v: 1, key: q1!.key, kind: 'single', prompt: q1!.prompt, selected: [PICK] } };
  return { thread_id: M1, project: PROJECT, subject: q1!.prompt, thread_name: null, resolved_at: null, messages: [message(M1, BODY1, '2026-10-10T10:42:00.000Z', [picked, q2!])] };
}

/** After: the agent replaced question 1 with the queue question (or withdrew the whole message). */
function after(kind: 'replace' | 'withdraw'): InboxThread {
  const base = before();
  const [q1, q2] = base.messages[0]!.questions!;
  if (kind === 'replace') {
    const [qn] = questionsOf(M2, BODY2);
    const old: InboxQuestion = { ...q1!, state: 'superseded', superseded_by: { message_id: M2, key: qn!.key } };
    return {
      ...base,
      subject: qn!.prompt,
      messages: [message(M1, BODY1, '2026-10-10T10:42:00.000Z', [old, q2!]), message(M2, BODY2, '2026-10-10T11:05:00.000Z', [qn!])],
    };
  }
  const gone = (q: InboxQuestion): InboxQuestion => ({ ...q, state: 'superseded', superseded_by: { message_id: M2, key: null } });
  return { ...base, messages: [message(M1, BODY1, '2026-10-10T10:42:00.000Z', [gone(q1!), gone(q2!)]), message(M2, WITHDRAW, '2026-10-10T11:05:00.000Z', [])] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: unknown }[] = [];
let replyAnswer: () => Response = () => new Response('{}');
let picksAnswer: () => Response = () => Response.json({ questions: [] });

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  picksAnswer = () => Response.json({ questions: [] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/reply')) return replyAnswer();
      if (path.endsWith('/picks')) return picksAnswer();
      return Response.json({});
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
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

function pane(thread: InboxThread, onChanged: () => Promise<void> = async () => {}) {
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={onChanged}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />
    </div>
  );
}

async function render(thread: InboxThread, onChanged?: () => Promise<void>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread, onChanged));
  });
  await settle();
  return host;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  // A jump link is an inline element with the button role (ReplacedQuestion's JumpLink).
  const found = [...el.querySelectorAll('button, [role="button"]')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function card(el: HTMLElement, messageId: string, key: string): HTMLElement {
  return el.querySelector(`[data-message-id="${messageId}"] [data-question-key="${key}"]`) as HTMLElement;
}

test.skipIf(!hasDom)('the replaced card: tag, the row naming the new question, the unsent pick, no answer controls, old options folded', async () => {
  const thread = after('replace');
  const el = await render(thread);
  const [q1, q2] = thread.messages[0]!.questions!;
  const old = card(el, M1, q1!.key);
  expect(old.getAttribute('data-question-state')).toBe('superseded');
  expect(old.querySelector('[data-replaced-tag]')?.textContent).toBe('Replaced');
  const row = old.querySelector('[data-replaced-row]')!;
  expect(row.textContent).toContain('How many times should the jobs queue retry a Stripe 409?');
  expect(old.querySelector('[data-unsent-pick]')?.textContent).toBe(`Your pick: ${PICK}Not sent`);
  // Nothing on it can be answered: no enabled input, no Skip, Add note or Accept recommended.
  expect([...old.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
  expect(old.textContent).not.toContain('Skip');
  expect(old.textContent).not.toContain('Add note');
  expect((old.querySelector('[data-old-options]') as HTMLElement).hidden).toBe(true);
  act(() => button(old, 'Show the old options').click());
  expect((old.querySelector('[data-old-options]') as HTMLElement).hidden).toBe(false);
  // The other question of the message is still an answer card.
  expect(card(el, M1, q2!.key).getAttribute('data-question-state')).toBeNull();
  // The newer card says what it replaces, and that the pick there was not sent.
  const fresh = card(el, M2, thread.messages[1]!.questions![0]!.key);
  expect(fresh.querySelector('[data-replaces-line]')?.textContent).toBe('Replaces Which way should the worker go on a Stripe 409?↑. Your pick there was not sent.');
  // A replaced pick is never a pick waiting for Send: the foot offers Reply only.
  expect(el.querySelector('.ib-pfoot')?.textContent).not.toContain('Not sent');
});

test.skipIf(!hasDom)('a link between the cards scrolls to the other card, focuses it and rings it', async () => {
  const thread = after('replace');
  const el = await render(thread);
  const [q1] = thread.messages[0]!.questions!;
  const fresh = card(el, M2, thread.messages[1]!.questions![0]!.key);
  act(() => (card(el, M1, q1!.key).querySelector('.ib-q-link') as HTMLButtonElement).click());
  expect(document.activeElement).toBe(fresh);
  expect(fresh.classList.contains('ib-q-target')).toBe(true);
  act(() => (fresh.querySelector('.ib-q-link') as HTMLButtonElement).click());
  expect(document.activeElement).toBe(card(el, M1, q1!.key));
});

test.skipIf(!hasDom)('no replacement: "No longer applies", and the row links to the agent\'s message', async () => {
  const thread = after('withdraw');
  const el = await render(thread);
  const old = card(el, M1, thread.messages[0]!.questions![0]!.key);
  expect(old.querySelector('[data-replaced-tag]')?.textContent).toBe('No longer applies');
  expect(old.querySelector('[data-replaced-row]')?.textContent).toContain('Claude Code said at');
  act(() => button(old, 'Read why↓').click());
  expect(document.activeElement?.getAttribute('data-message-article')).toBe(M2);
});

/** The person's words in the reply box (the box opens empty: the picks are listed beside the words, never written in). */
function typeWords(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('the stale guard: a pick replaced while the person writes stops Send once, says why, and Esc keeps editing', async () => {
  const el = await render(before());
  act(() => button(el, 'Edit draft').click());
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  // The person types; then the agent replaces question 1.
  typeWords(text, 'Leaning this way for now.');
  act(() => root!.render(pane(after('replace'))));
  await settle();
  expect(el.querySelector('[data-replaced-notice]')?.textContent).toContain("replaced question 1 at");
  expect(el.querySelector('[data-dropped-picks-chip]')?.textContent).toBe('1 pick on a replaced question');
  expect(el.querySelector('[data-picks-chip]')).toBeNull();
  expect(text.value).not.toBe('');

  act(() => button(el, 'Send').click());
  await settle();
  const guard = el.querySelector('[data-stale-guard]') as HTMLElement;
  expect(guard).not.toBeNull();
  expect(guard.getAttribute('role')).toBe('alertdialog');
  expect(guard.querySelector('h3')?.textContent).toBe('Question 1 changed before you sent');
  expect(guard.textContent).toContain(`Your pick, ${PICK}, will not be sent.`);
  expect(document.activeElement).toBe(guard);
  expect(posted.filter((p) => p.path.endsWith('/reply'))).toEqual([]);
  expect(guard.querySelector('[data-guard-send-rest]')?.textContent).toBe('Send your words only');

  // Esc is Keep editing: the draft is back, focus on Send.
  act(() => guard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  expect(el.querySelector('[data-stale-guard]')).toBeNull();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe(text.value);
  expect(document.activeElement?.textContent).toBe('Send');

  // Once per replacement: Send now goes, with the words only (no pick).
  // The Send leaves the questions open (Keep open by default, approval
  // "inbox-explicit-skip"): one reply, the words.
  act(() => button(el, 'Send').click());
  await settle();
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect((replies[0]!.body as { questions: unknown[] }).questions).toEqual([]);
  expect((replies[0]!.body as { skip?: unknown }).skip).toBeUndefined();
  expect((replies[0]!.body as { words: string }).words).toBe(text.value.trim());
});

test.skipIf(!hasDom)('Answer the new question keeps the draft and goes to the new card', async () => {
  const el = await render(before());
  act(() => button(el, 'Edit draft').click());
  typeWords(el.querySelector('textarea') as HTMLTextAreaElement, 'Leaning this way for now.');
  act(() => root!.render(pane(after('replace'))));
  await settle();
  act(() => button(el, 'Send').click());
  await settle();
  act(() => (el.querySelector('[data-guard-answer-new]') as HTMLButtonElement).click());
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const thread = after('replace');
  expect(el.querySelector('[data-stale-guard]')).toBeNull();
  expect(document.activeElement).toBe(card(el, M2, thread.messages[1]!.questions![0]!.key));
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).not.toBe('');
  expect(posted.filter((p) => p.path.endsWith('/reply'))).toEqual([]);
});

test.skipIf(!hasDom)('the race: a 422 question_superseded at Send shows the same panel, and nothing went', async () => {
  let current = before();
  const onChanged = async () => {
    current = after('replace');
    act(() => root!.render(pane(current, onChanged)));
  };
  replyAnswer = () => Response.json({ error: 'replaced', code: 'question_superseded' }, { status: 422 });
  const el = await render(current, onChanged);
  // The foot's own Send: the pick waits, the agent's replacement has not reached this tab yet.
  act(() => button(el, 'Send').click());
  await settle();
  await settle();
  const guard = el.querySelector('[data-stale-guard]') as HTMLElement;
  expect(guard).not.toBeNull();
  expect(guard.querySelector('h3')?.textContent).toBe('Question 1 changed before you sent');
  // Nothing else is in this reply: no "Send … only".
  expect(guard.querySelector('[data-guard-send-rest]')).toBeNull();
  expect(guard.textContent).toContain('Nothing else is in this reply yet.');
});

test.skipIf(!hasDom)('a pick that meets 422 question_superseded shows no error: the thread is read again and the card redraws as Replaced', async () => {
  let current = before();
  const [, q2] = current.messages[0]!.questions!;
  let reads = 0;
  const onChanged = async () => {
    reads += 1;
    current = after('withdraw');
    act(() => root!.render(pane(current, onChanged)));
  };
  picksAnswer = () => Response.json({ error: 'Question q-x no longer applies.', code: 'question_superseded' }, { status: 422 });
  const el = await render(current, onChanged);
  const yes = [...card(el, M1, q2!.key).querySelectorAll('label')].find((l) => l.textContent?.includes('Yes'))!.querySelector('input')!;
  await act(async () => {
    yes.click();
  });
  await settle();
  await settle();
  expect(posted.some((p) => p.path.endsWith('/picks'))).toBe(true);
  expect(reads).toBe(1);
  expect(el.querySelector('.ib-error')).toBeNull();
  expect(card(el, M1, q2!.key).getAttribute('data-question-state')).toBe('superseded');
});
