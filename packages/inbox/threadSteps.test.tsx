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
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxStepsWire, InboxThread } from '@plannotator/core/inbox-types';
import type { OpenActionItem, OpenQuestion } from '@plannotator/core/inbox-open-questions';
import { dispatchInboxFrame, type InboxEventHandlers } from './api';
import { cardStepLists, pieGeometry, stepMeta, stepsAsOf, stepsCount, stepsDoneWords, stepsListLabels, stepsName, stepsWaitTarget, threadBoardCard } from './steps/model';
import { createStepsBus } from './steps/useThreadSteps';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

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

  test('the Board (part 4): a card\'s lists come from every thread it links, the latest written first; the head\'s icon opens a card that links the thread, never a cancelled one', () => {
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

async function render(options: { on?: boolean; phone?: boolean; bus?: ReturnType<typeof createStepsBus>; boardCard?: { title: string; onOpen: () => void } | null } = {}) {
  const bus = options.bus ?? createStepsBus();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={THREAD}
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

test.skipIf(!hasDom)('on: "3/6" after the open questions, named for whose steps; a list cleared to nothing shows no button', async () => {
  const { el } = await render();
  await until(() => !!button(), 'the steps button');
  const foot = [...el.querySelectorAll<HTMLElement>('[data-foot-buttons] > *')];
  const oq = foot.findIndex((n) => n.hasAttribute('data-open-questions'));
  expect(oq).toBeGreaterThanOrEqual(0);
  expect(foot[oq + 1]).toBe(button()!);
  expect(button()!.textContent).toBe('3/6');
  expect(button()!.getAttribute('aria-label')).toBe("Claude Code's checklist: 3 of 6 steps done");
  expect(button()!.querySelector('[data-steps-pie="3/6"]')).not.toBeNull();
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

test.skipIf(!hasDom)('an ended session: the mark stops (no working class) and the head says "as of"', async () => {
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [list('ended')] });
  await render();
  await until(() => !!button(), 'the steps button');
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

test.skipIf(!hasDom)('two sessions: each list under its agent\'s name; the button shows the newest', async () => {
  answer = async () => Response.json({ serverSession: 's', on: true, steps: [list('working'), { ...list('idle', B), steps: list('idle', B).steps.slice(0, 2) }] });
  await render();
  await until(() => !!button(), 'the steps button');
  // "+1": another session's list is there too, and the button's name says so.
  expect(button()!.textContent).toBe('3/6+1');
  expect(button()!.getAttribute('aria-label')).toEndWith(', and 1 more checklist');
  await openPanel();
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.textContent)).toEqual(['Claude Code', 'Codex']);
  // A name can be cut with an ellipsis: its title says it whole.
  expect([...panel()!.querySelectorAll('.ib-st-lbl')].map((n) => n.getAttribute('title'))).toEqual(['Claude Code', 'Codex']);
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
