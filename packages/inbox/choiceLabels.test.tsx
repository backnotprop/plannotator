/**
 * A choice label is the agent's inline markdown (`- [ ] [15% off](forecast-15.html)`,
 * inline code, bold). The live card draws it as markdown; every line or row
 * that draws a pick as text shows the label's words ("15% off"), never its
 * markdown: the folded line (and its screen-reader label), the answers a sent
 * reply carried, the answers that go with the reply being written, the open
 * questions list's Draft, and a replaced card's unsent pick.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { formatQuestionAnswersSection, type QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'promo-abcdef', name: 'promo', root: '/work/promo', created_at: '2026-10-26T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const id = (n: number) => `msg_01M5CL0000000000000000000${n}`;
const [M1, R1, M2] = [1, 2, 3].map(id) as [string, string, string];

const LINK = '[15% off](forecast-15.html)';
const ASK = [
  'Two calls on the spring promo.',
  '',
  ':::question',
  'Which discount should the promo run?',
  '',
  `- [ ] ${LINK}`,
  '- [ ] `FLAT10` code',
  '- [ ] **20%** for members',
  ':::',
  '',
  ':::question-multi',
  'Which channels announce it?',
  '',
  '- [ ] **Email**',
  '- [ ] `push` notification',
  '- [ ] [In-app banner](forecast-15.html)',
  ':::',
].join('\n');
const PICKS = [[LINK], ['**Email**', '`push` notification', '[In-app banner](forecast-15.html)']];
const LATEST = ['The forecast is updated.', '', ':::question', 'Who gets the first send?', '', '- [ ] [Beta list](forecast-15.html)', '- [ ] `everyone`', ':::'].join('\n');

function questionsOf(messageId: string, body: string, patch: (q: InboxQuestion) => Partial<InboxQuestion> = () => ({})): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => {
    const base: InboxQuestion = {
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
      state: 'open',
      answer: null,
      revision: 0,
      sent_revision: 0,
      picked_by: null,
      picked_at: null,
      sent_reply_id: null,
      message_id: messageId,
      superseded_by: null,
    };
    return { ...base, ...patch(base) };
  });
}

const answerFor = (q: InboxQuestion, selected: string[]): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind === 'multi' ? 'multi' : 'single', prompt: q.prompt, selected });

function message(messageId: string, author: InboxAuthor, body: string, seq: number, questions: InboxQuestion[], extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id: messageId,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: messageId === M1 ? null : M1,
    author,
    subject: messageId === M1 ? 'Spring promo' : null,
    body,
    created_at: `2026-10-26T1${seq}:15:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...(questions.length > 0 ? { questions } : {}),
    ...extra,
  };
}

/** Asked, answered by a reply the person sent, then one more question: picked, not sent. The look is at the reply. */
function sample(): InboxThread {
  const asked = questionsOf(M1, ASK);
  const answers = asked.map((q, i) => answerFor(q, PICKS[i]!));
  const sent = asked.map((q, i) => ({ ...q, state: 'sent' as const, answer: answers[i]!, revision: 1, sent_revision: 1, sent_reply_id: R1 }));
  // The reply's body as the store writes it for the agent: each label exactly as written.
  const section = formatQuestionAnswersSection(
    asked.map((q, i) => ({ key: q.key, number: i + 1, prompt: q.prompt, recommendedLabels: [], settled: false })),
    answers,
  ).trimEnd();
  const replyBody = `Answered 2 questions.\n\n${section}`;
  const latest = questionsOf(M2, LATEST, (q) => ({ state: 'picked', revision: 1, picked_at: '2026-10-26T13:20:00.000Z', answer: answerFor(q, ['[Beta list](forecast-15.html)']) }));
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Spring promo',
    thread_name: null,
    resolved_at: null,
    messages: [
      message(M1, AGENT, ASK, 1, sent, { person_seen_seq: 2 }),
      message(R1, { kind: 'person' }, replyBody, 2, []),
      message(M2, AGENT, LATEST, 3, latest),
    ],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[data-open-questions-list]').forEach((n) => n.closest('.ib-oq-pos')?.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(thread: InboxThread) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />,
    );
  });
  await settle();
  return host;
}

