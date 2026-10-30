/**
 * Open questions in one thread (approval "inbox-thread-open-questions",
 * option A): the "N open questions" button in the foot's button row and the
 * short list it opens. What is proved: the count (open and picked-not-sent;
 * replaced questions and action items left out), when the button shows, the
 * list's name (no drawn heading or foot line), rows, states and places, the
 * Re-ask item at its foot (owner, 2026-10-23), choosing a row unfolding its
 * message and ringing the card, Escape putting focus back on the button, the
 * phone's bottom sheet, no button when nothing is open, the label forms and
 * the pill's place that keep the foot on one line (footFit.ts), and focus
 * landing on Reply when the button goes while its list is open, and skipping
 * from the list (approval "oq-skip-select", variant A): no per-row Skip, a
 * skipped row quiet at rest, "Skip…" entering a select mode whose ticks save
 * nothing until its button, which saves what the card's own Skip saves.
 *
 * The pure rules (openQuestions.ts) run everywhere; the window's parts are
 * DOM-gated: they run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { openQuestionsShown, openQuestionState, placeOf, reaskItemLabel, skipAllCandidates, skipSelection, skipToggledAnswer, threadOpenQuestions } from './openQuestions';
import { footFitCandidates, footRowOpenQuestionsForm, footRowTokens, onOneLine, onOneRow, openQuestionsFormText, pillHitsButtons } from './footFit';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-10-22T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const id = (n: number) => `msg_01M5OQ0000000000000000000${n}`;
const [M1, M2, M3, , M5, M6] = [1, 2, 3, 4, 5, 6].map(id) as [string, string, string, string, string, string];

const block = (prompt: string, extra: string[] = []) => [':::question', prompt, ...extra, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

function questionsOf(messageId: string, body: string, patch: Partial<InboxQuestion> = {}): InboxQuestion[] {
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
    asked_by_agent_id: A.session,
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
    ...patch,
  }));
}

const answerFor = (q: InboxQuestion, selected: string[]): QuestionAnswer => ({ v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected });

function agent(n: number, body: string, seq: number, patch: (q: InboxQuestion) => Partial<InboxQuestion> = () => ({}), extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  const messageId = id(n);
  const questions = questionsOf(messageId, body).map((q) => ({ ...q, ...patch(q) }));
  return {
    id: messageId,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: n === 1 ? null : M1,
    author: A,
    subject: n === 1 ? 'Retry worker for failed Stripe charges' : null,
    body,
    created_at: `2026-10-22T${String(9 + n).padStart(2, '0')}:15:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq,
    ...(n === 1 ? { person_seen_seq: 6 } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...extra,
  };
}

const ACTION: InboxQuestion = {
  ...questionsOf(M6, block('x'))[0]!,
  key: 'a-00000001',
  kind: 'action',
  prompt: 'Approve the 2FA prompt',
  choices: [],
  action: { where: null, where_url: null, run: null, watching: null },
  action_result: null,
};

/**
 * Six messages, all read (the look is at 6), so the fold folds the first four:
 * M2 hides in the middle fold ("1 earlier message"), M3 and M4 fold to a line.
 * M5 holds a pick not sent (it stays open), M6 is the last.
 */
function sample(): InboxMessageWire[] {
  return [
    agent(1, `Which queue?\n\n${block('Which queue backs the retry worker?')}`, 1, () => ({ state: 'sent' })),
    agent(2, `Rates.\n\n${block('How many times should a rate-limited charge be retried?')}`, 2),
    agent(3, `The 409 row.\n\n${block('Which way should the worker go on a Stripe 409?', ['Stopped: the deploy'])}`, 3),
    agent(4, `Old.\n\n${block('Log every attempt?')}`, 4, () => ({ state: 'superseded', superseded_by: { message_id: M6, key: null } })),
    agent(5, `Staging is green.\n\n${block('Ship the retry worker behind a flag?', ['Holds up: the retry worker; the admin page'])}`, 5, (q) => ({ state: 'picked', answer: answerFor(q, ['Yes']), revision: 1 })),
    agent(6, `Last one.\n\n${block('Anything the on-call runbook should say?')}`, 6, () => ({}), { actions: [ACTION] }),
  ];
}

const thread = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Retry worker for failed Stripe charges', thread_name: null, resolved_at: null, messages });

