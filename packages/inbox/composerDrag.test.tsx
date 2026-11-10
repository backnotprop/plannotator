/**
 * Moving full screen's composer card out of the way (composerDrag.ts, FullScreenComposer.tsx).
 *
 * Proves: a drag by the tray moves the card (a press that hardly moves does not); the card stays inside its view with
 * a margin, also when the view gets smaller or the card grows, and goes back to where it was put when there is room
 * again; a press on a tab still picks the tab and never moves the card; where it was put holds through a tab switch,
 * typing, the tools gathered and brought back, and the card folded to its pill and opened again; another file puts it
 * home; a double click on the tray puts it home; a press on the tray leaves focus where it was; a phone's card does
 * not move.
 *
 * happy-dom lays nothing out, so the card's and its view's boxes are given here (`layout`).
 *
 * The pure clamp runs everywhere; the rest is DOM-gated: under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clampOffset, DRAG_MARGIN } from './composerDrag';
import type { FullScreenComposerValue } from './components/FullScreenComposer';

const hasDom = typeof document !== 'undefined';
const { FullScreenComposer } = (hasDom ? await import('./components/FullScreenComposer') : {}) as typeof import('./components/FullScreenComposer');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');

test('the clamp keeps the whole card a margin inside its view, and leaves a card with no room at home', () => {
  const home = { left: 300, top: 630, width: 600, height: 150 };
  const view = { width: 1200, height: 800 };
  expect(clampOffset({ x: -100, y: -200 }, home, view)).toEqual({ x: -100, y: -200 });
  expect(clampOffset({ x: 5000, y: -5000 }, home, view)).toEqual({ x: 300 - DRAG_MARGIN, y: DRAG_MARGIN - 630 });
  expect(clampOffset({ x: -5000, y: 5000 }, home, view)).toEqual({ x: DRAG_MARGIN - 300, y: 20 - DRAG_MARGIN });
  // Wider than the view allows: no sideways move at all.
  expect(clampOffset({ x: 40, y: -10 }, { ...home, left: 4, width: 600 }, { width: 608, height: 800 })).toEqual({ x: 0, y: -10 });
});

/** The view's size and the card's height, as a browser would lay them out: 600 px wide, centred, 20 px above the foot. */
const layout = { width: 1200, height: 800, card: 150 };
const noop = () => {};
let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void)[] = [];

function fakeLayout(): void {
  const define = (proto: object, name: string, get: (this: HTMLElement) => unknown) => {
    const had = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { configurable: true, get });
    restore.push(() => (had ? Object.defineProperty(proto, name, had) : delete (proto as Record<string, unknown>)[name]));
  };
  const isCard = (el: HTMLElement) => el.hasAttribute('data-fcomp');
  const proto = HTMLElement.prototype;
  define(proto, 'offsetParent', function () { return isCard(this) ? host : null; });
  define(proto, 'offsetWidth', function () { return isCard(this) ? Math.min(600, layout.width - 32) : 0; });
  define(proto, 'offsetHeight', function () { return isCard(this) ? layout.card : 0; });
  // `left: 50%`: the card's layout box starts at the view's middle (its transform centres it).
  define(proto, 'offsetLeft', function () { return isCard(this) ? layout.width / 2 : 0; });
  define(proto, 'offsetTop', function () { return isCard(this) ? layout.height - 20 - layout.card : 0; });
  define(proto, 'clientWidth', function () { return this === host ? layout.width : 0; });
  define(proto, 'clientHeight', function () { return this === host ? layout.height : 0; });
}

function valueOf(patch: Partial<FullScreenComposerValue> = {}, words = ''): FullScreenComposerValue {
  return {
    threadId: 'thr_drag',
    phone: false,
    onGather: noop,
    fileKey: 'att_a:current',
    reply: {
      to: 'Claude Code',
      value: words,
      onChange: noop,
      onLateVoice: noop,
      onSend: noop,
      sending: false,
      canSend: false,
      picks: 0,
      annotations: 0,
      comments: { records: [], attachments: [], onEdit: async () => {}, onRemove: async () => {}, onOpen: noop, editing: null, onEditing: noop, list: null, onList: noop } as unknown as FullScreenComposerValue['reply']['comments'],
      actions: 0,
      files: [],
      onFiles: noop,
      onDropFiles: noop,
      onPaste: noop,
      onRemoveFile: noop,
      onPutBack: noop,
      openQuestions: 0,
      openActions: 0,
      conflict: false,
      error: null,
      sentAt: null,
      onOpenThread: noop,
    },
    ...patch,
  };
}

let setValue: (patch: Partial<FullScreenComposerValue>) => void = noop;

