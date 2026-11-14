/**
 * Moving full screen's composer card out of the way (composerDrag.ts, FullScreenComposer.tsx).
 *
 * Proves: a drag by the tray moves the card (a press that hardly moves does not); the card stays inside its view with
 * a margin, also when the view gets smaller or the card grows, and goes back to where it was put when there is room
 * again; a press on a tab still picks the tab and never moves the card; where it was put holds through a tab switch,
 * typing, the tools gathered and brought back, and the card folded to its pill and opened again; another file puts it
 * home; a double click on the tray puts it home; a press on the tray leaves focus where it was; a phone's card does
 * not move. Resizing: a card at home has no corners, a moved one has four; a corner moves and the opposite one
 * stays; never under the card's own size, never past the view's margin; the size holds through a tab switch and the
 * tools gathered; another file and the double click give the card's own size back; a smaller window limits it; it
 * goes narrower than it starts, down to a floor, where the tabs take short names; every corner reaches the margin.
 *
 * happy-dom lays nothing out, so the card's and its view's boxes are given here (`layout`).
 *
 * The pure clamp runs everywhere; the rest is DOM-gated: under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clampOffset, DRAG_MARGIN, MIN_WIDTH, resizeBox } from './composerDrag';
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
  // The size the person gave the card wins over its own, as inbox.css draws it (`data-fcomp-sized`).
  const given = (el: HTMLElement, name: string) => (el.hasAttribute('data-fcomp-sized') ? parseFloat(el.style.getPropertyValue(name)) : NaN);
  const cardHeight = (el: HTMLElement) => given(el, '--ib-fcomp-rh') || layout.card;
  define(proto, 'offsetWidth', function () { return isCard(this) ? given(this, '--ib-fcomp-rw') || Math.min(600, layout.width - 32) : 0; });
  // The field takes what the tray and the row of buttons (114 px) leave.
  define(proto, 'offsetHeight', function () {
    if (isCard(this)) return cardHeight(this);
    const within = this.tagName === 'TEXTAREA' ? this.closest<HTMLElement>('[data-fcomp]') : null;
    return within ? cardHeight(within) - 114 : 0;
  });
  // `left: 50%`: the card's layout box starts at the view's middle (its transform centres it).
  define(proto, 'offsetLeft', function () { return isCard(this) ? layout.width / 2 : 0; });
  define(proto, 'offsetTop', function () { return isCard(this) ? layout.height - 20 - cardHeight(this) : 0; });
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
  return <FullScreenComposer value={value} noun="page" comment={<textarea aria-label="Comment on this page" data-page-row="" style={{ minHeight: 36 }} />} />;
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

// ── Resizing by the corners ──────────────────────────────────────────────────────────────────────────────────────────

test('a corner moves and the opposite one stays, never under the least size, never past the margin', () => {
  const from = { left: 100, top: 200, right: 700, bottom: 320 };
  const min = { w: 600, h: 120 };
  const view = { width: 1200, height: 800 };
  expect(resizeBox(from, 'se', 100, 80, min, view)).toEqual({ left: 100, top: 200, right: 800, bottom: 400 });
  expect(resizeBox(from, 'nw', -60, -100, min, view)).toEqual({ left: 40, top: 100, right: 700, bottom: 320 });
  // Smaller than the card is by itself: held at its least, the opposite corner still where it was.
  expect(resizeBox(from, 'se', -300, -300, min, view)).toEqual(from);
  expect(resizeBox(from, 'nw', 300, 300, min, view)).toEqual(from);
  // Past the view: held a margin in.
  expect(resizeBox(from, 'se', 5000, 5000, min, view)).toEqual({ left: 100, top: 200, right: 1200 - DRAG_MARGIN, bottom: 800 - DRAG_MARGIN });
  expect(resizeBox(from, 'nw', -5000, -5000, min, view)).toEqual({ left: DRAG_MARGIN, top: DRAG_MARGIN, right: 700, bottom: 320 });
  // An odd width is made even on the moving edge, so the centre is on a whole pixel.
  expect(resizeBox(from, 'ne', 51, 0, min, view).right).toBe(750);
});

const corners = () => [...host!.querySelectorAll<HTMLElement>('[data-fcomp-resize]')];
const cornerAt = (which: string) => host!.querySelector<HTMLElement>(`[data-fcomp-resize="${which}"]`)!;
/** The card's box in its view, as drawn: its layout box (centred on `left`, on its foot) moved by its transform. */
const boxNow = () => {
  const el = card();
  const left = el.offsetLeft - el.offsetWidth / 2 + at().x;
  const top = el.offsetTop + at().y;
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
};
const sizeNow = () => ({ w: card().offsetWidth, h: card().offsetHeight });