describe('the rules (openQuestions.ts)', () => {
  test('counts open and picked-not-sent questions; replaced ones and action items are left out', () => {
    const { questions, replaced } = threadOpenQuestions(sample());
    expect(questions.map((q) => q.messageId)).toEqual([M2, M3, M5, M6]);
    expect(questions.map((q) => q.prompt)).not.toContain('Approve the 2FA prompt');
    expect(replaced).toBe(1);
  });

  test('a row shows the draft pick first, else Stopped, else Holds up', () => {
    const { questions } = threadOpenQuestions(sample());
    expect(questions.map(openQuestionState)).toEqual([null, { kind: 'stopped' }, { kind: 'draft' }, null]);
    const holds = { ...questions[2]!, picked: false };
    expect(openQuestionState(holds)).toEqual({ kind: 'holds', count: 2 });
  });

  test('messages the archive closed are not listed', () => {
    const { questions } = threadOpenQuestions(sample(), (m) => m.id !== M2);
    expect(questions.map((q) => q.messageId)).toEqual([M3, M5, M6]);
  });

  test('shown whenever a question waits, or Re-ask is offered with only action items (owner, 2026-10-23)', () => {
    const { questions } = threadOpenQuestions(sample());
    expect(openQuestionsShown([])).toBe(false);
    expect(openQuestionsShown([], true)).toBe(true);
    expect(openQuestionsShown(questions.slice(0, 1))).toBe(true);
    expect(openQuestionsShown(questions.slice(0, 2))).toBe(true);
  });

  test("the Re-ask item's words: singular for one thing asked again", () => {
    expect(reaskItemLabel(1)).toBe('Re-ask in a new message');
    expect(reaskItemLabel(3)).toBe('Re-ask in one new message');
  });

  test('above or below by the middle of the card against the middle of the view', () => {
    const view = { top: 0, bottom: 600 };
    expect(placeOf({ top: 100, bottom: 200 }, view)).toBe('above');
    expect(placeOf({ top: 250, bottom: 590 }, view)).toBe('below');
    expect(placeOf({ top: 900, bottom: 1000 }, view)).toBe('below');
  });
});

describe('fitting the foot on one line (footFit.ts)', () => {
  test('the forms read "6 open questions", "6 open", "6"', () => {
    expect(openQuestionsFormText(6, 'full')).toBe('6 open questions');
    expect(openQuestionsFormText(1, 'full')).toBe('1 open question');
    expect(openQuestionsFormText(6, 'short')).toBe('6 open');
    expect(openQuestionsFormText(12, 'count')).toBe('12');
  });

  test('each form is tried on the usual spacing, then tightened, longest first; a phone starts at "6 open"', () => {
    const order = (max: Parameters<typeof footFitCandidates>[0]) => footFitCandidates(max).map((f) => `${f.form}${f.tight ? '+tight' : ''}`);
    expect(order('full')).toEqual(['full', 'full+tight', 'short', 'short+tight', 'count', 'count+tight']);
    expect(order('short')).toEqual(['short', 'short+tight', 'count', 'count+tight']);
  });

  test('one line: every top within a pixel of the first', () => {
    expect(onOneLine([846, 846.4, 845.6])).toBe(true);
    expect(onOneLine([553, 553, 605])).toBe(false);
  });

  test('the whole row shortens in the owner\'s order before the status wraps: the keycaps, skip, Edit, the count, the draft words, tight', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((level) => footRowTokens(level))).toEqual(['', 'keys', 'keys skip', 'keys skip edit', 'keys skip edit oq', 'keys skip edit oq draft', 'keys skip edit oq draft tight']);
    // A phone has one more step: Edit draft as its pencil. Other windows stop at tight.
    expect(footRowTokens(7, true)).toBe('keys skip edit oq draft tight icon');
    expect(footRowTokens(7)).toBe('keys skip edit oq draft tight');
    // The open questions button keeps its longest form until the oq step, then shows its count.
    expect([0, 1, 2, 3, 4, 6].map((level) => footRowOpenQuestionsForm(level, 'full'))).toEqual(['full', 'full', 'full', 'full', 'count', 'count']);
    expect(footRowOpenQuestionsForm(0, 'short')).toBe('short');
  });

  test('one row: the middles of buttons and status parts of different heights line up; a wrapped status does not', () => {
    // A 32 px button and a 26 px chip on one line share a middle.
    expect(onOneRow([861, 861.5, 860.8])).toBe(true);
    expect(onOneRow([861, 861, 824])).toBe(false);
  });

  test('the pill lies over a button only when one sits under the middle of the row', () => {
    const row = { left: 0, right: 388, top: 0, bottom: 44 };
    const pill = { width: 90, height: 36 };
    const at = (left: number, right: number) => ({ left, right, top: 0, bottom: 44 });
    // Reply alone: the middle is free.
    expect(pillHitsButtons(row, pill, [at(0, 110)])).toBe(false);
    // Reply, Re-ask and "2 open": Re-ask sits under the middle.
    expect(pillHitsButtons(row, pill, [at(0, 110), at(118, 230), at(238, 360)])).toBe(true);
    // Right to left, mirrored: the same.
    expect(pillHitsButtons(row, pill, [at(278, 388)])).toBe(false);
    expect(pillHitsButtons(row, pill, [at(160, 270)])).toBe(true);
  });
});

// ── The window ──

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

async function render(t: InboxThread, options: { phone?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(t, options));
  });
  await settle();
  return host;
}

function pane(t: InboxThread, options: { phone?: boolean } = {}) {
  return (
    <ThreadPane
      thread={t}
      sent={null}
      lookSeq={6}
      phone={options.phone === true}
      onQuestions={() => {}}
      onChanged={async () => {}}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
    />
  );
}

const button = () => document.querySelector<HTMLButtonElement>('[data-open-questions]');
const list = () => document.querySelector<HTMLElement>('[data-open-questions-list]');
const rows = () => [...(list()?.querySelectorAll<HTMLElement>('.ib-oq-row') ?? [])];
const reaskItem = () => list()?.querySelector<HTMLElement>('[data-reask]') ?? null;

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

async function openList() {
  await press(button()!);
  await until(() => !!list(), 'the list');
}

