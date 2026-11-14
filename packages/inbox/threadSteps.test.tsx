/**
 * Thread steps in the window (approval "inbox-thread-steps", 2026-11-03, A1 "Linear"):
 *
 *  - the rules (steps/model.ts): what a row says at its right (a done step's time, a note, "Waiting on you"),
 *    "3/6" counting no dropped step, "as of" only once the session ended, where "Waiting on you ›" goes (that
 *    session's open question, else its action item, else any), and the pie's wedge;
 *  - the thread's foot (ThreadPane): no button while the switch is off (and no read), "◑ 3/6" beside the open
 *    questions while it is on, the popover's rows in their states, the presence class that turns the in-progress
 *    mark, "Waiting on you ›" closing the list and ringing the question, a phone's sheet with its close;
 *  - live: a steps change for this thread (or every thread) reads again; another thread's does not, and an older
 *    answer never lands over a newer one;
 *  - the wire: `event: capabilities` reaches the window's handler.
 *
 * What regresses: steps shown (or read) with the switch off, a dropped step counted, a dead session's mark still
 * turning or no "as of", the waiting row going nowhere or to another agent's question, a list that never updates,
 * and a window that misses another window's switch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxListRow, InboxMessageWire, InboxProject, InboxQuestion, InboxStepsWire, InboxThread } from '@plannotator/core/inbox-types';
import type { OpenActionItem, OpenQuestion } from '@plannotator/core/inbox-open-questions';
import { dispatchInboxFrame, type InboxEventHandlers } from './api';
import { pieGeometry, stepMeta, stepsAsOf, stepsButtonList, stepsButtonMark, stepsButtonSig, stepsCount, stepsListLabels, stepsListWaits, stepsName, stepsWaitingNameTail, stepsWaitTarget, threadBoardCard } from './steps/model';
import { createStepsBus } from './steps/useThreadSteps';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-10-22T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const B: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'codex', session: 'ses_b', name: null };
const id = (n: number) => `msg_01M5ST0000000000000000000${n}`;
const [M1, M2, M3] = [1, 2, 3].map(id) as [string, string, string];
const block = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

function message(n: number, author: InboxAuthor, body: string): InboxMessageWire {
  const messageId = id(n);
  const questions: InboxQuestion[] = parseInboxQuestionBlocks(body).map((q) => ({
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
    asked_by_agent_id: author.kind === 'agent' ? author.session : null,
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
  return {
    id: messageId,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: n === 1 ? null : M1,
    author,
    subject: n === 1 ? 'Retry worker for failed Stripe charges' : null,
    body,
    created_at: `2026-10-22T${String(9 + n).padStart(2, '0')}:15:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: n,
    ...(n === 1 ? { person_seen_seq: 3 } : {}),
    ...(questions.length > 0 ? { questions } : {}),
  };
}

/** Codex asks first (M2), Claude Code asks last (M3): "Waiting on you" from Claude Code's list must go to M3. */
const THREAD: InboxThread = {
  thread_id: M1,
  project: PROJECT,
  subject: 'Retry worker for failed Stripe charges',
  thread_name: null,
  resolved_at: null,
  messages: [message(1, A, 'Starting the retry worker.'), message(2, B, `Codex here.\n\n${block('Which region first?')}`), message(3, A, `Replay is running.\n\n${block('Ship the retry worker behind a flag?')}`)],
};

const NOW = new Date('2026-11-03T14:50:00');
const at = (h: number, m: number) => new Date(2026, 10, 3, h, m).toISOString();
function list(presence: InboxStepsWire['presence'], author = A): InboxStepsWire {
  return {
    id: `stp_${author.session}`,
    project_id: PROJECT.id,
    thread_id: M1,
    agent: author,
    updated_at: at(14, 40),
    presence,
    steps: [
      { step: 'Classify 30 days of failed charges', status: 'done', note: null, at: at(11, 5) },
      { step: 'Retry worker on pg-boss', status: 'done', note: null, at: at(13, 12) },
      { step: 'Replay the failures in staging', status: 'done', note: null, at: at(14, 44) },
      { step: 'Ship it behind a flag', status: 'waiting', note: null, at: at(14, 40) },
      { step: 'Admin retry view', status: 'doing', note: 'Starting the table', at: at(14, 44) },
      { step: 'On-call runbook entry', status: 'todo', note: null, at: at(9, 12) },
      { step: 'Retry Stripe 409s', status: 'dropped', note: 'Stripe settles them', at: at(14, 40) },
    ],
  };
}

