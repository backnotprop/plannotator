/**
 * The window's one toast (design record "inbox-toast", approved 2026-10-14):
 * its approved words (pure, always run), and under DOM_TESTS=1 (happy-dom,
 * from the test.yml DOM list) its shape, its actions, its place over the open
 * pane or the list, and the phone's short form.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { markReadToast } from './markRead';
import { InboxToast, TOAST_FOOT_GAP, TOAST_LIST_GAP, toastSpeech, type InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';

type Before = Parameters<typeof markReadToast>[0];
const author = { kind: 'agent', name: 'Claude Code', host: 'claude-code' } as InboxListRow['author'];
const questions = (over: Partial<InboxListRow['questions']> = {}) => ({ open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, ...over }) as unknown as InboxListRow['questions'];
const row = (over: Partial<Before> = {}): Before => ({ subject: 'Invoice list layout', author, questions: questions(), resolved_at: null, ...over });

describe('markReadToast: the approved words', () => {
  test('in a thread: Marked read (Read on a phone), and where it goes', () => {
    expect(markReadToast(row(), true)).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Moves to Quiet', warn: false });
    expect(markReadToast(row({ resolved_at: '2026-10-14T00:00:00Z' }), true)).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Goes back to Archived', warn: false });
  });

  test('from a row: where it went, and the subject that says which', () => {
    expect(markReadToast(row(), false)).toEqual({ lead: 'Moved to Quiet', detail: '“Invoice list layout”', warn: false });
    expect(markReadToast(row({ resolved_at: '2026-10-14T00:00:00Z' }), false)).toEqual({ lead: 'Back in Archived', detail: '“Invoice list layout”', warn: false });
  });

  test('an agent stopped or held up on it: a warning, in a thread or from a row', () => {
    for (const deferred of [true, false]) {
      expect(markReadToast(row({ questions: questions({ stopped: true }) }), deferred)).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Claude Code was stopped', warn: true });
      const held = markReadToast(row({ questions: questions({ holds_up: ['the deploy', 'the release'] }) }), deferred);
      expect(held).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Held up 2 things', warn: true });
    }
  });
});

test('toastSpeech: the live region reads the lead and the detail as sentences', () => {
  expect(toastSpeech({ lead: 'Marked read', detail: 'Moves to Quiet' })).toBe('Marked read. Moves to Quiet.');
  expect(toastSpeech({ lead: 'Moved to Quiet', detail: '“Invoice list layout”' })).toBe('Moved to Quiet. “Invoice list layout”');
  expect(toastSpeech({ lead: 'Archived' })).toBe('Archived.');
  // An error's own message keeps its punctuation.
  expect(toastSpeech({ lead: 'The thread did not change.' })).toBe('The thread did not change.');
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** A fixed box for an element (happy-dom lays nothing out). */
function boxAt(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** A 1400 × 900 window: the list column, and (with `thread`) an open pane beside it whose foot starts at y 820. */
function windowWith(thread: boolean): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  boxAt(host, 0, 0, 1400, 900);
  const main = document.createElement('main');
  main.className = 'ib-main';
  const list = document.createElement('div');
  list.className = 'ib-listcol';
  boxAt(list, 240, 0, thread ? 380 : 1160, 900);
  main.appendChild(list);
  if (thread) {
    const pane = document.createElement('section');
    pane.className = 'ib-pane';
    boxAt(pane, 620, 0, 780, 900);
    const foot = document.createElement('div');
    foot.className = 'ib-pfoot';
    boxAt(foot, 620, 820, 780, 80);
    pane.appendChild(foot);
    main.appendChild(pane);
  }
  host.appendChild(main);
  document.body.appendChild(host);
  return host;
}

function show(toast: Omit<InboxToastModel, 'id'>, phone = false, into?: HTMLElement): HTMLElement {
  const target = into ?? (() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    return host;
  })();
  const mount = document.createElement('div');
  target.appendChild(mount);
  root = createRoot(mount);
  act(() => root!.render(<InboxToast toast={{ id: 1, ...toast }} phone={phone} />));
  return target.querySelector('[data-inbox-toast]') as HTMLElement;
}

