/**
 * The window's one toast (design record "inbox-toast", approved 2026-10-14):
 * its approved words (pure, always run), and under DOM_TESTS=1 (happy-dom,
 * from tests/dom-test-list.txt) its shape, its actions, that a desktop toast
 * never moves for what is open (its place, the window's bottom center, is
 * CSS and is measured in tests/e2e/inbox-mark-read.spec.ts), and the phone's
 * short form.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { markReadToast } from './markRead';
import { InboxToast, toastSpeech, type InboxToastModel } from './components/Toast';

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
  // A toast kept short for one line can say more to a screen reader.
  expect(toastSpeech({ lead: 'Sent to Pi', detail: 'in ledger', speech: 'Sent to Pi in ledger. It takes it as its next turn.' })).toBe('Sent to Pi in ledger. It takes it as its next turn.');
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (hasDom) delete (document.documentElement as { clientWidth?: number }).clientWidth;
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
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1400 });
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

function show(toast: Omit<InboxToastModel, 'id'>, phone = false, into?: HTMLElement, onDismiss?: () => void, onHold?: (held: boolean) => void): HTMLElement {
  const target = into ?? (() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    return host;
  })();
  const mount = document.createElement('div');
  target.appendChild(mount);
  root = createRoot(mount);
  act(() => root!.render(<InboxToast toast={{ id: 1, ...toast }} phone={phone} onDismiss={onDismiss} onHold={onHold} />));
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

test.skipIf(!hasDom)('desktop warning: one line (icon, lead, detail), Reply and Undo with its Z hint, then the × at the end', () => {
  let undone = 0;
  let replied = 0;
  let dismissed = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), 'open');
  expect(warn).toBe(true);
  const toast = show({ ...copy, icon: 'warn', onUndo: () => undone++, onReply: () => replied++ }, false, undefined, () => dismissed++);
  expect(toast.classList.contains('ib-toast-warn')).toBe(true);
  expect(toast.classList.contains('ib-toast-wrap')).toBe(false);
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe('Marked read');
  expect(toast.querySelector('.ib-tdetail')?.textContent).toBe('Claude Code was stopped');
  // Reply, Undo, and the × last (owner, 2026-10-20: a toast can be closed early).
  expect(buttons(toast)).toEqual(['Reply', 'Undo', '']);
  expect(toast.querySelector('[data-toast-undo] kbd')?.getAttribute('data-keycap')).toBe('Z');
  expect([...toast.querySelectorAll('button')].at(-1)?.getAttribute('aria-label')).toBe('Dismiss');
  // The Z hint is for the eye; the button's name stays "Undo" and it says its key.
  const undo = toast.querySelector('[data-toast-undo]') as HTMLButtonElement;
  expect(undo.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  expect(undo.getAttribute('aria-keyshortcuts')).toBe('Z');
  act(() => undo.click());
  act(() => (toast.querySelector('[data-toast-reply]') as HTMLButtonElement).click());
  expect([undone, replied, dismissed]).toEqual([1, 1, 0]);
  // The × dismisses, and never undoes.
  act(() => (toast.querySelector('[data-toast-dismiss]') as HTMLButtonElement).click());
  expect([undone, replied, dismissed]).toEqual([1, 1, 1]);
});

/** A touch pointer event at (x, y) at time `t` (happy-dom ignores a `timeStamp` init, so it is set on the event). */
function pointer(type: string, x: number, y: number, pointerId: number, t: number): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'timeStamp', { value: t });
  return event;
}

/** A pointer at (x, y) on `el`: down, the moves, then up (or a cancel, as when the page takes a vertical pan). */
function drag(el: HTMLElement, path: [number, number][], end: 'pointerup' | 'pointercancel' = 'pointerup', start = el) {
  const at = (type: string, [x, y]: [number, number], target: Element, t: number) => target.dispatchEvent(pointer(type, x, y, 7, 1000 + t));
  act(() => {
    at('pointerdown', path[0], start, 0);
  });
  path.slice(1).forEach((point, i) =>
    act(() => {
      at('pointermove', point, el, (i + 1) * 40);
    }),
  );
  act(() => {
    at(end, path.at(-1)!, el, path.length * 40);
  });
}