/** The same list with the given statuses, in order (fewer steps than the list's seven). */
function withStatuses(statuses: InboxStepsWire['steps'][number]['status'][], presence: InboxStepsWire['presence'] = 'working'): InboxStepsWire {
  const base = list(presence);
  return { ...base, steps: statuses.map((status, i) => ({ ...base.steps[i]!, status })) };
}

describe('the rules (steps/model.ts)', () => {
  test('a row\'s right side: a done step\'s time, a note for the others, "Waiting on you" for a waiting one', () => {
    const steps = list('working').steps;
    expect(steps.map((s) => stepMeta(s, NOW))).toEqual([
      { kind: 'time', text: '11:05 AM', title: '11:05 AM' },
      { kind: 'time', text: '1:12 PM', title: '1:12 PM' },
      { kind: 'time', text: '2:44 PM', title: '2:44 PM' },
      { kind: 'waiting' },
      { kind: 'note', text: 'Starting the table' },
      null,
      { kind: 'note', text: 'Stripe settles them' },
    ]);
  });

  test('the head\'s Board icon opens a card that links the thread, never a cancelled one', () => {
    const cards = [
      { id: 'crd_dropped', column: 'dropped', threads: [M1] },
      { id: 'crd_live', column: 'in_progress', threads: ['msg_other', M1] },
    ];
    expect(threadBoardCard(cards, M1)?.id).toBe('crd_live');
    expect(threadBoardCard(cards.slice(0, 1), M1)).toBeNull();
  });

  // Review of #2571, finding 2: two sessions of one agent must not read the same.
  test('heads: each agent\'s name; two sessions of one agent numbered in the order their lists began, kept as they tick', () => {
    const second = { ...list('working'), id: 'stp_02', agent: { ...A, session: 'ses_a2' } };
    const first = { ...list('idle'), id: 'stp_01' };
    const codex = { ...list('idle', B), id: 'stp_03' };
    expect(stepsListLabels([second, first, codex])).toEqual(['Claude Code · 2', 'Claude Code · 1', 'Codex']);
    expect(stepsListLabels([first, second])).toEqual(['Claude Code · 1', 'Claude Code · 2']);
    expect(stepsListLabels([first, codex])).toEqual(['Claude Code', 'Codex']);
  });

  test('"3/6": a dropped step is not counted; the name says whose and how far', () => {
    expect(stepsCount(list('working'))).toEqual({ done: 3, total: 6, text: '3/6' });
    expect(stepsName('Claude Code', list('working'))).toBe("Claude Code's checklist: 3 of 6 steps done");
  });

  test('"as of" only once the session ended, at the list\'s last word', () => {
    expect(stepsAsOf(list('working'), NOW)).toBeNull();
    expect(stepsAsOf(list('idle'), NOW)).toBeNull();
    expect(stepsAsOf(list('ended'), NOW)).toBe('2:40 PM');
  });

  test('"Waiting on you" goes to that session\'s open question, else its action item, else any open ask, else nowhere', () => {
    const q = (messageId: string, key: string) => ({ messageId, key }) as OpenQuestion;
    const a = (messageId: string, key: string) => ({ messageId, key }) as OpenActionItem;
    const sessionOf = (messageId: string) => (messageId === M2 ? 'ses_b' : 'ses_a');
    expect(stepsWaitTarget('ses_a', [q(M2, 'q-b'), q(M3, 'q-a')], [], sessionOf)).toEqual({ kind: 'question', messageId: M3, key: 'q-a' });
    expect(stepsWaitTarget('ses_a', [q(M2, 'q-b')], [a(M3, 'a-a')], sessionOf)).toEqual({ kind: 'action', messageId: M3, key: 'a-a' });
    expect(stepsWaitTarget('ses_a', [q(M2, 'q-b')], [], sessionOf)).toEqual({ kind: 'question', messageId: M2, key: 'q-b' });
    expect(stepsWaitTarget('ses_a', [], [], sessionOf)).toBeNull();
  });

  test('the pie: no wedge at none, a wedge past the half takes the large arc, a full disc at all', () => {
    expect(pieGeometry(0, 6, 13)).toMatchObject({ path: null, full: false });
    expect(pieGeometry(6, 6, 13)).toMatchObject({ path: null, full: true });
    expect(pieGeometry(2, 6, 13).path).toMatch(/A[\d.]+ [\d.]+ 0 0 1 /);
    expect(pieGeometry(4, 6, 13).path).toMatch(/A[\d.]+ [\d.]+ 0 1 1 /);
  });
});

