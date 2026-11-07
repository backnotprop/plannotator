/**
 * Thread steps in the window (approval "inbox-thread-steps", 2026-11-03; the look is
 * "inbox-checklist-spinners-2026-11-07", Take C with spinners):
 *
 *  - the rules (steps/model.ts): what a row says at its right (a done step's time, a note, "Dropped: <note>",
 *    "Waiting on you"), "3 of 6 done" counting no dropped step, "as of" only once the session ended, where "Waiting on
 *    you ›" goes (that session's open question, else its action item, else any), what the line names in each state
 *    (next, doing, waiting, all done), which list it names, and when a row or lane card wears the amber pause;
 *  - the thread (ThreadPane): no line while the switch is off (and no read); the line at the top of the thread (after
 *    the subject and meta line, before the messages, never in the foot) while it is on; a click opening the whole list
 *    in place under it (`aria-expanded`, no popover) and closing it again; the presence class that turns the spinner;
 *    "Waiting on you ›" ringing the question; two sessions; the Board icon; a phone;
 *  - live: a steps change for this thread (or every thread) reads again; another thread's does not, and an older
 *    answer never lands over a newer one;
 *  - the stylesheet: the spinner turns only while working; the line cuts a long step, the list keeps it whole;
 *  - the wire: `event: capabilities` reaches the window's handler.
 *
 * What regresses: steps shown (or read) with the switch off, a dropped step counted, the line naming the wrong step
 * or sliding back to the foot, a dead or idle session's spinner still turning, the waiting row going nowhere or to
 * another agent's question, a list that never updates, and a window that misses another window's switch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxListRow, InboxMessageWire, InboxProject, InboxQuestion, InboxStepsWire, InboxThread } from '@plannotator/core/inbox-types';
import type { OpenActionItem, OpenQuestion } from '@plannotator/core/inbox-open-questions';
import { dispatchInboxFrame, type InboxEventHandlers } from './api';
import { cardStepLists, stepMeta, stepsAsOf, stepsCount, stepsDoneWords, stepsLine, stepsLineList, stepsLineName, stepsListLabels, stepsName, stepsWaitOnPerson, stepsWaitTarget, stepsWaitWords, threadBoardCard } from './steps/model';
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


/** The same list with its steps' statuses set, in order. */
function withStatuses(statuses: InboxStepsWire['steps'][number]['status'][], presence: InboxStepsWire['presence'] = 'working'): InboxStepsWire {
  const base = list(presence);
  return { ...base, steps: statuses.map((status, i) => ({ ...base.steps[i]!, status })) };
}