test.skipIf(!hasDom)('the button sits after Reply (no Re-ask in the foot), counts 4 (no replaced question, no action item), and opens a menu', async () => {
  const el = await render(thread(sample()));
  const b = button()!;
  expect(b.textContent?.trim()).toBe('4 open questions');
  const foot = [...el.querySelectorAll('[data-foot-buttons] button')].map((n) => n.textContent?.trim());
  expect(foot).not.toContain('Re-ask');
  expect(el.querySelector('[data-foot-buttons] [data-reask]')).toBeNull();
  expect(foot.indexOf('4 open questions')).toBe(foot.indexOf('Edit draft') + 1);
  expect(b.getAttribute('aria-haspopup')).toBe('menu');
  expect(b.getAttribute('aria-expanded')).toBe('false');
  expect(b.hasAttribute('title')).toBe(false);
  await openList();
  expect(b.getAttribute('aria-expanded')).toBe('true');
  expect(list()!.getAttribute('role')).toBe('menu');
  expect(list()!.getAttribute('aria-label')).toBe('4 open questions in this thread');
  // No drawn heading, count line or foot line: the name carries the count.
  expect(list()!.textContent).not.toContain('in this thread');
  expect(list()!.querySelector('.ib-oq-head, .ib-oq-sub, .ib-oq-foot')).toBeNull();
  expect(rows().map((r) => r.querySelector('.ib-oq-p')!.textContent)).toEqual([
    'How many times should a rate-limited charge be retried?',
    'Which way should the worker go on a Stripe 409?',
    'Ship the retry worker behind a flag?',
    'Anything the on-call runbook should say?',
  ]);
  // States: Stopped, the draft pick (it wins over Holds up), and where each card sits.
  expect(rows()[1]!.querySelector('.ib-b-stop')!.textContent).toBe('Stopped');
  expect(rows()[2]!.querySelector('.ib-oq-draft')!.textContent).toBe('Draft · Yes');
  expect(rows()[0]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· in a folded message$/);
  expect(rows()[1]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· in a folded message$/);
  expect(rows()[3]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· (below|above)$/);
  expect(list()!.textContent).not.toContain('Choose one');
  // Re-ask on the list's last row, a menu item after the rows, then "Skip…" (approval "oq-skip-select").
  const item = reaskItem()!;
  expect(item.getAttribute('role')).toBe('menuitem');
  expect(item.textContent?.trim()).toBe('Re-ask in one new message');
  const lastTwo = [...list()!.querySelectorAll('[role="menuitem"]')].slice(-2);
  // Identity as booleans: a failing DOM-node diff is slow to print.
  expect(lastTwo[0] === item && lastTwo[1]!.hasAttribute('data-open-questions-skip-mode')).toBe(true);
  expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toMatch(/^Ask Claude Code to ask the 3 open questions and 1 action item again, together in one message.* Your 1 pick is sent too\.$/);
  // No native tooltips anywhere in the list.
  expect(list()!.querySelector('[title]')).toBeNull();
});

test.skipIf(!hasDom)('choosing a row in the middle fold opens that message, scrolls to its card and rings it', async () => {
  const el = await render(thread(sample()));
  // M2 is hidden behind "1 earlier message": its card is not drawn.
  expect(el.querySelector(`[data-message-id="${M2}"] [data-question-key]`)).toBeNull();
  await openList();
  await act(async () => rows()[0]!.click());
  await until(() => !list(), 'the list to close');
  await until(() => !!el.querySelector(`[data-message-id="${M2}"] [data-question-key]`), 'the folded message to open');
  const card = el.querySelector<HTMLElement>(`[data-message-id="${M2}"] [data-question-key]`)!;
  await until(() => card.classList.contains('ib-q-target'), 'the ring on the card');
  // Focus went to the card, not back to the button.
  expect(document.activeElement).toBe(card);
});

test.skipIf(!hasDom)('a folded message (one line) opens too', async () => {
  const el = await render(thread(sample()));
  expect(el.querySelector(`[data-message-id="${M3}"] [data-question-key]`)).toBeNull();
  await openList();
  await act(async () => rows()[1]!.click());
  await until(() => !!el.querySelector(`[data-message-id="${M3}"] [data-question-key].ib-q-target`), 'the ringed card in M3');
});