// The foot button's mark (approval "inbox-checklist-spinners-2026-11-07", mock 1 and its 11:25Z addendum).
describe('the button (steps/model.ts)', () => {
  test('its mark: the amber pause while a step waits, else the spinner while one is worked on, else the pie (fresh, all done); a dropped step never counts', () => {
    expect(stepsButtonMark(withStatuses(['todo', 'todo', 'todo']))).toBeNull();
    expect(stepsButtonMark(withStatuses(['done', 'doing', 'todo']))).toBe('doing');
    expect(stepsButtonMark(withStatuses(['done', 'doing', 'waiting']))).toBe('waiting');
    expect(stepsButtonMark(withStatuses(['done', 'dropped', 'done']))).toBeNull();
    expect(stepsCount(withStatuses(['done', 'dropped', 'doing'])).text).toBe('1/2');
  });

  test('it shows a list that waits on the person first, else the newest', () => {
    const working = withStatuses(['done', 'doing']);
    const waiting = { ...withStatuses(['waiting']), id: 'stp_w' };
    expect(stepsButtonList([working, waiting])?.id).toBe('stp_w');
    expect(stepsButtonList([working])).toBe(working);
    expect(stepsButtonList([])).toBeNull();
  });

  // Review 2 of #2847: the button waits by the server's rule (`inboxStepsWaitOnPerson`).
  test('the waiting rule: never an ended session\'s list, never once the person answered (a reply or a 👍) since the list was written', () => {
    const waiting = withStatuses(['done', 'waiting', 'doing']);
    const answered = (when: string) => (since: string) => Date.parse(when) >= Date.parse(since);
    expect(stepsListWaits(waiting)).toBe(true);
    expect(stepsListWaits({ ...waiting, presence: 'ended' })).toBe(false);
    expect(stepsListWaits(waiting, answered(at(14, 45)))).toBe(false);
    expect(stepsListWaits(waiting, answered(at(14, 40)))).toBe(false);
    expect(stepsListWaits(waiting, answered(at(14, 30)))).toBe(true);
    // Answered: the spinner of the step still worked on, and no "waiting on you" in the name.
    expect(stepsButtonMark(waiting, answered(at(14, 45)))).toBe('doing');
    expect(stepsWaitingNameTail(waiting)).toBe('; waiting on you: Retry worker on pg-boss');
    expect(stepsWaitingNameTail(waiting, answered(at(14, 45)))).toBe('');
    expect(stepsButtonMark({ ...waiting, presence: 'ended' })).toBe('doing');
  });

  test('an ended session\'s old waiting list never beats a live one on the button', () => {
    const live = { ...withStatuses(['done', 'waiting']), id: 'stp_live', agent: B };
    const stale = { ...withStatuses(['waiting', 'todo'], 'ended'), id: 'stp_ended' };
    expect(stepsButtonList([stale, live])?.id).toBe('stp_live');
    expect(stepsButtonMark(stepsButtonList([stale, live])!)).toBe('waiting');
    // Only the ended one: the newest shows, with no amber.
    expect(stepsButtonList([stale])?.id).toBe('stp_ended');
    expect(stepsButtonMark(stale)).toBeNull();
  });

  test('the button\'s key changes with what it shows: another list winning, the count, the mark, "as of", "+1"', () => {
    const one = withStatuses(['done', 'doing', 'todo']);
    const other = { ...withStatuses(['waiting']), id: 'stp_w' };
    const sig = stepsButtonSig([one]);
    expect(stepsButtonSig([one])).toBe(sig);
    expect(stepsButtonSig([])).toBe('');
    expect(stepsButtonSig([one, other])).not.toBe(sig);
    expect(stepsButtonSig([one, { ...other, presence: 'ended' }])).not.toBe(sig);
    expect(stepsButtonSig([{ ...one, presence: 'ended' }])).not.toBe(sig);
    expect(stepsButtonSig([withStatuses(['done', 'done', 'doing'])])).not.toBe(sig);
    expect(stepsButtonSig([withStatuses(['done', 'waiting', 'todo'])])).not.toBe(sig);
  });
});

describe('the wire', () => {
  test('`event: capabilities` reaches the window with the switch; a malformed one says nothing about it', () => {
    const heard: unknown[] = [];
    const handlers: InboxEventHandlers = { onRecord: () => {}, onStatus: () => {}, onCapabilities: (c) => void heard.push(c) };
    dispatchInboxFrame({ name: 'capabilities', id: null, data: JSON.stringify({ steps: { on: true } }) }, handlers);
    dispatchInboxFrame({ name: 'capabilities', id: null, data: JSON.stringify({ steps: { on: 'yes' } }) }, handlers);
    dispatchInboxFrame({ name: 'capabilities', id: null, data: '{' }, handlers);
    expect(heard).toEqual([{ steps: { on: true } }, {}]);
  });
});

