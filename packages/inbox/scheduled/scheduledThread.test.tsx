/**
 * A routine's thread: each run opens with its divider ("Run 7"), a late one says when it was due and how
 * many times were missed, a skip line stands in for a due time that did not run, and a run that ended with no reply
 * says "Didn't finish". All of it comes from the messages, so another machine's thread reads the same; its Reply-row
 * mark then names that machine and links nowhere. What regresses: a late run drawn as on time, a skip drawn as a
 * run, "Didn't finish" under a run that replied or is still going, or a far thread's mark opening this computer's page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxRun } from '@plannotator/core/inbox-types';
import type { InboxScheduledRun } from '@plannotator/core/inbox-scheduled-types';
import { scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { RunDivider, ScheduledFoot } = (hasDom ? await import('./thread') : {}) as typeof import('./thread');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { farChangeMessage } = await import('./farLinks');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (!hasDom) return;
  document.body.innerHTML = '';
  resetScheduledForTests(null, false);
});

const PERSON = { kind: 'person' as const };
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const base = { scheduled_id: 'sch_pr', name: 'Weekday PR summary', by: 'schedule' as const };

function message(id: string, at: string, change: Partial<InboxMessageWire>): InboxMessageWire {
  return { id, thread_id: 'msg_thread', project_id: 'prj_api', author: PERSON, body: '', created_at: at, ...change } as InboxMessageWire;
}
const divider = (id: string, at: string, run: Partial<InboxScheduledRun>) => message(id, at, { body: 'Summarize my open pull requests.', scheduled_run: { ...base, due_at: at, ...run } });
const reply = (id: string, at: string) => message(id, at, { author: AGENT, body: 'Two changed since Tuesday.' });

const MESSAGES: InboxMessageWire[] = [
  divider('msg_r7', '2026-11-10T14:01:00.000Z', { run: 7 }),
  reply('msg_a7', '2026-11-10T14:04:00.000Z'),
  message('msg_skip', '2026-11-11T14:00:00.000Z', { scheduled_run: { ...base, due_at: '2026-11-11T14:00:00.000Z', skipped: { count: 1, from: '2026-11-11T14:00:00.000Z', to: '2026-11-11T14:00:00.000Z', reason: 'asleep' } } }),
  divider('msg_r8', '2026-11-12T16:14:00.000Z', { run: 8, due_at: '2026-11-12T14:00:00.000Z', late: true, missed_before: 1 }),
  reply('msg_a8', '2026-11-12T16:16:00.000Z'),
  divider('msg_r9', '2026-11-13T14:00:00.000Z', { run: 9 }),
];

function draw(run: InboxRun | null, messages = MESSAGES): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<>{messages.filter((m) => m.scheduled_run).map((m) => <RunDivider key={m.id} message={m} messages={messages} run={run} />)}</>));
  return host;
}

test.skipIf(!hasDom)('run dividers, a late run with its missed time, a quiet skip line, and Didn\'t finish under the run with no reply', () => {
  const host = draw(null);
  const r7 = host.querySelector('[data-scheduled-divider="7"]')!;
  const r8 = host.querySelector('[data-scheduled-divider="8"]')!;
  const r9 = host.querySelector('[data-scheduled-divider="9"]')!;
  expect(r7.textContent).toBe('Run 7');
  expect(r8.hasAttribute('data-late')).toBe(true);
  expect(r8.textContent).toMatch(/^Run 8 · due .+, ran .+ · 1 earlier time missed$/);
  const skip = host.querySelector('[data-scheduled-skip]')!;
  expect(skip.getAttribute('role')).toBe('separator');
  expect(skip.querySelector('svg')).toBeNull();
  expect(skip.textContent).toMatch(/^Skipped .+ · this computer was asleep$/);
  // Only the run that ended with no reply says so.
  expect([...host.querySelectorAll('[data-scheduled-unfinished]')].map((el) => el.closest('[data-scheduled-divider]')?.getAttribute('data-scheduled-divider'))).toEqual(['9']);
  expect(r9.querySelector('[data-scheduled-unfinished]')?.textContent).toBe("Didn't finish. The session ended without a reply.");
  // A click on a divider shows the prompt it ran.
  const line = r7.querySelector<HTMLButtonElement>('button.st-line')!;
  expect(line.getAttribute('aria-expanded')).toBe('false');
  act(() => line.click());
  expect(line.getAttribute('aria-expanded')).toBe('true');
  expect(r7.querySelector('.st-prompt-shown')?.textContent).toBe('Summarize my open pull requests.');
});

test.skipIf(!hasDom)("an agent's change line after a run is a note, not that run's reply: the run still says Didn't finish", () => {
  const change = message('msg_c9', '2026-11-13T15:00:00.000Z', { author: { ...AGENT, session: 'ses_b', name: 'Codex' }, body: 'Changed the routine.', scheduled_change: { scheduled_id: 'sch_pr', name: 'Weekday PR summary', op: 'update', fields: ['prompt'] } });
  const host = draw(null, [...MESSAGES, change]);
  expect(host.querySelector('[data-scheduled-divider="9"] [data-scheduled-unfinished]')).not.toBeNull();
});

test.skipIf(!hasDom)('the latest run still going: no Didn\'t finish', () => {
  const host = draw({ state: 'working' } as InboxRun);
  expect(host.querySelector('[data-scheduled-unfinished]')).toBeNull();
});

test.skipIf(!hasDom)("a run that didn't start (`failed`, no launch): Didn't start with why, never Didn't finish, and no run line under it", () => {
  const failed = divider('msg_r10', '2026-11-14T14:00:00.000Z', { run: 10, failed: 'Claude Code is not installed on this computer.' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunDivider message={failed} messages={[...MESSAGES, failed]} run={{ state: 'stopped' } as InboxRun} tail={<i data-run-line="" />} />));
  expect(host.querySelector('[data-scheduled-didnt-start]')?.textContent).toContain('Claude Code is not installed on this computer.');
  expect(host.querySelector('[data-scheduled-unfinished]')).toBeNull();
  expect(host.querySelector('[data-run-line]')).toBeNull();
});

function foot(machine: { name: string } | null): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduledFoot messages={MESSAGES} machine={machine} />));
  return host;
}

test.skipIf(!hasDom)('the Reply row mark: Edit on this computer, the machine\'s name and no link on another\'s', () => {
  resetScheduledForTests([scheduledRow('sch_pr', { name: 'Weekday PR summary', thread_id: 'msg_thread' })], true);
  let host = foot(null);
  const mark = host.querySelector<HTMLButtonElement>('button[data-scheduled-foot="sch_pr"]')!;
  expect(mark.textContent).toContain('Edit');
  act(() => mark.click());
  expect(window.location.hash).toBe('#routine=sch_pr');
  act(() => root?.unmount());
  document.body.innerHTML = '';

  host = foot({ name: 'Studio Mac' });
  expect(host.querySelector('button, a')).toBeNull();
  expect(host.querySelector('[data-scheduled-foot-far]')?.textContent).toBe('Routine on Studio Mac. Manage it there.');
});

test('an agent\'s change message in another machine\'s thread: the editor link becomes the name, and where to manage it', () => {
  const change = message('msg_change', '2026-11-10T13:00:00.000Z', { author: AGENT, body: 'Made the routine [Weekday PR summary](#routine=sch_pr). It is off until you turn it on.', scheduled_change: { scheduled_id: 'sch_pr', name: 'Weekday PR summary', op: 'create' } });
  expect(farChangeMessage(change, null)).toBe(change);
  const far = farChangeMessage(change, 'Studio Mac');
  expect(far.body).not.toContain('#scheduled');
  expect(far.body).toContain('Made the routine Weekday PR summary.');
  expect(far.body).toContain('Routine on Studio Mac. Manage it there.');
  expect(farChangeMessage(change, 'Studio Mac')).toBe(far);
});

test.skipIf(!hasDom)('a fold over earlier runs hides whole runs: it starts at a run line and the next line shown is a run line', async () => {
  const { planFolds } = await import('@plannotator/core/inbox-folding');
  const { runFolds, earlierRunsLabel } = await import('./thread');
  const you = (id: string, at: string) => message(id, at, { body: 'Merge #47 if checks pass.' });
  const messages = [
    divider('msg_r1', '2026-11-15T07:16:00.000Z', { run: 1 }),
    reply('msg_a1', '2026-11-15T07:16:15.000Z'),
    divider('msg_r2', '2026-11-15T07:19:00.000Z', { run: 2 }),
    reply('msg_a2', '2026-11-15T07:19:10.000Z'),
    you('msg_you', '2026-11-15T07:19:40.000Z'),
    reply('msg_done', '2026-11-15T07:20:00.000Z'),
    divider('msg_r3', '2026-11-15T07:20:30.000Z', { run: 3 }),
  ];
  const plan = runFolds(planFolds(messages, new Set(), 99), messages);
  expect(plan.hidden).toEqual([['msg_r1', 'msg_a1', 'msg_r2', 'msg_a2', 'msg_you', 'msg_done']]);
  expect(earlierRunsLabel(plan.hidden[0]!, messages)).toMatch(/^2 earlier runs/);
  // Run 2's last reply is new (open): the fold cannot reach Run 3's line, so it stops above Run 2's.
  expect(planFolds(messages, new Set(['msg_done']), 99).hidden).toEqual([['msg_a1', 'msg_r2']]);
  expect(runFolds(planFolds(messages, new Set(['msg_done']), 99), messages).hidden).toEqual([['msg_r1', 'msg_a1']]);
});