test.skipIf(!hasDom)('arrow keys move through the rows; Escape closes the list and puts focus back on the button', async () => {
  await render(thread(sample()));
  const b = button()!;
  await act(async () => b.focus());
  await act(async () => {
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => !!list(), 'the list from the keyboard');
  await until(() => rows().some((r) => r.hasAttribute('data-highlighted')), 'a highlighted row');
  const highlighted = () => rows().findIndex((r) => r.hasAttribute('data-highlighted'));
  const start = highlighted();
  // No per-row Skip (approval "oq-skip-select"): one step to the next row.
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => highlighted() === start + 1, 'the next row');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !list(), 'the list to close on Escape');
  await until(() => document.activeElement === b, 'focus back on the button');
  expect(b.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('on a phone: "4 open" named in full, and the list is a bottom sheet with a scrim and a close', async () => {
  await render(thread(sample()), { phone: true });
  const b = button()!;
  expect(b.textContent?.trim()).toBe('4 open');
  expect(b.getAttribute('aria-label')).toBe('4 open questions');
  await openList();
  const positioner = list()!.closest('.ib-oq-pos')!;
  expect(positioner.hasAttribute('data-phone')).toBe(true);
  expect(document.querySelector('[data-open-questions-scrim]')).not.toBeNull();
  expect(reaskItem()?.textContent?.trim()).toBe('Re-ask in one new message');
  const close = list()!.querySelector<HTMLButtonElement>('[data-open-questions-close]')!;
  expect(close.getAttribute('aria-label')).toBe('Close');
  await act(async () => close.click());
  await until(() => !list(), 'the sheet to close');
});

const allSent = (keepAction: boolean) =>
  sample().map((m) => ({
    ...m,
    ...(m.questions ? { questions: m.questions.map((q) => (q.state === 'superseded' ? q : { ...q, state: 'sent' as const, answer: q.answer })) } : {}),
    ...(m.actions && !keepAction ? { actions: m.actions.map((a) => ({ ...a, state: 'sent' as const })) } : {}),
  }));

test.skipIf(!hasDom)('no button when nothing is open', async () => {
  await render(thread(allSent(false)));
  expect(button()).toBeNull();
});

test.skipIf(!hasDom)('only an action item open: the button counts it, and its list is Re-ask alone', async () => {
  await render(thread(allSent(true)));
  expect(button()!.textContent?.trim()).toBe('1 open action item');
  await openList();
  expect(list()!.getAttribute('aria-label')).toBe('1 open action item in this thread');
  expect(rows()).toHaveLength(0);
  expect(reaskItem()!.textContent?.trim()).toBe('Re-ask in a new message');
});

test.skipIf(!hasDom)('one open question in a short, unfolded thread: the button shows, with Re-ask in the singular', async () => {
  await render(thread([agent(1, `One call.\n\n${block('Ship it?')}`, 1, () => ({}), { person_seen_seq: 0 })]));
  expect(button()!.textContent?.trim()).toBe('1 open question');
  await openList();
  expect(rows()).toHaveLength(1);
  expect(reaskItem()!.textContent?.trim()).toBe('Re-ask in a new message');
});

test.skipIf(!hasDom)("the button going while its list is open puts focus on the foot's Reply, never the page", async () => {
  const el = await render(thread(sample()));
  await openList();
  await act(async () => rows()[0]!.focus());
  // Every open question and action item answered elsewhere: the button (and its list) goes.
  await act(async () => root!.render(pane(thread(allSent(false)))));
  await settle();
  expect(button()).toBeNull();
  expect(list()).toBeNull();
  await until(() => document.activeElement === el.querySelector('[data-reply-button]'), 'focus on Reply');
});

// ── Skipping from the list (approval "oq-skip-select", variant A) ──

describe('the Skip toggle (skipToggledAnswer, the card\'s toggleSkip)', () => {
  const q = questionsOf(M2, block('Ship it?'))[0]!;
  const base: QuestionAnswer = { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: [] };
  test('an empty answer becomes a skip; skipped again it clears (null)', () => {
    expect(skipToggledAnswer(base)).toEqual({ ...base, skipped: true });
    expect(skipToggledAnswer({ ...base, skipped: true })).toBeNull();
  });
  test('a pick and Other give way to the skip; a note stays, and Unskip keeps it', () => {
    const picked = { ...base, selected: ['Yes'], other: 'maybe', note: 'later' };
    expect(skipToggledAnswer(picked)).toEqual({ ...base, note: 'later', skipped: true });
    expect(skipToggledAnswer({ ...base, note: 'later', skipped: true })).toEqual({ ...base, note: 'later' });
  });
});

/** The thread as the server keeps it: picks change it, and the pane is told (onQuestions), as App does. */
let served: InboxMessageWire[] = [];
let pickBodies: { messageId: string; key: string; revision: number; answer: QuestionAnswer | null }[] = [];
const PICKED_AT = '2026-10-22T16:40:00.000Z';

function servePicks() {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const match = path.match(/\/api\/inbox\/messages\/([^/]+)\/picks$/);
    if (!match) return fallback(input, init);
    const messageId = decodeURIComponent(match[1]!);
    const body = JSON.parse(String(init?.body)) as { questions: { key: string; revision: number; answer: QuestionAnswer | null }[] };
    const entry = body.questions[0]!;
    pickBodies.push({ messageId, ...entry });
    served = served.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            questions: m.questions!.map((q) =>
              q.key !== entry.key
                ? q
                : { ...q, answer: entry.answer, state: entry.answer ? ('picked' as const) : ('open' as const), revision: q.revision + 1, picked_at: entry.answer ? PICKED_AT : null, picked_by: entry.answer ? { id: 'person', name: null } : null },
            ),
          },
    );
    return Response.json({ questions: served.find((m) => m.id === messageId)!.questions });
  }) as typeof fetch;
}

/** Adds a message to the live thread, as an agent writing while the list is open. */
let addMessage: ((message: InboxMessageWire) => void) | null = null;

