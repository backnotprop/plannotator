/**
 * The words of an action items card can be selected and copied (a person
 * asked: "why can't i select text from 'things only you can do'?"). Failures
 * to catch: the task's words (or its chip) back inside the row's toggle
 * button, where no drag or long press selects them; any of the card's words
 * under a `user-select: none` rule; a drag that selects the task's words
 * opening or closing the row; the toggle losing its name, its state or its
 * keyboard click; a plain click on the task no longer opening the row; a
 * double-click (it selects a word) leaving the row toggled.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

const hasDom = typeof document !== 'undefined';
const { ActionChecklist } = (hasDom ? await import('./components/ActionChecklist') : {}) as typeof import('./components/ActionChecklist');

const BODY = [
  ':::action',
  'Publish the two npm tarballs, in order',
  'The registry wants your security key, so only you can publish.',
  'Where: the repo root',
  'Run: `npm publish dist/acme-core-1.2.0.tgz --access public`',
  'Holds up: the 1.2 release',
  ':::',
  '',
  ':::action',
  'Touch your security key for the npm org',
  'npm asks for two-factor before it publishes.',
  ':::',
].join('\n');

const PARSED = parseInboxActionBlocks(BODY);

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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.getSelection()?.removeAllRanges();
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const rowOf = (el: HTMLElement, index: number) => el.querySelector<HTMLElement>(`[data-action-card="${PARSED[index]!.key}"]`)!;
const toggleOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-action-toggle]')!;
const taskOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-action-task]')!;
const expanded = (row: HTMLElement) => toggleOf(row).getAttribute('aria-expanded');

/** A press on `el` at `from`, let go at `to`: pointerdown, then the click the browser sends (`detail` its count). */
function press(el: HTMLElement, from: number, to = from, detail = 1) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: from, clientY: 10, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: to, clientY: 10, detail }));
  });
}

/** Select `el`'s words, as a drag over them leaves them. */
function selectWords(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

/** The selectors of every inbox.css rule that turns selection off (`user-select: none`). */
function noSelectSelectors(): string[] {
  const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[^-])user-select:\s*none/.test(match[2]!)) continue;
    out.push(...match[1]!.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

test.skipIf(!hasDom)("the card's words sit in no button and under no user-select: none rule (the task, its chip, the title, the why, the command)", () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1, { state: 'sent', action_result: { outcome: 'done', note: null, at: '2026-11-19T15:12:00.000Z', by: 'person', staged: true } })]} agent="Claude Code" onMark={async () => true} />);
  const card = el.querySelector<HTMLElement>('[data-action-group]')!;
  const words = [
    card.querySelector<HTMLElement>('[data-action-title]')!,
    taskOf(rowOf(el, 0)),
    taskOf(rowOf(el, 1)),
    rowOf(el, 1).querySelector<HTMLElement>('[data-action-line] .ib-badge')!,
    rowOf(el, 0).querySelector<HTMLElement>('[data-action-why]')!,
    rowOf(el, 0).querySelector<HTMLElement>('[data-action-holds]')!,
    rowOf(el, 0).querySelector<HTMLElement>('[data-action-cmd], [data-action-why] pre code')!,
  ];
  for (const w of words) expect(w, 'a part of the card').toBeTruthy();
  expect(rowOf(el, 1).querySelector('[data-action-line] .ib-badge')!.textContent).toBe('Done');
  const rules = noSelectSelectors();
  expect(rules.length).toBeGreaterThan(0);
  for (const w of words) {
    const walker = document.createTreeWalker(w, NodeFilter.SHOW_TEXT);
    let text: Node | null;
    let seen = 0;
    while ((text = walker.nextNode())) {
      const parent = text.parentElement!;
      // The command's "$ " prompt is left out of a copy on purpose.
      if (parent.closest('.ib-chk-ps') || !text.textContent!.trim()) continue;
      seen++;
      expect(parent.closest('button'), `"${text.textContent}" inside a button`).toBeNull();
      for (const sel of rules) {
        let hit: Element | null = null;
        try {
          hit = parent.closest(sel);
        } catch {
          continue; // a selector happy-dom cannot match (`:has`, a pseudo-element)
        }
        expect(hit, `"${text.textContent}" under "${sel}"`).toBeNull();
      }
    }
    expect(seen).toBeGreaterThan(0);
  }
});

test.skipIf(!hasDom)('the toggle keeps its name, state and keyboard click; a plain click on the task opens and closes the row', () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const a = rowOf(el, 0);
  const b = rowOf(el, 1);
  const toggle = toggleOf(b);
  expect(toggle.tagName).toBe('BUTTON');
  const name = toggle.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' ');
  expect(name).toBe('Touch your security key for the npm org');
  expect(toggle.getAttribute('aria-controls')).toBe(b.querySelector('[data-action-panel]')!.id);
  // The button's own click (Enter, Space, the line's free space) toggles once, not twice.
  act(() => toggle.click());
  expect(expanded(b)).toBe('true');
  expect(expanded(a)).toBe('false');
  act(() => toggle.click());
  expect(expanded(b)).toBe('false');
  // A plain click on the task's words, no selection: opens, then closes.
  press(taskOf(b), 20);
  expect(expanded(b)).toBe('true');
  press(taskOf(b), 20);
  expect(expanded(b)).toBe('false');
});

test.skipIf(!hasDom)('a drag that selects the task\'s words, a click that leaves a selection, and a double-click toggle nothing; a tick still marks Done', async () => {
  const marks: unknown[] = [];
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />);
  const a = rowOf(el, 0);
  expect(expanded(a)).toBe('true');
  // A drag across the words: the pointer moved and the words are selected.
  selectWords(taskOf(a));
  press(taskOf(a), 4, 160);
  expect(window.getSelection()!.toString()).toBe('Publish the two npm tarballs, in order');
  expect(expanded(a)).toBe('true');
  // Let go where it was pressed, but with words selected (a long press, a slow drag back).
  press(taskOf(a), 40);
  expect(expanded(a)).toBe('true');
  // A double-click selects a word: its first click toggles, its second takes that back.
  window.getSelection()!.removeAllRanges();
  press(taskOf(a), 40, 40, 1);
  press(taskOf(a), 40, 40, 2);
  expect(expanded(a)).toBe('true');
  expect(marks).toEqual([]);
  // The tick is its own button and still marks Done.
  await act(async () => a.querySelector<HTMLButtonElement>('[data-action-tick]')!.click());
  expect(marks).toEqual([{ outcome: 'done' }]);
});