const article = (el: HTMLElement, messageId: string) => el.querySelector<HTMLElement>(`[data-message-article="${messageId}"]`)!;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

const ANSWERS_LINE = 'Which discount should the promo run → 15% off · Which channels announce it → Email, push notification, In-app banner';
const ANSWERS_SAID = 'Which discount should the promo run: 15% off; Which channels announce it: Email, push notification, In-app banner';

test.skipIf(!hasDom)("the folded lines say the picked labels' words, never their markdown", async () => {
  const el = await render(sample());
  for (const messageId of [M1, R1]) {
    const line = article(el, messageId);
    expect(line.hasAttribute('data-folded')).toBe(true);
    expect(text(line.querySelector('[data-snippet="answers"]'))).toBe(ANSWERS_LINE);
    expect(line.querySelector('[data-fold-head]')!.getAttribute('aria-label')!.endsWith(ANSWERS_SAID)).toBe(true);
  }
});

test.skipIf(!hasDom)('the answers a sent reply carried, opened: the labels as words', async () => {
  const el = await render(sample());
  act(() => article(el, R1).querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  await until(() => article(el, R1).querySelectorAll('[data-sent-answer]').length === 2, 'the sent answers');
  const rows = [...article(el, R1).querySelectorAll('[data-sent-answer]')];
  expect(rows.map(text)).toEqual(['Q1 Which discount should the promo run? 15% off', 'Q2 Which channels announce it? Email, push notification, In-app banner']);
  expect(rows[0]!.getAttribute('aria-label')).toBe('Q1, Which discount should the promo run?: 15% off. Show the question.');
  // The reply's own body (the agent's copy) is not drawn: its markdown never shows.
  expect(article(el, R1).textContent).not.toContain('](');
});

test.skipIf(!hasDom)('the live card draws the label as markdown: a link and code', async () => {
  const el = await render(sample());
  const card = article(el, M2).querySelector('fieldset[data-question-key]')!;
  const options = [...card.querySelectorAll('[data-question-option]')];
  // The link drawn by the card's link handling (a file the message did not attach is inert text).
  expect(text(options[0]!.querySelector('[data-local-link]'))).toBe('Beta list');
  expect(text(options[1]!.querySelector('code'))).toBe('everyone');
  expect(card.textContent).not.toContain('](');
});

test.skipIf(!hasDom)("the open questions list's Draft and the answers going with the reply: the pick as words", async () => {
  const el = await render(sample());
  await press(el.querySelector<HTMLElement>('[data-open-questions]')!);
  await until(() => !!document.querySelector('[data-open-questions-list]'), 'the list');
  const row = document.querySelector('[data-open-questions-list] .ib-oq-row')!;
  expect(text(row.querySelector('.ib-oq-draft'))).toBe('Draft · Beta list');
  act(() => (document.activeElement as HTMLElement | null)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const edit = [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => ['Reply', 'Edit draft'].includes(text(b)))!;
  act(() => edit.click());
  await until(() => !!el.querySelector('[data-reply-answer]'), 'the answers going with the reply');
  expect(text(el.querySelector('[data-reply-answer]'))).toBe('Q1 Who gets the first send? Beta list');
});

test.skipIf(!hasDom)("a replaced card's unsent pick: the label's words", async () => {
  const OLD = `Promo.\n\n:::question\nWhich discount should the promo run?\n\n- [ ] ${LINK}\n- [ ] No discount\n:::`;
  const [old] = questionsOf(M1, OLD, (q) => ({
    state: 'superseded',
    revision: 1,
    picked_at: '2026-10-26T11:20:00.000Z',
    answer: answerFor(q, [LINK]),
    superseded_by: { message_id: M2, key: null },
  }));
  const thread: InboxThread = {
    thread_id: M1,
    project: PROJECT,
    subject: 'Spring promo',
    thread_name: null,
    resolved_at: null,
    messages: [message(M1, AGENT, OLD, 1, [old!]), message(M2, AGENT, 'The promo is off; neither question applies.', 2, [])],
  };
  const el = await render(thread);
  expect(text(el.querySelector('[data-unsent-pick] b'))).toBe('15% off');
});