/** The card over a page, with the page's comment row standing in as one field. The reply's words are held here. */
function Harness({ first }: { first: Partial<FullScreenComposerValue> }) {
  const [patch, setPatch] = useState(first);
  const [words, setWords] = useState('');
  setValue = (next) => setPatch((had) => ({ ...had, ...next }));
  const value = valueOf(patch, words);
  value.reply.onChange = setWords;
  return <FullScreenComposer value={value} noun="page" comment={<textarea aria-label="Comment on this page" data-page-row="" />} />;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function draw(first: Partial<FullScreenComposerValue> = {}): Promise<void> {
  act(() => {
    root = createRoot(host!);
    root.render(<Harness first={first} />);
  });
  await settle();
}

const card = () => host!.querySelector<HTMLElement>('[data-fcomp]')!;
const tray = () => host!.querySelector<HTMLElement>('.ib-fcomp-top')!;
const tab = (which: 'comment' | 'reply') => host!.querySelector<HTMLElement>(`[data-fcomp-mode="${which}"]`)!;
/** Where the card is drawn, from its home. */
const at = () => ({ x: parseFloat(card().style.getPropertyValue('--ib-fcomp-dx') || '0'), y: parseFloat(card().style.getPropertyValue('--ib-fcomp-dy') || '0') });

function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
  });
}

/** A press on `el` at (600, 640), moved by (dx, dy) in two steps, and let go. */
function dragBy(el: HTMLElement, dx: number, dy: number): void {
  pointer(el, 'pointerdown', 600, 640);
  pointer(el, 'pointermove', 600 + dx / 2, 640 + dy / 2);
  pointer(el, 'pointermove', 600 + dx, 640 + dy);
  pointer(el, 'pointerup', 600 + dx, 640 + dy);
}

beforeEach(() => {
  if (!hasDom) return;
  layout.width = 1200;
  layout.height = 800;
  layout.card = 150;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  fakeLayout();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const undo of restore.reverse()) undo();
  restore = [];
  resetComposerState();
});

test.skipIf(!hasDom)('a drag by the tray moves the card; a press that hardly moves does not', async () => {
  await draw();
  expect(at()).toEqual({ x: 0, y: 0 });
  dragBy(tray(), 2, 2);
  expect(at()).toEqual({ x: 0, y: 0 });
  dragBy(tray(), -180, -300);
  expect(at()).toEqual({ x: -180, y: -300 });
  // A second drag starts from where the card is.
  dragBy(tray(), 100, 50);
  expect(at()).toEqual({ x: -80, y: -250 });
  // Nothing is left marking a drag once the pointer is up.
  expect(card().hasAttribute('data-fcomp-dragging')).toBe(false);
});

test.skipIf(!hasDom)('the card is marked as dragged only while it moves, so no transition runs under the pointer', async () => {
  await draw();
  pointer(tray(), 'pointerdown', 600, 640);
  expect(card().hasAttribute('data-fcomp-dragging')).toBe(false);
  pointer(tray(), 'pointermove', 640, 600);
  expect(card().hasAttribute('data-fcomp-dragging')).toBe(true);
  expect(at()).toEqual({ x: 40, y: -40 });
  pointer(tray(), 'pointercancel', 640, 600);
  expect(card().hasAttribute('data-fcomp-dragging')).toBe(false);
  // The cancelled pointer's later moves are nobody's.
  pointer(tray(), 'pointermove', 700, 500);
  expect(at()).toEqual({ x: 40, y: -40 });
});