// ── The window ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** What the steps read answers, and how many times it was asked. */
let answer: () => Promise<Response>;
let stepsReads = 0;

beforeEach(() => {
  if (!hasDom) return;
  stepsReads = 0;
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [list('working')] });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/steps')) {
      stepsReads += 1;
      return answer();
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[data-steps-panel]').forEach((n) => n.closest('.ib-st-pos')?.remove());
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
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(options: { on?: boolean; phone?: boolean; bus?: ReturnType<typeof createStepsBus>; boardCard?: { title: string; onOpen: () => void } | null; thread?: InboxThread; onAck?: () => void } = {}) {
  const bus = options.bus ?? createStepsBus();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={options.thread ?? THREAD}
        onAck={options.onAck}
        threadSteps={{ on: options.on ?? true, subscribe: bus.subscribe, boardCard: options.boardCard ?? null }}
        sent={null}
        lookSeq={3}
        phone={options.phone === true}
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
  return { el: host, bus };
}

const button = () => document.querySelector<HTMLButtonElement>('[data-steps-button]');
const panel = () => document.querySelector<HTMLElement>('[data-steps-panel]');
const rows = () => [...(panel()?.querySelectorAll<HTMLElement>('.ib-st-row') ?? [])];

async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

async function openPanel() {
  await press(button()!);
  await until(() => !!panel(), 'the steps panel');
}

test.skipIf(!hasDom)('off: no button, and the steps are never read', async () => {
  await render({ on: false });
  await settle();
  expect(button()).toBeNull();
  expect(stepsReads).toBe(0);
});