function Live({ initial, phone = false }: { initial: InboxMessageWire[]; phone?: boolean }) {
  const [messages, setMessages] = React.useState(initial);
  addMessage = (message) => setMessages((current) => [...current, message]);
  return (
    <ThreadPane
      thread={thread(messages)}
      sent={null}
      lookSeq={6}
      phone={phone}
      onQuestions={(messageId, questions) => setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, questions } : m)))}
      onChanged={async () => {}}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
    />
  );
}

async function renderLive(options: { phone?: boolean; initial?: InboxMessageWire[] } = {}) {
  served = options.initial ?? sample();
  pickBodies = [];
  servePicks();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Live initial={served} phone={options.phone} />);
  });
  await settle();
  return host;
}

describe('the select mode\'s rules (skipSelection, skipAllCandidates)', () => {
  const qs = threadOpenQuestions(
    sample().map((m) =>
      m.id === M2 ? { ...m, questions: m.questions!.map((q) => ({ ...q, state: 'picked' as const, answer: { v: 1 as const, key: q.key, kind: 'single' as const, prompt: q.prompt, selected: [], skipped: true } })) } : m,
    ),
  ).questions;
  const idOf = (m: string) => qs.find((q) => q.messageId === m)!.id;
  test('a ticked question is skipped, a ticked skipped one unskipped; unticked ones are left alone', () => {
    const { skip, unskip } = skipSelection(qs, new Set([idOf(M2), idOf(M6)]));
    expect(skip.map((q) => q.messageId)).toEqual([M6]);
    expect(unskip.map((q) => q.messageId)).toEqual([M2]);
  });
  test('"Skip all" covers the open questions with nothing picked: not a draft pick, not a skip', () => {
    expect(skipAllCandidates(qs).map((q) => q.messageId)).toEqual([M3, M6]);
  });
});