describe('the rules (steps/model.ts)', () => {
  test('a row\'s right side: a done step\'s time, a note for the others, "Dropped: <note>", "Waiting on you" for a waiting one', () => {
    const steps = list('working').steps;
    expect(steps.map((s) => stepMeta(s, NOW))).toEqual([
      { kind: 'time', text: '11:05 AM', title: '11:05 AM' },
      { kind: 'time', text: '1:12 PM', title: '1:12 PM' },
      { kind: 'time', text: '2:44 PM', title: '2:44 PM' },
      { kind: 'waiting' },
      { kind: 'note', text: 'Starting the table' },
      null,
      { kind: 'note', text: 'Dropped: Stripe settles them' },
    ]);
    // A dropped step with no note still says so.
    expect(stepMeta({ ...steps[6]!, note: null }, NOW)).toEqual({ kind: 'note', text: 'Dropped' });
  });

  test('the Board (part 4): a card\'s lists come from every thread it links, the latest written first; the line\'s icon opens a card that links the thread, never a cancelled one', () => {
    const older = { ...list('idle'), id: 'stp_old', thread_id: 'msg_old', updated_at: at(10, 0) };
    const newer = { ...list('working'), id: 'stp_new', thread_id: 'msg_new', updated_at: at(14, 0) };
    const cleared = { ...list('working'), id: 'stp_gone', thread_id: 'msg_gone', updated_at: at(15, 0), steps: [] };
    const steps = { msg_old: [older], msg_new: [newer], msg_gone: [cleared] };
    expect(cardStepLists(['msg_old', 'msg_new', 'msg_gone', 'msg_none'], steps).map((l) => l.id)).toEqual(['stp_new', 'stp_old']);
    // The switch off: the read has no `steps`.
    expect(cardStepLists(['msg_old'], undefined)).toEqual([]);
    const cards = [
      { id: 'crd_dropped', column: 'dropped', threads: [M1] },
      { id: 'crd_live', column: 'in_progress', threads: ['msg_other', M1] },
    ];
    expect(threadBoardCard(cards, M1)?.id).toBe('crd_live');
    expect(threadBoardCard(cards.slice(0, 1), M1)).toBeNull();
    expect(stepsDoneWords(list('working'))).toBe('3 of 6 steps done');
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

  test('"3 of 6 done": a dropped step is not counted; the name says whose and how far', () => {
    expect(stepsCount(list('working'))).toEqual({ done: 3, total: 6, text: '3 of 6 done' });
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

  // The approval's five states: what the line names, with which mark, and its count.
  test('the line: next while none started, the step in progress, "waiting on you" before any other, all done; a dropped step never counts', () => {
    expect(stepsLine(withStatuses(['todo', 'todo', 'todo', 'todo']))).toEqual({ kind: 'next', step: 'Classify 30 days of failed charges', mark: 'todo', count: '0 of 4 done' });
    expect(stepsLine(withStatuses(['done', 'doing', 'todo', 'todo']))).toEqual({ kind: 'doing', step: 'Retry worker on pg-boss', mark: 'doing', count: '1 of 4 done' });
    // Waiting wins over a step in progress: it is what the person has to do.
    expect(stepsLine(withStatuses(['done', 'doing', 'waiting', 'todo']))).toMatchObject({ kind: 'waiting', step: 'Replay the failures in staging', mark: 'waiting', count: '1 of 4 done' });
    expect(stepsLine(withStatuses(['done', 'done', 'dropped', 'doing']))).toMatchObject({ kind: 'doing', step: 'Ship it behind a flag', count: '2 of 3 done' });
    expect(stepsLine(withStatuses(['done', 'done', 'done', 'done']))).toEqual({ kind: 'done', step: null, mark: 'done', count: '4 of 4' });
    // Some done, nothing in progress: the next step.
    expect(stepsLine(withStatuses(['done', 'todo', 'todo']))).toMatchObject({ kind: 'next', step: 'Retry worker on pg-boss', count: '1 of 3 done' });
    expect(stepsLineName('Claude Code', withStatuses(['done', 'waiting']))).toBe("Claude Code's checklist: 1 of 2 steps done; waiting on you: Retry worker on pg-boss");
    expect(stepsLineName('Claude Code', withStatuses(['done', 'done']))).toBe("Claude Code's checklist: 2 of 2 steps done");
  });

  test('the line names a list that waits on the person first, else the newest; a row and a lane card wear the pause only while one waits', () => {
    const working = withStatuses(['done', 'doing']);
    const waiting = { ...withStatuses(['waiting']), id: 'stp_w' };
    expect(stepsLineList([working, waiting])?.id).toBe('stp_w');
    expect(stepsLineList([working])).toBe(working);
    expect(stepsLineList([])).toBeNull();
    expect(stepsWaitOnPerson([working])).toBe(false);
    expect(stepsWaitOnPerson([working, waiting])).toBe(true);
    expect(stepsWaitWords([working])).toBeNull();
    expect(stepsWaitWords([working, waiting])).toBe('Checklist: 0 of 1 steps done; waiting on you: Classify 30 days of failed charges');
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


const line = () => document.querySelector<HTMLElement>('[data-steps-line]');
const toggle = () => document.querySelector<HTMLButtonElement>('[data-steps-toggle]');
const panel = () => document.querySelector<HTMLElement>('[data-steps-panel]');
const rows = () => [...(panel()?.querySelectorAll<HTMLElement>('.ib-st-row') ?? [])];
/** The line's words as drawn: the step (or its lead words) and the count. */
const lineWords = () => `${toggle()!.querySelector('[data-steps-now]')!.textContent} · ${toggle()!.querySelector('[data-steps-count]')!.textContent}`;

async function openList() {
  await act(async () => toggle()!.click());
  await until(() => !!panel(), 'the list under the line');
}

/** The window's stylesheet, in force for one test. */
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

test.skipIf(!hasDom)('off: no line, and the steps are never read', async () => {
  await render({ on: false });
  await settle();
  expect(line()).toBeNull();
  expect(stepsReads).toBe(0);
});

test.skipIf(!hasDom)('on: the line at the top of the thread, under the subject and before the messages, never in the foot; a list cleared to nothing shows no line', async () => {
  const { el } = await render();
  await until(() => !!line(), 'the checklist line');
  const subject = el.querySelector('.ib-subject')!;
  const firstMessage = el.querySelector('[data-message-id]')!;
  expect(subject.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(line()!.compareDocumentPosition(firstMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(line()!.closest('[data-foot-buttons]')).toBeNull();
  expect(el.querySelector('[data-foot-buttons] [data-steps-toggle]')).toBeNull();
  // The list waits on the person: its first words say so, then the step, then the count.
  expect(line()!.dataset.stepsLine).toBe('waiting');
  expect(lineWords()).toBe('Waiting on you: Ship it behind a flag · 3 of 6 done');
  expect(toggle()!.querySelector('.ib-stl-wait')!.textContent).toBe('Waiting on you:');
  expect(toggle()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe('waiting');
  expect(toggle()!.getAttribute('aria-label')).toBe("Claude Code's checklist: 3 of 6 steps done; waiting on you: Ship it behind a flag");
  expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
  act(() => root?.unmount());
  host?.remove();
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [{ ...list('working'), steps: [] }] });
  await render();
  await until(() => stepsReads >= 2, 'the second read');
  await settle();
  expect(line()).toBeNull();
});

test.skipIf(!hasDom)('each state\'s line: next with the ring, the step in progress with the spinner, all done with the check', async () => {
  const cases: [InboxStepsWire, string, string, string][] = [
    [withStatuses(['todo', 'todo', 'todo', 'todo']), 'next', 'todo', 'Next: Classify 30 days of failed charges · 0 of 4 done'],
    [withStatuses(['done', 'doing', 'todo', 'todo']), 'doing', 'doing', 'Retry worker on pg-boss · 1 of 4 done'],
    [withStatuses(['done', 'done', 'dropped', 'doing']), 'doing', 'doing', 'Ship it behind a flag · 2 of 3 done'],
    [withStatuses(['done', 'done', 'done', 'done']), 'done', 'done', 'All steps done · 4 of 4'],
  ];
  for (const [shown, kind, mark, words] of cases) {
    answer = async () => Response.json({ serverSession: 's', on: true, steps: [shown] });
    await render();
    await until(() => !!line(), `the ${kind} line`);
    expect(line()!.dataset.stepsLine).toBe(kind);
    expect(toggle()!.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe(mark);
    expect(lineWords()).toBe(words);
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('a click opens the whole list in place under the line, with the same marks; a second click closes it', async () => {
  const { el } = await render();
  await until(() => !!line(), 'the checklist line');
  expect(panel()).toBeNull();
  await openList();
  expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
  expect(toggle()!.getAttribute('aria-controls')).toBe(panel()!.id);
  // In place: inside the thread, under the line; nothing floats over the messages.
  expect(line()!.contains(panel())).toBe(true);
  expect(el.contains(panel())).toBe(true);
  // One list: the line is its head, so the list draws none of its own.
  expect(panel()!.querySelector('[data-steps-head]')).toBeNull();
  expect(rows().map((r) => [r.dataset.stepStatus, r.querySelector('[data-step-mark]')!.getAttribute('data-step-mark'), r.querySelector('.ib-st-t')!.textContent, r.querySelector('.ib-st-m')?.textContent ?? ''])).toEqual([
    ['done', 'done', 'Classify 30 days of failed charges', expect.stringMatching(/^11:05 AM$|^Nov 3$/)],
    ['done', 'done', 'Retry worker on pg-boss', expect.any(String)],
    ['done', 'done', 'Replay the failures in staging', expect.any(String)],
    ['waiting', 'waiting', 'Ship it behind a flag', 'Waiting on you'],
    ['doing', 'doing', 'Admin retry view', 'Starting the table'],
    ['todo', 'todo', 'On-call runbook entry', ''],
    ['dropped', 'dropped', 'Retry Stripe 409s', 'Dropped: Stripe settles them'],
  ]);
  expect(rows()[6]!.getAttribute('aria-label')).toBe('Retry Stripe 409s, dropped: Stripe settles them');
  await act(async () => toggle()!.click());
  await until(() => !panel(), 'the list to close');
  expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('the spinner turns while the session works: the presence class on the line and on its list', async () => {
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [withStatuses(['done', 'doing', 'todo'])] });
  await render();
  await until(() => !!line(), 'the checklist line');
  expect(toggle()!.className).toContain('ib-st-working');
  expect(toggle()!.querySelector('.ib-stg-spin')).not.toBeNull();
  await openList();
  expect(panel()!.querySelector('[data-steps-group]')!.className).toContain('ib-st-working');
});

test.skipIf(!hasDom)('an ended session: the spinner stops (no working class) and the count says "as of"', async () => {
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [withStatuses(['done', 'doing', 'todo'], 'ended')] });
  await render();
  await until(() => !!line(), 'the checklist line');
  expect(toggle()!.className).toContain('ib-st-ended');
  expect(toggle()!.className).not.toContain('ib-st-working');
  expect(toggle()!.querySelector('[data-steps-as-of]')!.textContent).toMatch(/^ · as of /);
  await openList();
  const group = panel()!.querySelector<HTMLElement>('[data-steps-group]')!;
  expect(group.className).toContain('ib-st-ended');
});

test.skipIf(!hasDom)('"Waiting on you ›" rings the question of that session, not another agent\'s', async () => {
  const { el } = await render();
  await until(() => !!line(), 'the checklist line');
  await openList();
  await act(async () => panel()!.querySelector<HTMLButtonElement>('[data-steps-waiting]')!.click());
  await until(() => !!el.querySelector(`[data-message-id="${M3}"] [data-question-key].ib-q-target`), "Claude Code's question ringed");
  expect(el.querySelector(`[data-message-id="${M2}"] [data-question-key].ib-q-target`)).toBeNull();
});

test.skipIf(!hasDom)('two sessions: the line names the list that waits on the person, with "+1"; the open list shows each under its agent\'s name', async () => {
  // Codex's list is the newest, but Claude Code's waits on the person: the line names Claude Code's.
  const codex = { ...list('idle', B), updated_at: at(14, 50), steps: [{ ...list('idle', B).steps[4]!, status: 'doing' as const }] };
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [codex, list('working')] });
  await render();
  await until(() => !!line(), 'the checklist line');
  expect(lineWords()).toBe('Waiting on you: Ship it behind a flag · 3 of 6 done');
  expect(toggle()!.querySelector('[data-steps-more]')!.textContent).toBe('+1');
  expect(toggle()!.getAttribute('aria-label')).toEndWith(', and 1 more checklist');
  await openList();
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.textContent)).toEqual(['Codex', 'Claude Code']);
  // A name can be cut with an ellipsis: its title says it whole.
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.getAttribute('title'))).toEqual(['Codex', 'Claude Code']);
  // Each list turns by its own session: Codex's is idle, though the line's (Claude Code's) works.
  expect(panel()!.querySelector<HTMLElement>('[data-steps-group="ses_b"]')!.className).toContain('ib-st-idle');
});

// Part 4: a small Board icon opens the thread's card.
test.skipIf(!hasDom)('the Board icon: at the open line\'s end only when a card links the thread; it opens the card', async () => {
  await render();
  await until(() => !!line(), 'the checklist line');
  await openList();
  expect(line()!.querySelector('[data-steps-card]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  const opened: string[] = [];
  await render({ boardCard: { title: 'Stripe retry worker', onOpen: () => opened.push('crd_stripe') } });
  await until(() => !!line(), 'the checklist line');
  // The closed line stays as approved: no icon until the list is open.
  expect(line()!.querySelector('[data-steps-card]')).toBeNull();
  await openList();
  const icon = line()!.querySelector<HTMLButtonElement>('[data-steps-card]')!;
  expect(icon.getAttribute('aria-label')).toBe('Open “Stripe retry worker” on the Board');
  await act(async () => icon.click());
  expect(opened).toEqual(['crd_stripe']);
});

test.skipIf(!hasDom)('a phone: the same line and the list in place (no sheet, no scrim)', async () => {
  await render({ phone: true });
  await until(() => !!line(), 'the checklist line');
  expect(line()!.className).toContain('ib-stl-phone');
  await openList();
  expect(line()!.contains(panel())).toBe(true);
  expect(document.querySelector('.ib-oq-scrim')).toBeNull();
});

// Review of #2571, finding 3: presence moves often; a thread showing no list has nothing it could change.
test.skipIf(!hasDom)('live: presence moving reads again only while a list shows', async () => {
  const { bus } = await render();
  await until(() => !!line(), 'the checklist line');
  const reads = stepsReads;
  act(() => bus.emit('presence'));
  await until(() => stepsReads === reads + 1, 'a presence read');
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [] });
  act(() => bus.emit(M1));
  await until(() => !line(), 'the list cleared');
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
  await until(() => !!line(), 'the checklist line');
  const reads = stepsReads;
  act(() => bus.emit('msg_another'));
  await settle();
  expect(stepsReads).toBe(reads);
  // The next read is slow and says 3 of 6; the one after it is quick and says 4 of 6: 4 of 6 stays.
  let release: () => void = () => {};
  answer = () => new Promise<Response>((done) => (release = () => done(Response.json({ serverSession: 's', on: true, steps: [list('working')] }))));
  act(() => bus.emit(M1));
  await until(() => stepsReads === reads + 1, 'a read for this thread');
  const four = list('working');
  four.steps[4] = { ...four.steps[4]!, status: 'done' };
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [four] });
  act(() => bus.emit('*'));
  await until(() => toggle()?.querySelector('[data-steps-count]')?.textContent === '4 of 6 done', 'the newer list');
  release();
  await settle();
  await settle();
  expect(toggle()!.querySelector('[data-steps-count]')!.textContent).toBe('4 of 6 done');
});

// Break-ui #1: the step row's class once was `.ib-st`, which is also the foot's status words (the draft note, the
// archived note), Settings → Archived and the Open in caret: its padding moved all of them. Checked with the
// window's own stylesheet, so a rule that reaches them again fails here.
test.skipIf(!hasDom)('the checklist\'s row styles never reach the foot\'s status words', async () => {
  await withStylesheet(() => {
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
    }
  });
});

// Break-ui #2: on a phone every done time read "2:…". A time never shrinks; a note does. The approval: long step
// words are cut on the line, and whole in the list.
test.skipIf(!hasDom)('a step\'s time keeps its width, only a note gives way; the line cuts a long step, the list keeps it whole', async () => {
  await withStylesheet(async () => {
    await render({ phone: true });
    await until(() => !!line(), 'the checklist line');
    await openList();
    const done = rows().find((r) => r.dataset.stepStatus === 'done')!.querySelector<HTMLElement>('.ib-st-m')!;
    const noted = rows().find((r) => r.dataset.stepStatus === 'doing')!.querySelector<HTMLElement>('.ib-st-m')!;
    expect(getComputedStyle(done).flexShrink).toBe('0');
    expect(getComputedStyle(noted).flexShrink).toBe('1');
    // The step's own words read in their own direction (an Arabic step starts at its right).
    expect(rows()[0]!.querySelector('.ib-st-t')!.getAttribute('dir')).toBe('auto');
    const now = getComputedStyle(toggle()!.querySelector('[data-steps-now]')!);
    expect(now.whiteSpace).toBe('nowrap');
    expect(now.textOverflow).toBe('ellipsis');
    expect(getComputedStyle(rows()[0]!.querySelector('.ib-st-t')!).whiteSpace).toBe('normal');
  });
});

// The approval's spinner: it turns (0.9 s, linear) only while its session works; idle and ended it rests.
test.skipIf(!hasDom)('the stylesheet: the spinner turns while working, and rests while idle or ended', async () => {
  await withStylesheet(() => {
    const box = document.createElement('div');
    box.className = 'pn-inbox';
    const spin = '<svg class="ib-stg ib-stg-spin"><circle class="tr"/><circle class="arc"/></svg>';
    box.innerHTML = ['working', 'idle', 'ended'].map((p) => `<span class="ib-st-${p}" data-k="${p}">${spin}</span>`).join('');
    document.body.appendChild(box);
    try {
      const turn = (k: string) => getComputedStyle(box.querySelector(`[data-k="${k}"] .ib-stg-spin`)!).animation;
      expect(turn('working')).toContain('ib-st-turn');
      expect(['', 'none']).toContain(turn('idle'));
      expect(['', 'none']).toContain(turn('ended'));
    } finally {
      box.remove();
    }
  });
});

// The calm row (approval "inbox-checklist-spinners-2026-11-07", row option A): the row never moves; it wears only the
// still amber pause, after the project, while the server says a step waits on the person (`steps_waiting`).
test.skipIf(!hasDom)('the list row: the still amber pause after the project only while a step waits on the person; never a spinner', async () => {
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
    const mark = rowEl('msg_wait').querySelector<HTMLElement>('[data-row-steps-waiting]')!;
    expect(mark.querySelector('[data-step-mark]')!.getAttribute('data-step-mark')).toBe('waiting');
    expect(mark.getAttribute('aria-label')).toBe('Checklist: waiting on you');
    // After the project: the project's words come first in the row's first cell.
    const project = mark.parentElement!.querySelector('.ib-p')!;
    expect(project.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rowEl('msg_work').querySelector('[data-row-steps-waiting]')).toBeNull();
    expect(host!.querySelector('.ib-stg-spin')).toBeNull();
    act(() => root?.unmount());
    host.remove();
    root = null;
    host = null;
  }
});