test.skipIf(!hasDom)('on: "3/6" after the open questions, named for whose steps, with the amber pause while a step waits; a list cleared to nothing shows no button', async () => {
  const { el } = await render();
  await until(() => !!button(), 'the steps button');
  const foot = [...el.querySelectorAll<HTMLElement>('[data-foot-buttons] > *')];
  const oq = foot.findIndex((n) => n.hasAttribute('data-open-questions'));
  expect(oq).toBeGreaterThanOrEqual(0);
  expect(foot[oq + 1]).toBe(button()!);
  expect(button()!.textContent).toBe('3/6');
  expect(button()!.getAttribute('aria-label')).toBe("Claude Code's checklist: 3 of 6 steps done; waiting on you: Ship it behind a flag");
  // A step waits on the person (and another is worked on): the button wears the amber pause, not the pie.
  expect(button()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe('waiting');
  expect(button()!.querySelector('[data-steps-pie]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [{ ...list('working'), steps: [] }] });
  await render();
  await until(() => stepsReads >= 2, 'the second read');
  await settle();
  expect(button()).toBeNull();
});

test.skipIf(!hasDom)('the panel: "Checklist 3/6", one row per step in its state, times and notes at the right; the mark turns while the session works', async () => {
  await render();
  await until(() => !!button(), 'the steps button');
  await openPanel();
  const head = panel()!.querySelector('[data-steps-head]')!;
  expect(head.textContent).toBe('Checklist3/6');
  // "Checklist" is never cut, so no tooltip repeats it.
  expect(head.querySelector('.ib-st-lbl')!.hasAttribute('title')).toBe(false);
  expect(panel()!.querySelector('[data-steps-as-of]')).toBeNull();
  expect(rows().map((r) => [r.dataset.stepStatus, r.querySelector('.ib-st-t')!.textContent, r.querySelector('.ib-st-m')?.textContent ?? ''])).toEqual([
    ['done', 'Classify 30 days of failed charges', expect.stringMatching(/^11:05 AM$|^Nov 3$/)],
    ['done', 'Retry worker on pg-boss', expect.any(String)],
    ['done', 'Replay the failures in staging', expect.any(String)],
    ['waiting', 'Ship it behind a flag', 'Waiting on you'],
    ['doing', 'Admin retry view', 'Starting the table'],
    ['todo', 'On-call runbook entry', ''],
    ['dropped', 'Retry Stripe 409s', 'Stripe settles them'],
  ]);
  expect(rows()[6]!.getAttribute('aria-label')).toBe('Retry Stripe 409s, dropped: Stripe settles them');
  expect(panel()!.querySelector('[data-steps-group]')!.className).toContain('ib-st-working');
});

test.skipIf(!hasDom)('an ended session: the mark stops (no working class), and the button and the head say "as of"', async () => {
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [list('ended')] });
  await render();
  await until(() => !!button(), 'the steps button');
  // The owner (approval addendum): "2/4 · as of 2:40 PM" on the button too; its name says it.
  expect(button()!.className).toContain('ib-st-ended');
  expect(button()!.className).not.toContain('ib-st-working');
  expect(button()!.querySelector('[data-steps-as-of]')!.textContent).toMatch(/^as of /);
  expect(button()!.getAttribute('aria-label')).toMatch(/^Claude Code's checklist: 3 of 6 steps done, as of .+/);
  await openPanel();
  const group = panel()!.querySelector<HTMLElement>('[data-steps-group]')!;
  expect(group.className).toContain('ib-st-ended');
  expect(group.className).not.toContain('ib-st-working');
  expect(panel()!.querySelector('[data-steps-as-of]')!.textContent).toMatch(/^as of /);
});

test.skipIf(!hasDom)('"Waiting on you ›" closes the list and rings the question of that session, not another agent\'s', async () => {
  const { el } = await render();
  await until(() => !!button(), 'the steps button');
  await openPanel();
  await act(async () => panel()!.querySelector<HTMLButtonElement>('[data-steps-waiting]')!.click());
  await until(() => !panel(), 'the panel to close');
  await until(() => !!el.querySelector(`[data-message-id="${M3}"] [data-question-key].ib-q-target`), "Claude Code's question ringed");
  expect(el.querySelector(`[data-message-id="${M2}"] [data-question-key].ib-q-target`)).toBeNull();
});

// Review 2 of #2847: the button waits by the row's rule; a 👍 Looks good (or a reply) after the list is an answer.
test.skipIf(!hasDom)('answered: a 👍 on the agent\'s message after the list was written ends the amber and the name\'s "waiting on you"; one from before does not', async () => {
  const acked = (when: string): InboxThread => ({
    ...THREAD,
    messages: THREAD.messages.map((m, i) => (i === 2 ? { ...m, ack: { label: 'Looks good', at: when, read_seq: 3 } } : m)),
  });
  await render({ thread: acked(at(14, 45)) });
  await until(() => !!button(), 'the steps button');
  expect(button()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe('doing');
  expect(button()!.getAttribute('aria-label')).toBe("Claude Code's checklist: 3 of 6 steps done");
  act(() => root?.unmount());
  host?.remove();
  await render({ thread: acked(at(14, 30)) });
  await until(() => !!button(), 'the steps button');
  expect(button()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe('waiting');
  expect(button()!.getAttribute('aria-label')).toBe("Claude Code's checklist: 3 of 6 steps done; waiting on you: Ship it behind a flag");
});

test.skipIf(!hasDom)('two sessions: each list under its agent\'s name; the button shows the one waiting on the person, else the newest', async () => {
  // Codex's list is the newest but waits on nobody; Claude Code's waits on the person, so the button shows it.
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [{ ...list('idle', B), steps: list('idle', B).steps.slice(0, 2) }, list('working')] });
  await render();
  await until(() => !!button(), 'the steps button');
  // "+1": another session's list is there too, and the button's name says so.
  expect(button()!.textContent).toBe('3/6+1');
  expect(button()!.getAttribute('aria-label')).toEndWith(', and 1 more checklist');
  await openPanel();
  expect(button()!.getAttribute('aria-label')).toStartWith("Claude Code's checklist");
  // The panel keeps the server's order (the newest first).
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.textContent)).toEqual(['Codex', 'Claude Code']);
  // A name can be cut with an ellipsis: its title says it whole.
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.getAttribute('title'))).toEqual(['Codex', 'Claude Code']);
  expect(panel()!.getAttribute('aria-label')).toBe('Checklist');
});