test.skipIf(!hasDom)('the card stays inside its view: at the edges, when the view gets smaller, and when the card grows', async () => {
  await draw();
  // Home: 300..900 across, 630..780 down, in a 1200 by 800 view.
  dragBy(tray(), 5000, -5000);
  expect(at()).toEqual({ x: 300 - DRAG_MARGIN, y: DRAG_MARGIN - 630 });
  dragBy(tray(), -9000, 9000);
  expect(at()).toEqual({ x: DRAG_MARGIN - 300, y: 20 - DRAG_MARGIN });
  // Put near the top right, then the window gets narrower: pushed back in.
  dragBy(tray(), 580, -500);
  expect(at()).toEqual({ x: 288, y: -488 });
  layout.width = 1000;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(at()).toEqual({ x: 200 - DRAG_MARGIN, y: -488 });
  // Room again: back where the person put it.
  layout.width = 1200;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(at()).toEqual({ x: 288, y: -488 });
  // Put at the very top, then the card grows as words are typed (it grows upward from its foot): still whole.
  dragBy(tray(), 0, -5000);
  expect(at().y).toBe(DRAG_MARGIN - 630);
  layout.card = 300;
  const field = host!.querySelector<HTMLTextAreaElement>('[data-page-row]')!;
  act(() => {
    field.value = 'line\nline\nline\nline\nline\nline';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(at().y).toBe(DRAG_MARGIN - 480);
});

test.skipIf(!hasDom)('a press on a tab picks the tab and never moves the card, even when the pointer slips', async () => {
  await draw();
  expect(card().getAttribute('data-fcomp-mode-on')).toBe('comment');
  const reply = tab('reply');
  pointer(reply, 'pointerdown', 500, 640);
  pointer(reply, 'pointerup', 500, 640);
  act(() => reply.click());
  await settle();
  expect(card().getAttribute('data-fcomp-mode-on')).toBe('reply');
  expect(at()).toEqual({ x: 0, y: 0 });
  // A press that starts on a tab and moves is still the tab's.
  dragBy(tab('comment'), -200, -200);
  expect(at()).toEqual({ x: 0, y: 0 });
  dragBy(host!.querySelector<HTMLElement>('[data-fcomp-minimize]')!, -200, -200);
  expect(at()).toEqual({ x: 0, y: 0 });
});

test.skipIf(!hasDom)('where the card was put holds through a tab switch, typing, and the tools gathered and brought back', async () => {
  await draw();
  dragBy(tray(), 150, -400);
  const put = { x: 150, y: -400 };
  act(() => tab('reply').click());
  await settle();
  expect(card().getAttribute('data-fcomp-mode-on')).toBe('reply');
  expect(at()).toEqual(put);
  const field = card().querySelector<HTMLTextAreaElement>('[data-fcomp-field] textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Looks right to me.');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(card().querySelector<HTMLTextAreaElement>('[data-fcomp-field] textarea')!.value).toBe('Looks right to me.');
  expect(at()).toEqual(put);
  act(() => tab('comment').click());
  await settle();
  expect(at()).toEqual(put);
  // The chevron gathers the tools (the pane's `tucked`), and the corner control brings them back.
  act(() => setValue({ tucked: true }));
  await settle();
  expect(at()).toEqual(put);
  act(() => setValue({ tucked: false }));
  await settle();
  expect(at()).toEqual(put);
});

test.skipIf(!hasDom)('a card folded to its pill opens again where it was put', async () => {
  // A host with no gather: the chevron folds the card to its pill, and the card's element goes.
  await draw({ onGather: undefined });
  dragBy(tray(), -120, -260);
  act(() => host!.querySelector<HTMLElement>('[data-fcomp-minimize]')!.click());
  await settle();
  expect(host!.querySelector('[data-fcomp]')).toBeNull();
  act(() => host!.querySelector<HTMLElement>('[data-fcomp-pill]')!.click());
  await settle();
  expect(at()).toEqual({ x: -120, y: -260 });
});

test.skipIf(!hasDom)('another file shows the card at its home again; the same file keeps it', async () => {
  await draw();
  dragBy(tray(), 200, -350);
  act(() => setValue({ fileKey: 'att_a:current', tucked: false }));
  await settle();
  expect(at()).toEqual({ x: 200, y: -350 });
  act(() => setValue({ fileKey: 'att_b:current' }));
  await settle();
  expect(at()).toEqual({ x: 0, y: 0 });
  expect(card().hasAttribute('data-fcomp-moved')).toBe(false);
  // Back on the first file: home too. Nothing is remembered for a file that was left.
  act(() => setValue({ fileKey: 'att_a:current' }));
  await settle();
  expect(at()).toEqual({ x: 0, y: 0 });
});

test.skipIf(!hasDom)('a double click on the tray puts the card home; one on a tab does not', async () => {
  await draw();
  dragBy(tray(), 200, -350);
  act(() => {
    tab('reply').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  expect(at()).toEqual({ x: 200, y: -350 });
  act(() => {
    tray().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  expect(at()).toEqual({ x: 0, y: 0 });
  // The way home is the one move that eases.
  expect(card().hasAttribute('data-fcomp-homing')).toBe(true);
  // A drag started on the way home is direct again.
  dragBy(tray(), 40, -40);
  expect(card().hasAttribute('data-fcomp-homing')).toBe(false);
  expect(at()).toEqual({ x: 40, y: -40 });
});

test.skipIf(!hasDom)('a press on the tray leaves focus in the field; a press on a tab is not swallowed', async () => {
  await draw();
  const field = host!.querySelector<HTMLTextAreaElement>('[data-page-row]')!;
  act(() => field.focus());
  const down = (el: HTMLElement) => {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  // Prevented: the browser neither moves focus to the card nor starts selecting text.
  expect(down(tray())).toBe(true);
  dragBy(tray(), 90, -90);
  expect(document.activeElement).toBe(field);
  expect(down(tab('reply'))).toBe(false);
});

test.skipIf(!hasDom)('a phone’s card is docked: no handle, and a drag on its tray moves nothing', async () => {
  await draw({ phone: true });
  expect(tray().hasAttribute('data-fcomp-drag')).toBe(false);
  dragBy(tray(), -100, -200);
  expect(at()).toEqual({ x: 0, y: 0 });
});