const buttons = (toast: HTMLElement) => [...toast.querySelectorAll('button')].map((b) => b.textContent);

test.skipIf(!hasDom)('desktop warning: one line (icon, lead, detail), Reply and Undo with its Z hint, no close', () => {
  let undone = 0;
  let replied = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), true);
  expect(warn).toBe(true);
  const toast = show({ ...copy, icon: 'warn', onUndo: () => undone++, onReply: () => replied++ });
  expect(toast.classList.contains('ib-toast-warn')).toBe(true);
  expect(toast.classList.contains('ib-toast-wrap')).toBe(false);
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe('Marked read');
  expect(toast.querySelector('.ib-tdetail')?.textContent).toBe('Claude Code was stopped');
  // Reply and Undo, nothing else: the × is gone (the toast leaves on its own).
  expect(buttons(toast)).toEqual(['Reply', 'UndoZ']);
  expect(toast.querySelector('[aria-label="Dismiss"]')).toBeNull();
  // The Z hint is for the eye; the button's name stays "Undo" and it says its key.
  const undo = toast.querySelector('[data-toast-undo]') as HTMLButtonElement;
  expect(undo.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  expect(undo.getAttribute('aria-keyshortcuts')).toBe('Z');
  act(() => undo.click());
  act(() => (toast.querySelector('[data-toast-reply]') as HTMLButtonElement).click());
  expect([undone, replied]).toEqual([1, 1]);
});

test.skipIf(!hasDom)('with a thread open it sits centered over the thread pane, 12 px above its foot', () => {
  const win = windowWith(true);
  const toast = show({ icon: 'check', lead: 'Marked read', detail: 'Moves to Quiet', onUndo: () => {} }, false, win);
  // Pane 620..1400: center 1010. Foot top 820 in a 900 px window: 80 + 12 from the bottom.
  expect(toast.style.left).toBe('1010px');
  expect(toast.style.bottom).toBe(`${80 + TOAST_FOOT_GAP}px`);
  expect(toast.style.maxWidth).toBe('min(520px, 748px)');
});

test.skipIf(!hasDom)('with no thread open it sits centered over the list, near its bottom; it follows a thread that closes', async () => {
  const win = windowWith(false);
  const toast = show({ icon: 'check', lead: 'Moved to Quiet', detail: '“Invoice list layout”', onUndo: () => {} }, false, win);
  // List 240..1400: center 820.
  expect(toast.style.left).toBe('820px');
  expect(toast.style.bottom).toBe(`${TOAST_LIST_GAP}px`);

  // A thread opens while the toast is up: it moves over the pane.
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  boxAt(pane, 620, 0, 780, 900);
  const foot = document.createElement('div');
  foot.className = 'ib-pfoot';
  boxAt(foot, 620, 820, 780, 80);
  pane.appendChild(foot);
  act(() => win.querySelector('main')!.appendChild(pane));
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  expect(toast.style.left).toBe('1010px');
  expect(toast.style.bottom).toBe(`${80 + TOAST_FOOT_GAP}px`);
});

test.skipIf(!hasDom)('a phone: "Read" for "Marked read", no Reply and no Z hint, and Undo undoes', () => {
  let undone = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), true);
  const toast = show({ ...copy, icon: warn ? 'warn' : 'check', onUndo: () => undone++, onReply: () => {} }, true);
  expect(toast.classList.contains('ib-toast-phone')).toBe(true);
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe('Read');
  expect(toast.querySelector('.ib-tdetail')?.textContent).toBe('Claude Code was stopped');
  expect(buttons(toast)).toEqual(['Undo']);
  expect(toast.querySelector('kbd')).toBeNull();
  act(() => (toast.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  expect(undone).toBe(1);
});

test.skipIf(!hasDom)('an error keeps its message whole and may wrap, with no actions', () => {
  const message = 'The thread did not change: the Inbox could not be reached.';
  for (const phone of [false, true]) {
    const toast = show({ icon: 'warn', lead: message, wrap: true }, phone);
    expect(toast.querySelector('.ib-tlead')?.textContent).toBe(message);
    expect(toast.classList.contains('ib-toast-wrap')).toBe(true);
    expect(toast.querySelectorAll('button').length).toBe(0);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});
