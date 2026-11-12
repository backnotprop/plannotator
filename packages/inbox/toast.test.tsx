import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { markReadToast } from './markRead';
import { InboxToast, splitErrorAction, toastSpeech, type InboxToastModel } from './components/Toast';

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
    expect(markReadToast(row({ questions: questions({ stopped: true }) }), 'held')).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: '“Invoice list layout”', warn: true });
  });

  test('a long agent name is cut to 40 in the toast, and said whole', () => {
    const long = { ...author, name: 'Claude Code (worktree agent-a0316994da8440ab5)' } as InboxListRow['author'];
    expect(markReadToast(row({ author: long, questions: questions({ stopped: true }) }), 'open')).toEqual({
      lead: 'Marked read',
      phoneLead: 'Read',
      detail: 'Claude Code (worktree agent-a0316994da8… was stopped',
      phoneDetail: 'Stopped · Claude Code (worktree agent-a0316994da8…',
      warn: true,
      speech: 'Marked read. Claude Code (worktree agent-a0316994da8440ab5) was stopped.',
    });
  });

  test('an agent stopped or held up on it: a warning, in the open thread or from a row', () => {
    for (const place of ['open', 'list'] as const) {
      expect(markReadToast(row({ questions: questions({ stopped: true }) }), place)).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Claude Code was stopped', phoneDetail: 'Stopped · Claude Code', warn: true });
      const held = markReadToast(row({ questions: questions({ holds_up: ['the deploy', 'the release'] }) }), place);
      expect(held).toEqual({ lead: 'Marked read', phoneLead: 'Read', detail: 'Held up 2 things', warn: true });
    }
  });
});