test.skipIf(!hasDom)('a card at home has no corners; a moved one has four, and they go when it is home again', async () => {
  await draw();
  expect(corners()).toHaveLength(0);
  expect(card().hasAttribute('data-fcomp-sized')).toBe(false);
  dragBy(tray(), 100, -300);
  await settle();
  expect(corners().map((el) => el.getAttribute('data-fcomp-resize')).sort()).toEqual(['ne', 'nw', 'se', 'sw']);
  act(() => {
    tray().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  await settle();
  expect(corners()).toHaveLength(0);
});

test.skipIf(!hasDom)('a corner resizes the card and the opposite corner stays where it was', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  // 400..1000 across, 330..480 down.
  expect(boxNow()).toEqual({ left: 400, top: 330, right: 1000, bottom: 480 });
  dragBy(cornerAt('se'), 100, 120);
  expect(sizeNow()).toEqual({ w: 700, h: 270 });
  expect(boxNow()).toEqual({ left: 400, top: 330, right: 1100, bottom: 600 });
  dragBy(cornerAt('nw'), -60, -100);
  expect(boxNow()).toEqual({ left: 340, top: 230, right: 1100, bottom: 600 });
  dragBy(cornerAt('ne'), -20, 40);
  expect(boxNow()).toEqual({ left: 340, top: 270, right: 1080, bottom: 600 });
  dragBy(cornerAt('sw'), 40, -30);
  expect(boxNow()).toEqual({ left: 380, top: 270, right: 1080, bottom: 570 });
  expect(card().hasAttribute('data-fcomp-resizing')).toBe(false);
  expect(card().hasAttribute('data-fcomp-dragging')).toBe(false);
});

test.skipIf(!hasDom)('never smaller than the card is by itself, never past the view’s margin', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  // Narrower than it starts (600), down to the floor; no lower than its tray, one line and its buttons (150 here).
  dragBy(cornerAt('se'), -180, -400);
  expect(sizeNow()).toEqual({ w: 420, h: 150 });
  dragBy(cornerAt('se'), -400, -400);
  expect(sizeNow()).toEqual({ w: MIN_WIDTH, h: 150 });
  expect(boxNow()).toEqual({ left: 400, top: 330, right: 400 + MIN_WIDTH, bottom: 480 });
  dragBy(cornerAt('se'), 5000, 5000);
  expect(boxNow()).toEqual({ left: 400, top: 330, right: 1200 - DRAG_MARGIN, bottom: 800 - DRAG_MARGIN });
  dragBy(cornerAt('nw'), -5000, -5000);
  expect(boxNow()).toEqual({ left: DRAG_MARGIN, top: DRAG_MARGIN, right: 1200 - DRAG_MARGIN, bottom: 800 - DRAG_MARGIN });
  // Back down from the largest: the floor again, not less, the bottom right corner still at the margin.
  dragBy(cornerAt('nw'), 5000, 5000);
  expect(sizeNow()).toEqual({ w: MIN_WIDTH, h: 150 });
  expect(boxNow()).toEqual({ left: 1200 - DRAG_MARGIN - MIN_WIDTH, top: 800 - DRAG_MARGIN - 150, right: 1200 - DRAG_MARGIN, bottom: 800 - DRAG_MARGIN });
  // A smaller window limits the size as it limits the place.
  dragBy(cornerAt('nw'), -5000, -5000);
  layout.width = 900;
  layout.height = 600;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(sizeNow()).toEqual({ w: 900 - 2 * DRAG_MARGIN, h: 600 - 2 * DRAG_MARGIN });
  expect(boxNow()).toEqual({ left: DRAG_MARGIN, top: DRAG_MARGIN, right: 900 - DRAG_MARGIN, bottom: 600 - DRAG_MARGIN });
});

test.skipIf(!hasDom)('the size holds through a tab switch, typing and the tools gathered; the card can still be dragged', async () => {
  await draw();
  dragBy(tray(), 0, -400);
  await settle();
  dragBy(cornerAt('se'), 80, 100);
  const size = { w: 680, h: 250 };
  expect(sizeNow()).toEqual(size);
  act(() => tab('reply').click());
  await settle();
  expect(sizeNow()).toEqual(size);
  act(() => setValue({ tucked: true }));
  await settle();
  act(() => setValue({ tucked: false }));
  await settle();
  expect(sizeNow()).toEqual(size);
  const before = boxNow();
  dragBy(tray(), -50, 60);
  expect(sizeNow()).toEqual(size);
  expect(boxNow()).toEqual({ left: before.left - 50, top: before.top + 60, right: before.right - 50, bottom: before.bottom + 60 });
});

