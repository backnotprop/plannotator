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
import { InboxToast, TOAST_FOOT_GAP, TOAST_LIST_GAP, TOAST_PANE_WAIT_MS, toastSpeech, type InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';

type Before = Parameters<typeof markReadToast>[0];
const author = { kind: 'agent', name: 'Claude Code', host: 'claude-code' } as InboxListRow['author'];
const questions = (over: Partial<InboxListRow['questions']> = {}) => ({ open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, ...over }) as unknown as InboxListRow['questions'];
const row = (over: Partial<Before> = {}): Before => ({ subject: 'Invoice list layout', author, questions: questions(), resolved_at: null, ...over });

describe('markReadToast: the approved words', () => {
  test('the open thread: Marked read (Read on a phone), and where it goes', () => {
    expect(markReadToast(row(), 'open')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Moves to Quiet', warn: false });
    expect(markReadToast(row({ resolved_at: '2026-10-14T00:00:00Z' }), 'open')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Goes back to Archived', warn: false });
  });

  test('a row with no thread open: where it went, and the subject that says which', () => {
    expect(markReadToast(row(), 'list')).toEqual({ lead: 'Moved to Quiet', detail: '“Invoice list layout”', warn: false });
    expect(markReadToast(row({ resolved_at: '2026-10-14T00:00:00Z' }), 'list')).toEqual({ lead: 'Back in Archived', detail: '“Invoice list layout”', warn: false });
  });

  test('a row while another thread is open: the subject, never words that read as the open thread', () => {
    expect(markReadToast(row(), 'held')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: '“Invoice list layout”', warn: false });
    expect(markReadToast(row({ resolved_at: '2026-10-14T00:00:00Z' }), 'held')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: '“Invoice list layout”', warn: false });
    // Still a warning (its icon and Reply), named by its subject.
    expect(markReadToast(row({ questions: questions({ stopped: true }) }), 'held')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: '“Invoice list layout”', warn: true });
  });

  test('an agent stopped or held up on it: a warning, in the open thread or from a row', () => {
    for (const place of ['open', 'list'] as const) {
      expect(markReadToast(row({ questions: questions({ stopped: true }) }), place)).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Claude Code was stopped', warn: true });
      const held = markReadToast(row({ questions: questions({ holds_up: ['the deploy', 'the release'] }) }), place);
      expect(held).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Held up 2 things', warn: true });
    }
  });
});

test('toastSpeech: the live region reads the lead and the detail as sentences, and says how to undo', () => {
  expect(toastSpeech({ lead: 'Marked read', detail: 'Moves to Quiet' })).toBe('Marked read. Moves to Quiet.');
  expect(toastSpeech({ lead: 'Moved to Quiet', detail: '“Invoice list layout”' })).toBe('Moved to Quiet. “Invoice list layout”');
  expect(toastSpeech({ lead: 'Archived' })).toBe('Archived.');
  // An error's own message keeps its punctuation.
  expect(toastSpeech({ lead: 'The thread did not change.' })).toBe('The thread did not change.');
  const undo = () => {};
  expect(toastSpeech({ lead: 'Marked read', detail: 'Moves to Quiet', onUndo: undo })).toBe('Marked read. Moves to Quiet. Press Z to undo.');
  expect(toastSpeech({ lead: 'Archived', onUndo: undo }, true)).toBe('Archived. Undo is available.');
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

function show(toast: Omit<InboxToastModel, 'id'>, phone = false, into?: HTMLElement, threadRouted = false): HTMLElement {
  const target = into ?? (() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    return host;
  })();
  const mount = document.createElement('div');
  target.appendChild(mount);
  root = createRoot(mount);
  act(() => root!.render(<InboxToast toast={{ id: 1, ...toast }} phone={phone} threadRouted={threadRouted} />));
  return target.querySelector('[data-inbox-toast]') as HTMLElement;
}

/** An open thread's pane (620..1400) whose foot starts at y 820. */
function threadPane(): HTMLElement {
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  boxAt(pane, 620, 0, 780, 900);
  const foot = document.createElement('div');
  foot.className = 'ib-pfoot';
  boxAt(foot, 620, 820, 780, 80);
  pane.appendChild(foot);
  return pane;
}

const nextFrame = () => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

const buttons = (toast: HTMLElement) => [...toast.querySelectorAll('button')].map((b) => b.textContent);

test.skipIf(!hasDom)('desktop warning: one line (icon, lead, detail), Reply and Undo with its Z hint, no close', () => {
  let undone = 0;
  let replied = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), 'open');
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
  act(() => win.querySelector('main')!.appendChild(threadPane()));
  await nextFrame();
  expect(toast.style.left).toBe('1010px');
  expect(toast.style.bottom).toBe(`${80 + TOAST_FOOT_GAP}px`);
});

test.skipIf(!hasDom)('a full-screen file: centered over the file, just above its foot strip, and over the file', () => {
  const win = windowWith(true);
  const view = document.createElement('section');
  view.className = 'ib-view ib-full';
  boxAt(view, 0, 0, 1400, 900);
  const foot = document.createElement('div');
  foot.setAttribute('data-view-foot', '');
  boxAt(foot, 0, 841, 1400, 59);
  view.appendChild(foot);
  win.querySelector('main')!.appendChild(view);
  const toast = show({ icon: 'check', lead: 'Archived', onUndo: () => {} }, false, win);
  // Not over the thread pane behind the file: the file's center, 59 + 12 above the bottom.
  expect(toast.style.left).toBe('700px');
  expect(toast.style.bottom).toBe(`${59 + TOAST_FOOT_GAP}px`);
  expect(toast.classList.contains('ib-toast-file')).toBe(true);
});

test.skipIf(!hasDom)('a thread still loading: the toast waits for its pane instead of sitting over the list first', async () => {
  const win = windowWith(false);
  const toast = show({ icon: 'check', lead: 'Back in your Inbox', detail: '“Invoice list layout”', onUndo: () => {} }, false, win, true);
  expect(toast.style.visibility).toBe('hidden');
  expect(toast.style.left).toBe('');
  act(() => win.querySelector('main')!.appendChild(threadPane()));
  await nextFrame();
  expect(toast.style.visibility).toBe('');
  expect(toast.style.left).toBe('1010px');
  expect(toast.style.bottom).toBe(`${80 + TOAST_FOOT_GAP}px`);
});

test.skipIf(!hasDom)('a thread whose pane never comes: after the wait the toast sits over the list', async () => {
  const win = windowWith(false);
  const toast = show({ icon: 'check', lead: 'Back in your Inbox', onUndo: () => {} }, false, win, true);
  expect(toast.style.visibility).toBe('hidden');
  await act(async () => new Promise((resolve) => setTimeout(resolve, TOAST_PANE_WAIT_MS + 50)));
  await nextFrame();
  expect(toast.style.visibility).toBe('');
  expect(toast.style.left).toBe('820px');
});

test.skipIf(!hasDom)('a phone: "Read" for "Marked read", no Reply and no Z hint, and Undo undoes', () => {
  let undone = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), 'open');
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