test('toastSpeech: the live region reads the lead and the detail as sentences, and says how to undo', () => {
  expect(toastSpeech({ lead: 'Marked read', detail: 'Moves to Quiet' })).toBe('Marked read. Moves to Quiet.');
  expect(toastSpeech({ lead: 'Moved to Quiet', detail: '“Invoice list layout”' })).toBe('Moved to Quiet. “Invoice list layout”');
  expect(toastSpeech({ lead: 'Archived' })).toBe('Archived.');
  expect(toastSpeech({ lead: 'The thread did not change.' })).toBe('The thread did not change.');
  const undo = () => {};
  expect(toastSpeech({ lead: 'Marked read', detail: 'Moves to Quiet', onUndo: undo })).toBe('Marked read. Moves to Quiet. Press Z to undo.');
  expect(toastSpeech({ lead: 'Archived', onUndo: undo }, true)).toBe('Archived. Undo is available.');
  expect(toastSpeech({ lead: 'Sent to Pi', detail: 'in ledger', speech: 'Sent to Pi in ledger. It takes it as its next turn.' })).toBe('Sent to Pi in ledger. It takes it as its next turn.');
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

function phoneWindow(touch: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767px') || (touch && query.includes('pointer: coarse')),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  if (hasDom) window.matchMedia = realMatchMedia!;
  if (hasDom) delete (document.documentElement as { clientWidth?: number }).clientWidth;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function boxAt(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

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
  expect(buttons(toast)).toEqual(['Reply', 'Undo', '']);
  expect(toast.querySelector('[data-toast-undo] kbd')?.getAttribute('data-keycap')).toBe('Z');
  expect([...toast.querySelectorAll('button')].at(-1)?.getAttribute('aria-label')).toBe('Dismiss');
  const undo = toast.querySelector('[data-toast-undo]') as HTMLButtonElement;
  expect(undo.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  expect(undo.getAttribute('aria-keyshortcuts')).toBe('Z');
  act(() => undo.click());
  act(() => (toast.querySelector('[data-toast-reply]') as HTMLButtonElement).click());
  expect([undone, replied, dismissed]).toEqual([1, 1, 0]);
  act(() => (toast.querySelector('[data-toast-dismiss]') as HTMLButtonElement).click());
  expect([undone, replied, dismissed]).toEqual([1, 1, 1]);
});

function pointer(type: string, x: number, y: number, pointerId: number, t: number): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'timeStamp', { value: t });
  return event;
}

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
      drag(toast, [[600, 860], [610, 861], [680, 862], [740, 862], [800, 862]]);
      expect(count()).toEqual({ dismissed: 1, undone: 0 });
      expect(holds).toEqual([true]);
    });

    test(`${where}: a short drag springs back and keeps it; its timer resumes, and the entrance does not replay`, () => {
      const { toast, holds, count } = swipeable(phone);
      drag(toast, [[600, 860], [610, 860], [625, 860], [640, 860], [655, 860], [670, 860]]);
      expect(count()).toEqual({ dismissed: 0, undone: 0 });
      expect(holds).toEqual([true, false]);
      expect(toast.style.translate).toBe('');
      expect(toast.style.opacity).toBe('');
      expect(toast.style.animation).toBe('none');
      expect(toast.classList.contains('ib-toast-dragging')).toBe(false);
    });
  }

  test('a fast flick dismisses it from a shorter drag', () => {
    const { toast, count } = swipeable();
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
  phoneWindow(true);
  let undone = 0;
  const { warn, ...copy } = markReadToast(row({ questions: questions({ stopped: true }) }), 'open');
  const toast = show({ ...copy, icon: warn ? 'warn' : 'check', onUndo: () => undone++, onReply: () => {} }, true, undefined, () => {});
  expect(toast.classList.contains('ib-toast-phone')).toBe(true);
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe('Read');
  expect(toast.querySelector('.ib-tdetail')?.textContent).toBe('Stopped · Claude Code');
  expect(buttons(toast)).toEqual(['Undo', '']);
  expect(toast.querySelector('[data-toast-dismiss]')?.getAttribute('aria-label')).toBe('Dismiss');
  expect(toast.querySelector('kbd')).toBeNull();
  act(() => (toast.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  expect(undone).toBe(1);
});

test.skipIf(!hasDom)('a narrow desktop window (the phone layout, a mouse) keeps Reply and Undo\'s Z: no foot holds Reply there, and the keys work', () => {
  phoneWindow(false);
  let replied = 0;
  const toast = show({ icon: 'check', lead: 'Marked read', phoneLead: 'Read', detail: 'Moves to Quiet', onUndo: () => {}, onReply: () => replied++ }, true, undefined, () => {});
  expect(toast.classList.contains('ib-toast-phone')).toBe(true);
  expect(buttons(toast)).toEqual(['Reply', 'Undo', '']);
  const undo = toast.querySelector('[data-toast-undo]')!;
  expect(undo.querySelector('kbd')?.getAttribute('data-keycap')).toBe('Z');
  expect(undo.getAttribute('aria-keyshortcuts')).toBe('Z');
  act(() => ([...toast.querySelectorAll('button')].find((b) => b.textContent === 'Reply') as HTMLButtonElement).click());
  expect(replied).toBe(1);
});

test.skipIf(!hasDom)('a phone toast sits above a full-screen file\'s bar, and moves when a thread\'s foot appears under it', async () => {
  phoneWindow(true);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const page = document.createElement('div');
  document.body.appendChild(page);
  host = page;
  const dock = document.createElement('div');
  dock.className = 'ib-fvdock-phone';
  const bar = document.createElement('div');
  bar.className = 'ib-fvbar';
  boxAt(bar, 0, 740, 390, 60);
  dock.appendChild(bar);
  page.appendChild(dock);
  const toast = show({ icon: 'check', lead: 'Marked read', onUndo: () => {} }, true, page, () => {});
  expect(toast.style.bottom).toBe('68px');
  dock.remove();
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  const foot = document.createElement('div');
  foot.className = 'ib-pfoot';
  boxAt(foot, 0, 700, 390, 100);
  pane.appendChild(foot);
  act(() => page.appendChild(pane));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(toast.style.bottom).toBe('108px');
  delete (window as { innerHeight?: number }).innerHeight;
});

test('splitErrorAction: what happened, then what to do (the last sentence), together the message itself', () => {
  const two = 'The Inbox could not save your reply because the disk is full. Free some space and try again.';
  expect(splitErrorAction(two)).toEqual({ head: 'The Inbox could not save your reply because the disk is full. ', action: 'Free some space and try again.' });
  const three = 'It stopped. Nothing was lost! Try again?';
  expect(splitErrorAction(three).action).toBe('Try again?');
  expect(splitErrorAction(three).head + splitErrorAction(three).action).toBe(three);
  expect(splitErrorAction('The thread did not change.')).toEqual({ head: 'The thread did not change.', action: '' });
  expect(splitErrorAction('Could not open notes.v2.md')).toEqual({ head: 'Could not open notes.v2.md', action: '' });
});

test.skipIf(!hasDom)('an error of two sentences keeps its last, what to do, in its own span (inbox.css keeps it whole when the rest is cut)', () => {
  const message = 'The Inbox could not save your reply because the disk is full. Free some space and try again.';
  const toast = show({ icon: 'warn', lead: message, wrap: true }, false, undefined, () => {});
  expect(toast.querySelector('.ib-tlead')?.textContent).toBe(message);
  expect(toast.querySelector('.ib-taction')?.textContent).toBe('Free some space and try again.');
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
    act(() => (toast.querySelector('[data-toast-dismiss]') as HTMLButtonElement).focus());
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(pane.querySelector('.ib-pback'));
  } finally {
    page.remove();
  }
});