// Part 4: "the head reads Steps ◑ 3/6 plus a small Board icon that opens the thread's card".
test.skipIf(!hasDom)('the head\'s Board icon: there only when a card links the thread; it closes the list and opens the card', async () => {
  await render();
  await until(() => !!button(), 'the steps button');
  await openPanel();
  expect(panel()!.querySelector('[data-steps-card]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[data-steps-panel]').forEach((n) => n.closest('.ib-st-pos')?.remove());

  const opened: string[] = [];
  await render({ boardCard: { title: 'Stripe retry worker', onOpen: () => opened.push('crd_stripe') } });
  await until(() => !!button(), 'the steps button');
  await openPanel();
  const icon = panel()!.querySelector<HTMLButtonElement>('[data-steps-card]')!;
  expect(icon.closest('[data-steps-head]')).not.toBeNull();
  expect(icon.getAttribute('aria-label')).toBe('Open “Stripe retry worker” on the Board');
  await act(async () => icon.click());
  await until(() => !panel(), 'the panel to close');
  expect(opened).toEqual(['crd_stripe']);
});

test.skipIf(!hasDom)('a phone: the sheet over a scrim, with a close', async () => {
  await render({ phone: true });
  await until(() => !!button(), 'the steps button');
  await openPanel();
  expect(panel()!.closest('.ib-st-pos')!.hasAttribute('data-phone')).toBe(true);
  expect(document.querySelector('[data-steps-scrim]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[data-steps-close]')!.click());
  await until(() => !panel(), 'the sheet to close');
});

// Review of #2571, finding 3: presence moves often; a thread showing no list has nothing it could change.
test.skipIf(!hasDom)('live: presence moving reads again only while a list shows', async () => {
  const { bus } = await render();
  await until(() => !!button(), 'the steps button');
  const reads = stepsReads;
  act(() => bus.emit('presence'));
  await until(() => stepsReads === reads + 1, 'a presence read');
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [] });
  act(() => bus.emit(M1));
  await until(() => !button(), 'the list cleared');
  const cleared = stepsReads;
  act(() => bus.emit('presence'));
  await settle();
  expect(stepsReads).toBe(cleared);
  // A catch-up still reads (a steps line may have come meanwhile).
  act(() => bus.emit('*'));
  await until(() => stepsReads === cleared + 1, 'a catch-up read');
});

test.skipIf(!hasDom)('live: a change for this thread or every thread reads again; another thread\'s does not; an older answer never lands last', async () => {
  const { bus } = await render();
  await until(() => !!button(), 'the steps button');
  const reads = stepsReads;
  act(() => bus.emit('msg_another'));
  await settle();
  expect(stepsReads).toBe(reads);
  // The next read is slow and says 3/6; the one after it is quick and says 4/6: 4/6 stays.
  let release: () => void = () => {};
  answer = () => new Promise<Response>((done) => (release = () => done(Response.json({ serverSession: 's', on: true, steps: [list('working')] }))));
  act(() => bus.emit(M1));
  await until(() => stepsReads === reads + 1, 'a read for this thread');
  const four = list('working');
  four.steps[4] = { ...four.steps[4]!, status: 'done' };
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [four] });
  act(() => bus.emit('*'));
  await until(() => button()!.textContent === '4/6', 'the newer list');
  release();
  await settle();
  await settle();
  expect(button()!.textContent).toBe('4/6');
});

// Break-ui #1: the step row's class once was `.ib-st`, which is also the foot's status words (the draft note, the
// archived note), Settings → Archived and the Open in caret: its padding and hover moved all of them. Checked with the
// window's own stylesheet, so a rule that reaches them again fails here.
test.skipIf(!hasDom)('the checklist\'s row styles never reach the foot\'s status words', async () => {
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.className = 'pn-inbox';
  box.innerHTML = '<div class="ib-acts"><span class="ib-draft-foot"><span class="ib-st">Your reply, 4 picks</span></span></div><ul class="ib-sts"><li class="ib-st-row">Replay</li></ul>';
  document.body.appendChild(box);
  try {
    const status = getComputedStyle(box.querySelector('.ib-st')!);
    const row = getComputedStyle(box.querySelector('.ib-st-row')!);
    // The stylesheet is in force: the step row has its 10 px sides.
    expect(row.paddingLeft).toBe('10px');
    expect(status.paddingLeft === '' || status.paddingLeft === '0px').toBe(true);
    expect(status.display).not.toBe('flex');
  } finally {
    box.remove();
    style.remove();
  }
});

// Break-ui #2: on a phone every done time read "2:…". A time never shrinks; a note does.
test.skipIf(!hasDom)('a step\'s time keeps its width; only a note gives way', async () => {
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  await render();
  await until(() => !!button(), 'the steps button');
  await openPanel();
  try {
    const done = rows().find((r) => r.dataset.stepStatus === 'done')!.querySelector<HTMLElement>('.ib-st-m')!;
    const noted = rows().find((r) => r.dataset.stepStatus === 'doing')!.querySelector<HTMLElement>('.ib-st-m')!;
    expect(getComputedStyle(done).flexShrink).toBe('0');
    expect(getComputedStyle(noted).flexShrink).toBe('1');
    // The step's own words read in their own direction (an Arabic step starts at its right).
    expect(rows()[0]!.querySelector('.ib-st-t')!.getAttribute('dir')).toBe('auto');
  } finally {
    style.remove();
  }
});

