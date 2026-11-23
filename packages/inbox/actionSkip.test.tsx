/**
 * Skip on an action item (the owner picked variant A, 2026-11-19): a third
 * quiet button after Done and Can't do it…, one click and no reason, that goes
 * into the reply draft like Done. Failures to catch: Skip asking for words or
 * sending a note; a skipped row offering a note field, reading as Done (a
 * check, a "Done" chip, struck through words), or still holding the card's
 * Stopped badge and watching line; its dot named "Done" to a screen reader;
 * the header counting a skip as done or
 * dropping it from the total; the tick not taking a skip back; the next open
 * item not opening; a sent skip reading as a Done; the reply box, its sent list
 * and the Draft label calling a skip something else.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxActionResult, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

const hasDom = typeof document !== 'undefined';
const { ActionChecklist } = (hasDom ? await import('./components/ActionChecklist') : {}) as typeof import('./components/ActionChecklist');
const { ReplyActions } = (hasDom ? await import('./components/ReplyAnswers') : {}) as typeof import('./components/ReplyAnswers');
const { unsentWords, rowUnsent } = await import('./components/DraftLabel');

const BODY = [
  ':::action',
  'Approve the production deploy on Vercel',
  'The 4.2 build passed every check and waits under "Promote to Production".',
  'Where: https://vercel.com/acme/web/deployments',
  'Stopped: release 4.2 to production',
  'Watching: the deployment; I go on by myself once it is Ready',
  ':::',
  '',
  ':::action',
  'Touch your security key for the npm org',
  'npm asks for two-factor before it publishes @acme/web 4.2.',
  ':::',
].join('\n');

const PARSED = parseInboxActionBlocks(BODY);
const AT = '2026-11-19T15:12:00.000Z';

function record(index: number, over: Partial<InboxQuestion> = {}): InboxQuestion {
  const p = PARSED[index]!;
  return {
    key: p.key,
    position: index,
    kind: 'action',
    prompt: p.prompt,
    context: p.why,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: p.stopped,
    holds_up: p.holds_up,
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    superseded_by: null,
    set_aside_at: null,
    action: p.action,
    action_result: null,
    ...over,
  };
}

const skip = (over: Partial<InboxActionResult> = {}): InboxActionResult => ({ outcome: 'skip', note: null, at: AT, by: 'person', staged: true, ...over });
/** The server's answer to a Skip: picked, waiting in the reply draft. */
const skippedInDraft = () => record(0, { state: 'picked', revision: 1, action_result: skip() });
/** The same skip after the person's Send. */
const skippedSent = () => record(0, { state: 'sent', revision: 1, sent_revision: 1, sent_reply_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YF', action_result: skip() });

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const rerender = (node: React.ReactNode) => act(() => root!.render(node));
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const click = (el: Element) => act(() => (el as HTMLElement).click());
const rowOf = (el: HTMLElement, index: number) => el.querySelector<HTMLElement>(`[data-action-card="${PARSED[index]!.key}"]`)!;
const chipOf = (row: HTMLElement) => row.querySelector('[data-action-line] .ib-badge')?.textContent ?? null;

test.skipIf(!hasDom)('Skip sits after Done and Can\'t do it…; one click marks it with no words, and the next open item opens', async () => {
  const marks: { key: string; mark: unknown }[] = [];
  const onMark = async (action: InboxQuestion, mark: unknown) => (marks.push({ key: action.key, mark }), true);
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={onMark} />);
  const buttons = [...rowOf(el, 0).querySelectorAll<HTMLButtonElement>('[data-action-panel] .ib-chk-acts button')];
  expect(buttons.map((b) => b.textContent)).toEqual(['Done', "Can't do it…", 'Skip']);
  click(buttons[2]!);
  await settle();
  // No reason box, no note: the mark is the outcome alone.
  expect(marks).toEqual([{ key: PARSED[0]!.key, mark: { outcome: 'skip' } }]);
  expect(el.querySelector('.ib-chk-compose')).toBeNull();
  expect(rowOf(el, 1).querySelector('[data-action-toggle]')!.getAttribute('aria-expanded')).toBe('true');
  expect(rowOf(el, 0).querySelector('[data-action-toggle]')!.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('a skip in the draft: quiet, the skip arrow and "Skipped" chip, "in your draft" with no note field; it waits on nobody; the tick takes it back', async () => {
  const marks: unknown[] = [];
  const onMark = async (_action: InboxQuestion, mark: unknown) => (marks.push(mark), true);
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={onMark} />);
  // Before: the open item stops the agent, and the agent watches it.
  expect(el.querySelector('[data-action-badge]')!.textContent).toBe('Stopped');
  expect(el.querySelector('[data-action-watching]')).not.toBeNull();

  rerender(<ActionChecklist actions={[skippedInDraft(), record(1)]} agent="Claude Code" onMark={onMark} />);
  const row = rowOf(el, 0);
  expect(row.getAttribute('data-action-state')).toBe('pending');
  expect(row.getAttribute('data-action-outcome')).toBe('skip');
  expect(chipOf(row)).toBe('Skipped');
  expect(row.querySelector('.ib-chk-dot [data-icon]')!.getAttribute('data-icon')).toBe('forward');
  const line = row.querySelector('[data-action-draft-line]')!.textContent!;
  expect(line.startsWith('Skipped ')).toBe(true);
  expect(line.endsWith(' · in your draft')).toBe(true);
  expect(row.querySelector('textarea')).toBeNull();
  // Counted apart, never as done, and still in the total.
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done · 1 skipped');
  // Not open: the card's Stopped badge and the watching line go at once.
  expect(el.querySelector('[data-action-badge]')).toBeNull();
  expect(el.querySelector('[data-action-watching]')).toBeNull();

  const tick = row.querySelector<HTMLButtonElement>('[data-action-tick]')!;
  expect(tick.getAttribute('aria-pressed')).toBe('true');
  // Never "Done: …, pressed" on a skipped row: the question card's own word for a skip that can be taken back.
  expect(tick.getAttribute('aria-label')).toBe('Unskip: Approve the production deploy on Vercel');
  click(tick);
  await settle();
  expect(marks).toEqual([null]);
});

test.skipIf(!hasDom)('a sent skip reads as skipped, not done, and offers nothing more', () => {
  const el = mount(<ActionChecklist actions={[skippedSent(), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const row = rowOf(el, 0);
  expect(row.getAttribute('data-action-state')).toBe('skipped');
  expect(chipOf(row)).toBe('Skipped');
  expect(row.querySelector('[data-action-tick]')).toBeNull();
  expect(row.querySelector('.ib-chk-dot [data-icon]')!.getAttribute('data-icon')).toBe('forward');
  act(() => row.querySelector<HTMLButtonElement>('[data-action-toggle]')!.click());
  const settled = row.querySelector('[data-action-panel] [data-action-settled]')!.textContent!;
  expect(settled.startsWith('You skipped it, ')).toBe(true);
  expect(settled.endsWith('. Sent to Claude Code with your reply.')).toBe(true);
  expect(row.querySelector('[data-action-panel] .ib-chk-acts')).toBeNull();
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done · 1 skipped');
});

test.skipIf(!hasDom)('the reply box lists a skip as Skipped; once sent, the list counts it by kind beside a Done', () => {
  const skipped = { id: 'm/a1', messageId: 'm', number: 1, prompt: 'Approve the production deploy on Vercel', outcome: 'skip' as const, note: null };
  const done = { id: 'm/a2', messageId: 'm', number: 2, prompt: 'Touch your security key for the npm org', outcome: 'done' as const, note: null };
  const el = mount(<ReplyActions actions={[skipped]} />);
  expect(el.querySelector('[data-action-row-outcome="skip"]')!.textContent).toBe('Skipped');
  rerender(<ReplyActions actions={[skipped]} sent />);
  expect(el.querySelector('.ib-ranswers-h')!.textContent).toBe('You skipped 1 action item');
  rerender(<ReplyActions actions={[done, skipped]} sent />);
  expect(el.querySelector('.ib-ranswers-h')!.textContent).toBe('You did 1 action item, skipped 1');
});

test('the Draft label counts a skip in the draft', () => {
  expect(unsentWords(rowUnsent({ reply_at: null, picks: 0, comments: 0, skipped: 1 }))).toBe('1 skipped');
  expect(unsentWords(rowUnsent({ reply_at: null, picks: 0, comments: 0, done: 1, skipped: 2 }))).toBe('1 done, 2 skipped');
});