const skipMode = () => list()?.querySelector<HTMLElement>('[data-open-questions-skip-mode]') ?? null;
const applyButton = () => list()?.querySelector<HTMLElement>('[data-open-questions-apply]') ?? null;
const cancelButton = () => list()?.querySelector<HTMLElement>('[data-open-questions-cancel]') ?? null;
const skipAllButton = () => list()?.querySelector<HTMLElement>('[data-open-questions-skip-all]') ?? null;
const rowOf = (messageId: string) => list()?.querySelector<HTMLElement>(`[data-open-question^="${messageId}/"]`) ?? null;
const selecting = () => rows().length > 0 && rows().every((r) => r.getAttribute('role') === 'menuitemcheckbox');
/** What the card of M6's question shows: its tag, its Skip button, its footer. */
function cardState(el: HTMLElement) {
  const card = el.querySelector<HTMLElement>(`[data-message-id="${M6}"] [data-question-key]`)!;
  const skip = [...card.querySelectorAll('button')].find((b) => /^(Un)?[Ss]kip$/.test(b.textContent?.trim() ?? ''))!;
  return { text: card.textContent, skip: skip.textContent?.trim(), pressed: skip.getAttribute('aria-pressed') };
}
const keyOn = async (k: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

/** M2's question already skipped in the draft (a pick marked skipped, as the card's Skip saves it). */
const withM2Skipped = (messages: InboxMessageWire[]) =>
  messages.map((m) =>
    m.id !== M2
      ? m
      : { ...m, questions: m.questions!.map((q) => ({ ...q, state: 'picked' as const, revision: 1, answer: { v: 1 as const, key: q.key, kind: 'single' as const, prompt: q.prompt, selected: [], skipped: true } })) },
  );

test.skipIf(!hasDom)('at rest: no Skip on any row; the last row is Re-ask and "Skip…"; a skipped row is quiet', async () => {
  await renderLive({ initial: withM2Skipped(sample()) });
  await openList();
  expect(list()!.querySelector('[data-open-question-skip], .ib-oq-skip')).toBeNull();
  // Every menu item: the four rows, then Re-ask and "Skip…" on one last row.
  const items = [...list()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((n) => (n.hasAttribute('data-reask') ? 'reask' : n.hasAttribute('data-open-questions-skip-mode') ? 'skip…' : 'row'))).toEqual(['row', 'row', 'row', 'row', 'reask', 'skip…']);
  expect(skipMode()!.textContent).toBe('Skip…');
  expect(skipMode()!.closest('.ib-oq-last') === reaskItem()!.closest('.ib-oq-last')).toBe(true);
  expect(document.getElementById(skipMode()!.getAttribute('aria-describedby')!)?.textContent).toBe('Choose questions to skip. Skips ride your next Send.');
  // The skipped row: the skip glyph in place of its number, "Skipped · time · place", never "Draft · Skipped".
  const skipped = rowOf(M2)!;
  expect(skipped.hasAttribute('data-skipped')).toBe(true);
  expect(skipped.querySelector('.ib-oq-n svg')).not.toBeNull();
  expect(skipped.querySelector('.ib-oq-n')!.textContent).toBe('');
  expect(skipped.querySelector('.ib-oq-skipped')!.textContent).toBe('Skipped');
  expect(skipped.querySelector('.ib-oq-draft')).toBeNull();
  expect(skipped.getAttribute('aria-label')).toMatch(/^How many times should a rate-limited charge be retried\?\. Skipped\. /);
  // The others keep their numbers.
  expect(rowOf(M3)!.querySelector('.ib-oq-n')!.textContent).toBe('2');
  expect(rowOf(M3)!.hasAttribute('data-skipped')).toBe(false);
});

test.skipIf(!hasDom)('"Skip…" enters select mode; ticks save nothing; "Skip 2" saves two skips, what the card\'s Skip saves', async () => {
  // The card's own Skip first, for what a skip saves.
  let el = await renderLive();
  const cardSkip = [...el.querySelectorAll<HTMLButtonElement>(`[data-message-id="${M6}"] [data-question-key] button`)].find((b) => b.textContent?.trim() === 'Skip')!;
  await act(async () => cardSkip.click());
  await until(() => pickBodies.length === 1, 'the card pick');
  await until(() => cardState(el).skip === 'Unskip', 'the card skipped');
  const byCard = { pick: pickBodies[0]!, card: cardState(el) };
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;

  el = await renderLive();
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  // The numbers are checks now; nothing is ticked; the bar replaces the last row.
  expect(rows().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(rows().every((r) => r.querySelector('.ib-oq-ck') && !r.querySelector('.ib-oq-n'))).toBe(true);
  expect(list()!.querySelector('[data-open-questions-select-head]')!.textContent).toBe('Select questions to skip');
  expect(reaskItem()).toBeNull();
  expect(skipMode()).toBeNull();
  expect(cancelButton()!.textContent).toBe('Cancel');
  expect(skipAllButton()!.textContent).toBe('Skip all 3');
  expect(applyButton()!.textContent).toBe('Skip');
  expect(applyButton()!.hasAttribute('data-disabled')).toBe(true);
  // Tick two: still nothing saved.
  await press(rowOf(M2)!);
  await press(rowOf(M6)!);
  await until(() => rowOf(M6)!.getAttribute('aria-checked') === 'true', 'the ticks');
  expect(rowOf(M2)!.getAttribute('aria-checked')).toBe('true');
  expect(list()!.querySelector('[data-open-questions-select-head]')!.textContent).toBe('2 selected');
  expect(applyButton()!.textContent).toBe('Skip 2');
  await settle();
  expect(pickBodies).toHaveLength(0);
  // The button saves both, and select mode ends with the list still open, focus on "Skip…".
  await press(applyButton()!);
  await until(() => pickBodies.length === 2, 'the two skips');
  expect(pickBodies.map((b) => [b.messageId, b.answer?.skipped, b.answer?.selected])).toEqual([
    [M2, true, []],
    [M6, true, []],
  ]);
  expect(pickBodies[1]).toEqual(byCard.pick);
  await until(() => !selecting() && !!skipMode(), 'back at rest');
  expect(list()).not.toBeNull();
  await until(() => document.activeElement === skipMode(), 'focus on Skip…');
  await until(() => rowOf(M2)!.hasAttribute('data-skipped') && rowOf(M6)!.hasAttribute('data-skipped'), 'the rows quiet');
  // The card ends as its own Skip leaves it; nothing was sent.
  await until(() => cardState(el).skip === 'Unskip', 'the card skipped from the list');
  expect(cardState(el)).toEqual(byCard.card);
  expect(button()!.textContent?.trim()).toBe('4 open questions');
});

test.skipIf(!hasDom)('Cancel and Escape drop the ticks; Escape leaves select mode before it closes the list', async () => {
  const escapes: boolean[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') escapes.push(e.defaultPrevented);
  };
  window.addEventListener('keydown', onKey);
  try {
    await renderLive();
    await openList();
    // Cancel.
    await press(skipMode()!);
    await until(selecting, 'select mode');
    await press(rowOf(M3)!);
    await until(() => rowOf(M3)!.getAttribute('aria-checked') === 'true', 'the tick');
    await press(cancelButton()!);
    await until(() => !selecting(), 'Cancel leaves select mode');
    expect(list()).not.toBeNull();
    // Escape.
    await press(skipMode()!);
    await until(selecting, 'select mode again');
    expect(rowOf(M3)!.getAttribute('aria-checked')).toBe('false');
    await press(rowOf(M3)!);
    await until(() => rowOf(M3)!.getAttribute('aria-checked') === 'true', 'the tick again');
    await keyOn('Escape');
    await until(() => !selecting(), 'Escape leaves select mode');
    expect(list()).not.toBeNull();
    // That Escape never reached the window unused (the window would close the thread on it).
    expect(escapes.every(Boolean)).toBe(true);
    await until(() => document.activeElement === skipMode(), 'focus on Skip…');
    await keyOn('Escape');
    await until(() => !list(), 'the second Escape closes the list');
    await settle();
    expect(pickBodies).toHaveLength(0);
  } finally {
    window.removeEventListener('keydown', onKey);
  }
});

test.skipIf(!hasDom)('"Skip all" skips the open questions with nothing picked; a draft pick stays', async () => {
  await renderLive();
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  await press(skipAllButton()!);
  await until(() => pickBodies.length === 3, 'three skips');
  expect(pickBodies.map((b) => [b.messageId, b.answer?.skipped])).toEqual([
    [M2, true],
    [M3, true],
    [M6, true],
  ]);
  await until(() => !selecting(), 'back at rest');
  // M5 kept its pick.
  expect(rowOf(M5)!.querySelector('.ib-oq-draft')!.textContent).toBe('Draft · Yes');
  expect(rowOf(M5)!.hasAttribute('data-skipped')).toBe(false);
});

test.skipIf(!hasDom)('Unskip: a ticked skipped row and "Unskip 1" take the skip back', async () => {
  await renderLive({ initial: withM2Skipped(sample()) });
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  // In select mode a skipped row keeps its prompt readable and says Skipped.
  expect(rowOf(M2)!.querySelector('.ib-oq-skipped')!.textContent).toBe('Skipped');
  await press(rowOf(M2)!);
  await until(() => applyButton()!.textContent === 'Unskip 1', 'the Unskip button');
  await press(applyButton()!);
  await until(() => pickBodies.length === 1, 'the unskip');
  expect(pickBodies[0]!.messageId).toBe(M2);
  expect(pickBodies[0]!.answer).toBeNull();
  await until(() => !selecting() && !rowOf(M2)!.hasAttribute('data-skipped'), 'row M2 open again');
  expect(rowOf(M2)!.querySelector('.ib-oq-n')!.textContent).toBe('1');
});

test.skipIf(!hasDom)('the keyboard: the arrows reach "Skip…", Enter enters select mode, Space ticks, Escape leaves', async () => {
  await renderLive();
  const b = button()!;
  await act(async () => b.focus());
  await act(async () => {
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => !!list(), 'the list from the keyboard');
  const items = () => [...list()!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
  const highlighted = () => items().find((n) => n.hasAttribute('data-highlighted')) ?? null;
  await until(() => !!highlighted(), 'a highlighted item');
  for (let i = 0; i < 10 && highlighted() !== skipMode(); i += 1) await keyOn('ArrowDown');
  expect(highlighted() === skipMode()).toBe(true);
  await keyOn('Enter');
  await until(selecting, 'select mode from Enter');
  await until(() => document.activeElement === rowOf(M2), 'focus on the first row');
  await keyOn(' ');
  await until(() => rowOf(M2)!.getAttribute('aria-checked') === 'true', 'Space ticks');
  await keyOn('ArrowDown');
  await until(() => highlighted() === rowOf(M3), 'the next row');
  await keyOn(' ');
  await until(() => rowOf(M3)!.getAttribute('aria-checked') === 'true', 'Space ticks again');
  expect(applyButton()!.textContent).toBe('Skip 2');
  await keyOn('Escape');
  await until(() => !selecting(), 'Escape leaves select mode');
  await until(() => document.activeElement === skipMode(), 'focus back on Skip…');
  expect(list()).not.toBeNull();
  await settle();
  expect(pickBodies).toHaveLength(0);
});

test.skipIf(!hasDom)('type-ahead goes by the question: "s" lands on "Ship the retry worker…"', async () => {
  await renderLive();
  const b = button()!;
  await act(async () => b.focus());
  await act(async () => {
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => !!list(), 'the list from the keyboard');
  const items = () => [...list()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  await until(() => items().some((r) => r.hasAttribute('data-highlighted')), 'a highlighted item');
  await keyOn('s');
  await until(() => {
    const h = items().find((r) => r.hasAttribute('data-highlighted'));
    return !!h && h.hasAttribute('data-open-question') && /Ship the retry worker/.test(h.textContent ?? '');
  }, 'type-ahead on the question');
});

test.skipIf(!hasDom)('on a phone: the sheet has "Skip…"; in select mode "Skip all" sits at the top and the bar is Cancel and the button', async () => {
  await renderLive({ phone: true });
  await openList();
  expect(list()!.closest('.ib-oq-pos')!.hasAttribute('data-phone')).toBe(true);
  expect(list()!.querySelector('[data-open-question-skip]')).toBeNull();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  expect(skipAllButton()!.closest('[data-open-questions-select-head]')).not.toBeNull();
  const bar = list()!.querySelector('[data-open-questions-select-bar]')!;
  expect([...bar.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual(['Cancel', 'Skip']);
  await press(rowOf(M3)!);
  await until(() => applyButton()!.textContent === 'Skip 1', 'Skip 1');
  await press(applyButton()!);
  await until(() => pickBodies.length === 1, 'the skip');
  expect(pickBodies[0]!.messageId).toBe(M3);
  expect(list()).not.toBeNull();
});

test.skipIf(!hasDom)('on a phone: Close leaves select mode; the list opens again at rest with no ticks', async () => {
  await renderLive({ phone: true });
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  await press(rowOf(M3)!);
  await until(() => rowOf(M3)!.getAttribute('aria-checked') === 'true', 'the tick');
  await press(list()!.querySelector<HTMLElement>('[data-open-questions-close]')!);
  await until(() => !list(), 'Close closes the sheet');
  await openList();
  expect(selecting()).toBe(false);
  expect(list()!.querySelector('[data-open-questions-select-head]')).toBeNull();
  expect(rows().some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false);
  expect(skipMode()).not.toBeNull();
  expect(list()!.getAttribute('aria-label')).toBe('4 open questions in this thread');
  // Into select mode again: nothing is ticked.
  await press(skipMode()!);
  await until(selecting, 'select mode again');
  expect(rows().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(applyButton()!.textContent).toBe('Skip');
  await settle();
  expect(pickBodies).toHaveLength(0);
});

test.skipIf(!hasDom)('"Skip all" covers only the questions open when select mode began, not one that lands meanwhile', async () => {
  await renderLive();
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  expect(skipAllButton()!.textContent).toBe('Skip all 3');
  const M7 = id(7);
  await act(async () => addMessage!({ ...agent(7, `New.\n\n${block('Rename the retry queue?')}`, 7), id: M7, questions: questionsOf(M7, block('Rename the retry queue?')) }));
  await until(() => !!rowOf(M7), 'the new question listed');
  expect(skipAllButton()!.textContent).toBe('Skip all 3');
  await press(skipAllButton()!);
  await until(() => pickBodies.length === 3, 'three skips');
  await settle();
  expect(pickBodies.map((b) => b.messageId)).toEqual([M2, M3, M6]);
  expect(rowOf(M7)!.hasAttribute('data-skipped')).toBe(false);
});

test.skipIf(!hasDom)('screen readers: the menu is named for select mode, and the count is said in a polite live region', async () => {
  await renderLive();
  await openList();
  const live = () => document.querySelector<HTMLElement>('[data-open-questions-select-live]');
  expect(live()!.getAttribute('aria-live')).toBe('polite');
  expect(live()!.closest('[role="menu"]')).toBeNull();
  expect(live()!.textContent).toBe('');
  await press(skipMode()!);
  await until(selecting, 'select mode');
  expect(list()!.getAttribute('aria-label')).toBe('Select questions to skip');
  await press(rowOf(M3)!);
  await until(() => live()!.textContent === '1 selected', 'one selected, said');
  await press(rowOf(M6)!);
  await until(() => live()!.textContent === '2 selected', 'two selected, said');
  await press(cancelButton()!);
  await until(() => !selecting(), 'back at rest');
  expect(list()!.getAttribute('aria-label')).toBe('4 open questions in this thread');
  expect(live()!.textContent).toBe('');
});

test.skipIf(!hasDom)('"Skip 1, unskip 1": a skipped row and an open row ticked; both picks are saved', async () => {
  await renderLive({ initial: withM2Skipped(sample()) });
  await openList();
  await press(skipMode()!);
  await until(selecting, 'select mode');
  await press(rowOf(M2)!);
  await press(rowOf(M3)!);
  await until(() => applyButton()!.textContent === 'Skip 1, unskip 1', 'the combined button');
  await settle();
  expect(pickBodies).toHaveLength(0);
  await press(applyButton()!);
  await until(() => pickBodies.length === 2, 'the two picks');
  const byMessage = new Map(pickBodies.map((b) => [b.messageId, b]));
  expect(byMessage.get(M3)!.answer?.skipped).toBe(true);
  expect(byMessage.get(M3)!.answer?.selected).toEqual([]);
  expect(byMessage.get(M2)!.answer).toBeNull();
  await until(() => !selecting() && rowOf(M3)!.hasAttribute('data-skipped') && !rowOf(M2)!.hasAttribute('data-skipped'), 'the rows follow');
});

// ── The draft status in the foot (DraftFootNote): what step 4 of the row keeps ──

/** The words a screen reader gets from an element: its text without aria-hidden parts (visually hidden text included). */
function spokenText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function renderDraftFoot(unsent: { reply: boolean; picks: number; comments: number }) {
  const { DraftFootNote } = await import('./components/DraftLabel');
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<DraftFootNote id="draft-note" unsent={unsent} />);
  });
  return host.querySelector<HTMLElement>('[data-draft-foot]')!;
}

test.skipIf(!hasDom)('the draft status keeps its pick words and its comment count apart; the pill carries the count for step 4', async () => {
  const foot = await renderDraftFoot({ reply: false, picks: 1, comments: 3 });
  expect(foot.querySelector('[data-draft-words]')!.textContent).toBe('1 pick');
  expect(foot.querySelector('[data-draft-comments]')!.textContent).toBe('3 comments');
  // The pill's count (shown at step 4 as a glyph and the number) is hidden from screen readers.
  const count = foot.querySelector('.ib-draft-pill [data-draft-pill-count]')!;
  expect(count.getAttribute('aria-hidden')).toBe('true');
  expect(count.textContent).toBe('3');
  expect(count.querySelector('svg')).not.toBeNull();
  // What Send and Edit draft are described by says everything, whatever step 4 hides.
  expect(spokenText(foot)).toBe('Draft, 1 pick, 3 comments');
});

test.skipIf(!hasDom)('with no comments the pill carries no count: step 4 shows "Draft" alone', async () => {
  const foot = await renderDraftFoot({ reply: true, picks: 2, comments: 0 });
  expect(foot.querySelector('[data-draft-pill-count]')).toBeNull();
  expect(foot.querySelector('[data-draft-comments]')).toBeNull();
  expect(spokenText(foot)).toBe('Draft, Your reply, 2 picks');
});

test.skipIf(!hasDom)('comments alone: the words are the count, and the pill carries it too', async () => {
  const foot = await renderDraftFoot({ reply: false, picks: 0, comments: 1 });
  expect(foot.querySelector('[data-draft-words]')).toBeNull();
  expect(foot.querySelector('[data-draft-pill-count]')!.textContent).toBe('1');
  expect(spokenText(foot)).toBe('Draft, 1 comment');
});