// The crowded phone foot (amendment 3, approved as shown): 👍 Looks good sits before the checklist.
test.skipIf(!hasDom)('the foot: 👍 Looks good comes before the checklist', async () => {
  const quiet: InboxThread = { ...THREAD, messages: [message(1, A, 'Starting the retry worker.')] };
  await render({ thread: quiet, onAck: () => {} });
  await until(() => !!button(), 'the steps button');
  const buttons = [...document.querySelector('[data-foot-buttons]')!.children];
  const ack = buttons.findIndex((el) => el.matches('[data-ack]') || !!el.querySelector('[data-ack]'));
  const steps = buttons.findIndex((el) => el.matches('[data-steps-button]'));
  expect(ack).toBeGreaterThanOrEqual(0);
  expect(steps).toBeGreaterThan(ack);
});

// Amendment 3: the checklist gives way first (its chevron), from the row's `steps` step or the buttons' own fit; on
// a phone a step's words wrap to two lines in the sheet. Checked with the window's stylesheet.
test.skipIf(!hasDom)('the stylesheet: the checklist\'s chevron and its "as of" go at the steps fit, and phone steps wrap to two lines', async () => {
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.className = 'pn-inbox';
  const chev = '<button class="ib-btn ib-st-btn"><span class="ib-st-asof">as of 2:40 PM</span><span class="ib-oq-chev">v</span></button>';
  box.innerHTML = [
    `<div class="ib-footrow" data-k="plain"><div class="ib-footbtns">${chev}</div></div>`,
    `<div class="ib-footrow" data-fit="keys skip edit steps" data-k="row"><div class="ib-footbtns">${chev}</div></div>`,
    `<div class="ib-footrow" data-k="own"><div class="ib-footbtns" data-steps-fit="">${chev}</div></div>`,
    '<div class="ib-oq-pos" data-phone=""><ul class="ib-sts"><li class="ib-st-row"><span class="ib-st-t" data-k="sheet">A long step</span></li></ul></div>',
    '<div class="ib-oq-pos"><ul class="ib-sts"><li class="ib-st-row"><span class="ib-st-t" data-k="desk">A long step</span></li></ul></div>',
  ].join('');
  document.body.appendChild(box);
  try {
    const chevOf = (k: string) => getComputedStyle(box.querySelector(`[data-k="${k}"] .ib-oq-chev`)!).display;
    expect(chevOf('plain')).not.toBe('none');
    expect(chevOf('row')).toBe('none');
    expect(chevOf('own')).toBe('none');
    // An ended session's "as of" on the button gives way with the chevron (the name and the list's head keep it).
    const asOfOf = (k: string) => getComputedStyle(box.querySelector(`[data-k="${k}"] .ib-st-asof`)!).display;
    expect(asOfOf('plain')).not.toBe('none');
    expect(asOfOf('row')).toBe('none');
    expect(asOfOf('own')).toBe('none');
    const text = (k: string) => getComputedStyle(box.querySelector(`[data-k="${k}"]`)!);
    // (happy-dom computes no line clamp: the wrap is what it can read.)
    expect(text('sheet').whiteSpace).toBe('normal');
    expect(text('desk').whiteSpace).toBe('nowrap');
  } finally {
    box.remove();
    style.remove();
  }
});

async function withStylesheet(run: () => Promise<void> | void) {
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  try {
    await run();
  } finally {
    style.remove();
  }
}