test.skipIf(!hasDom)('another file gives the card its own size and home back; so does a double click on the tray', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  dragBy(cornerAt('se'), 100, 120);
  expect(card().hasAttribute('data-fcomp-sized')).toBe(true);
  act(() => setValue({ fileKey: 'att_b:current' }));
  await settle();
  expect(card().hasAttribute('data-fcomp-sized')).toBe(false);
  expect(sizeNow()).toEqual({ w: 600, h: 150 });
  expect(card().hasAttribute('data-fcomp-narrow')).toBe(false);
  expect(at()).toEqual({ x: 0, y: 0 });
  expect(corners()).toHaveLength(0);
  dragBy(tray(), 100, -300);
  await settle();
  dragBy(cornerAt('nw'), -100, -120);
  // A double click on a corner is the corner's, not the tray's under it.
  act(() => {
    cornerAt('nw').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  expect(card().hasAttribute('data-fcomp-sized')).toBe(true);
  act(() => {
    tray().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  await settle();
  expect(card().hasAttribute('data-fcomp-sized')).toBe(false);
  expect(at()).toEqual({ x: 0, y: 0 });
  expect(corners()).toHaveLength(0);
});

test.skipIf(!hasDom)('every corner grows the card to the view’s margin on its two sides, wherever the card sits', async () => {
  const far: Record<string, [number, number]> = { nw: [-5000, -5000], ne: [5000, -5000], sw: [-5000, 5000], se: [5000, 5000] };
  // Near the left edge, near the right edge, and in the middle: the keep-inside rule never stops a corner early.
  for (const [dx, dy] of [[-5000, -300], [5000, -300], [0, -300]] as const) {
    await draw();
    dragBy(tray(), dx, dy);
    await settle();
    for (const which of ['nw', 'ne', 'sw', 'se']) {
      const before = boxNow();
      dragBy(cornerAt(which), ...far[which]!);
      const now = boxNow();
      expect(now).toEqual({
        left: which.endsWith('w') ? DRAG_MARGIN : before.left,
        right: which.endsWith('e') ? 1200 - DRAG_MARGIN : before.right,
        top: which.startsWith('n') ? DRAG_MARGIN : before.top,
        bottom: which.startsWith('s') ? 800 - DRAG_MARGIN : before.bottom,
      });
    }
    expect(sizeNow()).toEqual({ w: 1200 - 2 * DRAG_MARGIN, h: 800 - 2 * DRAG_MARGIN });
    act(() => root?.unmount());
    root = null;
  }
});

test.skipIf(!hasDom)('made narrow, the tabs take their short names and keep their whole ones; every control is still there', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  const label = (which: 'comment' | 'reply') => tab(which).querySelector<HTMLElement>('.ib-fcomp-tabl')!;
  expect(card().hasAttribute('data-fcomp-narrow')).toBe(false);
  expect(tab('reply').getAttribute('title')).toBeNull();
  dragBy(cornerAt('se'), -400, 0);
  await settle();
  expect(sizeNow().w).toBe(MIN_WIDTH);
  expect(card().hasAttribute('data-fcomp-narrow')).toBe(true);
  // What the tab draws, and what it is still called.
  expect(label('comment').getAttribute('data-short')).toBe('Comment');
  expect(label('reply').getAttribute('data-short')).toBe('Reply');
  expect(label('comment').textContent).toBe('Comment on this page');
  expect(tab('reply').getAttribute('title')).toBe('Reply to Claude Code');
  expect(host!.querySelector('[data-fcomp-minimize]')).not.toBeNull();
  // The tab still switches, and the reply's row is all there.
  act(() => tab('reply').click());
  await settle();
  expect(card().getAttribute('data-fcomp-mode-on')).toBe('reply');
  for (const part of ['[data-fcomp-send]', '[data-fcomp-attach]', '[data-fcomp-open-thread]', '[data-fcomp-bin]']) expect(card().querySelector(part)).not.toBeNull();
  // Wide again: the whole names are drawn, with no tooltip.
  dragBy(cornerAt('se'), 400, 0);
  await settle();
  expect(card().hasAttribute('data-fcomp-narrow')).toBe(false);
  expect(tab('comment').getAttribute('title')).toBeNull();
});

test.skipIf(!hasDom)('a row of buttons that needs more than the floor sets the least width', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  // The reply's row runs 46 px out of the card at the floor (its chips): the least width is that much more.
  const body = card().querySelector<HTMLElement>('[data-fcomp-body]')!;
  Object.defineProperty(body, 'scrollWidth', { configurable: true, get: () => (card().style.getPropertyValue('--ib-fcomp-rw') === `${MIN_WIDTH}px` ? 46 : 0) });
  dragBy(cornerAt('se'), -5000, 0);
  expect(sizeNow().w).toBe(MIN_WIDTH + 46);
});

test.skipIf(!hasDom)('a tab whose row needs more than the card’s width widens the card when it is picked', async () => {
  await draw();
  dragBy(tray(), 100, -300);
  await settle();
  dragBy(cornerAt('se'), -5000, 0);
  expect(sizeNow().w).toBe(MIN_WIDTH);
  // The Reply tab's row runs 46 px out of a card this narrow.
  const body = card().querySelector<HTMLElement>('[data-fcomp-body]')!;
  Object.defineProperty(body, 'scrollWidth', { configurable: true, get: () => (card().getAttribute('data-fcomp-mode-on') === 'reply' && card().style.getPropertyValue('--ib-fcomp-rw') === `${MIN_WIDTH}px` ? 46 : 0) });
  act(() => tab('reply').click());
  await settle();
  expect(sizeNow().w).toBe(MIN_WIDTH + 46);
  // Back on Comment, the width the person set is the card's again.
  act(() => tab('comment').click());
  await settle();
  expect(sizeNow().w).toBe(MIN_WIDTH);
});