describe.skipIf(!hasDom)('swipe a toast away (owner, 2026-10-20)', () => {
  const swipeable = (phone = false) => {
    let dismissed = 0;
    let undone = 0;
    const holds: boolean[] = [];
    const toast = show({ icon: 'check', lead: 'Marked read', detail: 'Moves to Quiet', onUndo: () => undone++ }, phone, undefined, () => dismissed++, (held) => holds.push(held));
    boxAt(toast, 460, 840, 400, 40);
    return { toast, holds, count: () => ({ dismissed, undone }) };
  };

  for (const phone of [false, true]) {
    const where = phone ? 'a phone' : 'a desktop';
    test(`${where}: a drag past 40% of the width dismisses it, and never undoes; its timer was held from the drag's start`, () => {
      const { toast, holds, count } = swipeable(phone);
      // Slow (no flick), 200 px of a 400 px toast: half its width.
      drag(toast, [[600, 860], [610, 861], [680, 862], [740, 862], [800, 862]]);
      expect(count()).toEqual({ dismissed: 1, undone: 0 });
      expect(holds).toEqual([true]);
    });

    test(`${where}: a short drag springs back and keeps it; its timer resumes, and the entrance does not replay`, () => {
      const { toast, holds, count } = swipeable(phone);
      drag(toast, [[600, 860], [610, 860], [625, 860], [640, 860], [655, 860], [670, 860]]);
      expect(count()).toEqual({ dismissed: 0, undone: 0 });
      // Held while dragged, resumed on the spring-back.
      expect(holds).toEqual([true, false]);
      // Back where it was: nothing left on it from the drag but the entrance kept off (removing
      // ib-toast-dragging would otherwise bring back `animation: ib-toast-in` and replay it).
      expect(toast.style.translate).toBe('');
      expect(toast.style.opacity).toBe('');
      expect(toast.style.animation).toBe('none');
      expect(toast.classList.contains('ib-toast-dragging')).toBe(false);
    });
  }

  test('a fast flick dismisses it from a shorter drag', () => {
    const { toast, count } = swipeable();
    // 90 px in 80 ms: about 1.1 px per ms, well past the flick speed, though short of 40%.
    const at = (type: string, x: number, t: number) =>
      act(() => {
        toast.dispatchEvent(pointer(type, x, 860, 3, 1000 + t));
      });
    at('pointerdown', 600, 0);
    at('pointermove', 620, 20);
    at('pointermove', 660, 50);
    at('pointermove', 690, 80);
    at('pointerup', 690, 90);
    expect(count().dismissed).toBe(1);
  });

  test('a vertical drag is the page\'s, a cancelled drag springs back, and a drag that starts on a button is the button\'s', () => {
    const { toast, holds, count } = swipeable(true);
    drag(toast, [[600, 860], [602, 840], [604, 760], [700, 700]]);
    expect(count().dismissed).toBe(0);
    expect(holds).toEqual([]);
    drag(toast, [[600, 860], [620, 860], [800, 860]], 'pointercancel');
    expect(count().dismissed).toBe(0);
    expect(holds).toEqual([true, false]);
    drag(toast, [[600, 860], [620, 860], [800, 860]], 'pointerup', toast.querySelector('[data-toast-undo]') as HTMLElement);
    expect(count()).toEqual({ dismissed: 0, undone: 0 });
  });
});

test.skipIf(!hasDom)('a desktop toast stays where it is whatever opens: a thread, a file beside it, a full-screen file', async () => {
  const win = windowWith(false);
  const toast = show({ icon: 'check', lead: 'Moved to Quiet', detail: '“Invoice list layout”', onUndo: () => {} }, false, win);
  const placed = () => ({ style: toast.getAttribute('style'), className: toast.className });
  const first = placed();
  // Nothing measured onto it: the window's bottom center comes from inbox.css alone.
  expect(first.style).toBeNull();

  act(() => win.querySelector('main')!.appendChild(threadPane()));
  await nextFrame();
  expect(placed()).toEqual(first);

  const view = document.createElement('section');
  view.className = 'ib-view';
  boxAt(view, 620, 0, 780, 900);
  const foot = document.createElement('div');
  foot.setAttribute('data-view-foot', '');
  boxAt(foot, 620, 790, 780, 110);
  view.appendChild(foot);
  act(() => win.querySelector('main')!.appendChild(view));
  await nextFrame();
  expect(placed()).toEqual(first);

  act(() => view.classList.add('ib-full'));
  await nextFrame();
  expect(placed()).toEqual(first);
});

test.skipIf(!hasDom)('a phone: "Read" for "Marked read", no Reply and no Z hint, Undo undoes, and the × closes it', () => {
  let undone = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), 'open');
  const toast = show({ ...copy, icon: warn ? 'warn' : 'check', onUndo: () => undone++, onReply: () => {} }, true, undefined, () => {});
  expect(toast.classList.contains('ib-toast-phone')).toBe(true);
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe('Read');
  expect(toast.querySelector('.ib-tdetail')?.textContent).toBe('Claude Code was stopped');
  expect(buttons(toast)).toEqual(['Undo', '']);
  expect(toast.querySelector('[data-toast-dismiss]')?.getAttribute('aria-label')).toBe('Dismiss');
  expect(toast.querySelector('kbd')).toBeNull();
  act(() => (toast.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  expect(undone).toBe(1);
});

test.skipIf(!hasDom)('an error keeps its message whole and may wrap, with no actions but the ×', () => {
  const message = 'The thread did not change: the Inbox could not be reached.';
  for (const phone of [false, true]) {
    const toast = show({ icon: 'warn', lead: message, wrap: true }, phone, undefined, () => {});
    expect(toast.querySelector('.ib-tlead')?.textContent).toBe(message);
    expect(toast.classList.contains('ib-toast-wrap')).toBe(true);
    expect([...toast.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss']);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});

test.skipIf(!hasDom)('a toast leaving with focus inside and nowhere to return it gives focus to the open pane\'s visible header, never the body', () => {
  // A phone with a thread open: the list's heading is hidden, so the thread's ‹ Inbox takes focus.
  const page = document.createElement('div');
  page.className = 'pn-inbox';
  const main = document.createElement('main');
  main.className = 'ib-main';
  const heading = document.createElement('h1');
  heading.textContent = 'Inbox';
  heading.style.display = 'none';
  main.appendChild(heading);
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  pane.innerHTML = '<div class="ib-phead"><button type="button" class="ib-pback">Inbox</button></div><h2 class="ib-subject" tabindex="-1">Invoice list</h2>';
  main.appendChild(pane);
  page.appendChild(main);
  document.body.appendChild(page);
  try {
    const toast = show({ icon: 'check', lead: 'Archived', onUndo: () => {} }, true, page, () => {});
    // Focus arrives from nowhere (the body), then the toast goes.
    act(() => (toast.querySelector('[data-toast-dismiss]') as HTMLButtonElement).focus());
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(pane.querySelector('.ib-pback'));
  } finally {
    page.remove();
  }
});