// Mock 1: the button carries the current step's mark; the pie only when nothing is worked on or waits.
test.skipIf(!hasDom)('the button\'s mark follows the list: the pie while fresh, the spinner while a step is worked on, the pie with every step done', async () => {
  const cases: [InboxStepsWire, string | null, string][] = [
    [withStatuses(['todo', 'todo', 'todo', 'todo']), null, '0/4'],
    [withStatuses(['done', 'doing', 'todo', 'todo']), 'doing', '1/4'],
    [withStatuses(['done', 'done', 'done', 'done']), null, '4/4'],
  ];
  for (const [shown, mark, count] of cases) {
    answer = async () => Response.json({ serverSession: 's', on: true, steps: [shown] });
    await render();
    await until(() => !!button(), 'the steps button');
    expect(button()!.querySelector('.ib-st-num')!.textContent).toBe(count);
    if (mark) {
      expect(button()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe(mark);
      expect(button()!.querySelector('[data-steps-pie]')).toBeNull();
    } else {
      expect(button()!.querySelector('[data-steps-pie]')!.getAttribute('data-steps-pie')).toBe(count);
      expect(button()!.querySelector('[data-step-mark]')).toBeNull();
    }
    // The presence class sits on the button, so its spinner turns only while the session works.
    expect(button()!.className).toContain('ib-st-working');
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
});

test.skipIf(!hasDom)('the stylesheet: the spinner turns while a step is in progress (busy or idle), and rests once the session ended', async () => {
  await withStylesheet(() => {
    const box = document.createElement('div');
    box.className = 'pn-inbox';
    const spin = '<svg class="ib-stg ib-stg-spin"><circle class="tr"/><circle class="arc"/></svg>';
    box.innerHTML = ['working', 'idle', 'ended'].map((p) => `<span class="ib-st-${p}" data-k="${p}">${spin}</span>`).join('');
    document.body.appendChild(box);
    try {
      const turn = (k: string) => getComputedStyle(box.querySelector(`[data-k="${k}"] .ib-stg-spin`)!).animation;
      expect(turn('working')).toContain('ib-st-turn');
      expect(turn('idle')).toContain('ib-st-turn');
      expect(['', 'none']).toContain(turn('ended'));
    } finally {
      box.remove();
    }
  });
});

// The owner (addendum): "Keep same basic color as reply button too (use theme obv)". The button is `.ib-btn`, as
// Reply is, so it takes Reply's surface, text colour and border from the theme; no rule on the button itself may
// paint it otherwise, closed or open (open takes Reply's own hover surface). (happy-dom computes no var() colours,
// so the rules are read from the stylesheet.)
test.skipIf(!hasDom)('the stylesheet: the checklist button keeps Reply\'s colours, closed and open', async () => {
  await render();
  await until(() => !!button(), 'the steps button');
  expect(button()!.classList.contains('ib-btn')).toBe(true);
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
  // Rules whose selector ends on the button itself (not a part inside it).
  const own = rules.filter((rule) => rule.selector.split(',').some((one) => /\.ib-st-btn(\[[^\]]*\])*(:[a-z-]+)*\s*$/.test(one.trim())));
  expect(own.length).toBeGreaterThan(0);
  for (const rule of own) {
    expect(rule.body).not.toMatch(/(^|;)\s*(color|border(-color)?|border-[a-z]+-color)\s*:/);
    const background = /background(-color)?\s*:\s*([^;]+)/.exec(rule.body)?.[2];
    if (background) expect(background.trim()).toBe('var(--ib-bt-hover-s, var(--ib-btn-rest, var(--card)))');
  }
});

// The checklist lives only in its thread (owner, 2026-11-09: "There should be nothing there"): a list row shows no
// checklist mark, not even while the server says a step waits on the person (`steps_waiting`).
test.skipIf(!hasDom)('the list row never shows a checklist mark, even while a step waits on the person', async () => {
  const listRow = (id: string, waiting: boolean): InboxListRow => ({
    thread_id: id,
    project_id: PROJECT.id,
    subject: 'Nightly export drops rows',
    author: A,
    created_at: at(14, 0),
    last_at: at(14, 30),
    last_author: 'agent',
    message_count: 2,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: PROJECT.id, name: PROJECT.name },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...(waiting ? { steps_waiting: true as const } : {}),
  });
  for (const phone of [false, true]) {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <SidebarProvider>
          <div className="pn-inbox">
            <InboxList title="Inbox" path={null} sections={[{ id: 'waiting', label: 'Waiting on you', threads: [listRow('msg_wait', true), listRow('msg_work', false)] }]} filtered={false} narrow={phone} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={phone} />
          </div>
        </SidebarProvider>,
      );
    });
    const rowEl = (id: string) => host!.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
    const waitingRow = rowEl('msg_wait');
    expect(waitingRow).not.toBeNull();
    // No step mark, spinner or pie, and no "Checklist" in anything it says or shows on hover.
    expect(waitingRow.querySelector('[data-step-mark], [data-row-steps-waiting], [class*="ib-stg"], [class*="ib-st-"]')).toBeNull();
    const said = [waitingRow.textContent ?? '', ...[...waitingRow.querySelectorAll('[aria-label], [title]')].flatMap((el) => [el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''])];
    for (const words of said) expect(words).not.toMatch(/checklist|steps?\b/i);
    // The row draws the same with or without a waiting checklist.
    expect(waitingRow.innerHTML.replaceAll('msg_wait', 'msg_X')).toBe(rowEl('msg_work').innerHTML.replaceAll('msg_work', 'msg_X'));
    act(() => root?.unmount());
    host.remove();
    root = null;
    host = null;
  }
});
