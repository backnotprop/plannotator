/**
 * A list row's tooltips mount on first use (RowTip.tsx; .ops/perf/open-thread-xl.md, fix 2): drawing every row's
 * tooltips with the rows was most of the cost of opening a thread from a long list. What is proved: drawing the rows
 * adds no hover listener; the pointer's first entry still opens the tooltip after the delay, from a trigger drawn
 * the same as before; rows drawn again under a pointer at rest (the browser's own mouseenter, no pointer event) open
 * nothing until the pointer moves, then open as before; a Tab from a row onto its hover action keeps focus on the same
 * element (the row armed it) and shows the action's tooltip; a press with no hover before it keeps the element it
 * went down on, over events while it is down included, and its click opens the row; a screen with no hover never
 * draws a trigger again; a pointer gone where the browser sends no mouseleave stops the open at
 * the first real event elsewhere; a touch, its tap's mouse events included, never draws a trigger again (it would be
 * under the finger mid-tap).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { hover, openTooltips, settle, unhover } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LazyRowTips, RowTip } = (hasDom ? await import('./components/RowTip') : {}) as typeof import('./components/RowTip');

function row(id: string, read: boolean): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject of ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: read ? 0 : 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: !read,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    // A read row the list still holds in New: its hover action is Mark unread.
    section: read ? 'new' : 'waiting',
    unread: !read,
    read_at: read ? '2026-10-10T11:00:00.000Z' : null,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const ROWS = Array.from({ length: 12 }, (_, i) => row(`msg_${i}`, i % 2 === 1));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
});

function render(narrow: boolean, onOpen: (id: string) => void = () => {}): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={[
              { id: 'waiting', label: 'Waiting on you', threads: ROWS.filter((r) => r.unread) },
              { id: 'new', label: 'New', threads: ROWS.filter((r) => !r.unread) },
            ]}
            filtered={false}
            narrow={narrow}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={(opened) => onOpen(opened.thread_id)}
            onMarkUnread={() => {}}
            phone={false}
          />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

/** An element's attributes, base-ui's generated `id` left out (no style or test reads it). */
const attributes = (el: Element) =>
  [...el.attributes]
    .filter((a) => a.name !== 'id')
    .map((a) => `${a.name}=${a.value}`)
    .sort();

for (const narrow of [false, true]) {
  test.skipIf(!hasDom)(`drawing ${narrow ? 'three-line' : 'wide'} rows adds no hover listener; the first entry opens the tooltip from a trigger drawn the same`, async () => {
    // Hover listeners added on anything inside a row (the list's header keeps its own tooltips).
    const added: string[] = [];
    // The prototype a DOM element takes addEventListener from (happy-dom's own EventTarget, not the global one).
    let owner: object = document.createElement('span');
    while (!Object.prototype.hasOwnProperty.call(owner, 'addEventListener')) owner = Object.getPrototypeOf(owner);
    const target = owner as { addEventListener: (...args: unknown[]) => void };
    const real = target.addEventListener;
    target.addEventListener = function (this: unknown, ...args: unknown[]) {
      if (this instanceof Element && this.closest('.ib-rw')) added.push(String(args[0]));
      return real.apply(this, args);
    };
    let el: HTMLElement;
    try {
      el = render(narrow);
    } finally {
      target.addEventListener = real;
    }
    // Before: every row's tiles, ticks and counts drew a tooltip with four hover listeners each.
    expect(added.filter((t) => t === 'mouseenter' || t === 'mouseleave')).toEqual([]);
    const tiles = () => el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
    const before = tiles();
    const drawn = { tag: before.tagName, attributes: attributes(before), html: before.innerHTML };
    hover(before);
    await settle();
    expect(openTooltips()).toEqual(['Claude Code']);
    const after = tiles();
    unhover(after);
    await settle();
    expect(openTooltips()).toEqual([]);
    expect({ tag: after.tagName, attributes: attributes(after), html: after.innerHTML }).toEqual(drawn);
  });
}

test.skipIf(!hasDom)('rows drawn again under a pointer at rest: the browser\'s mouseenter alone opens nothing; the next move opens the tooltip', async () => {
  const el = render(false);
  const tiles = () => el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  // What Chrome sends a new element under a pointer that has not moved: the mouse's boundary events, no pointer event.
  act(() => {
    tiles().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    tiles().dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 10 }));
  });
  await settle();
  expect(openTooltips()).toEqual([]);
  act(() => {
    tiles().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 10 }));
  });
  await settle();
  expect(openTooltips()).toEqual(['Claude Code']);
});

test.skipIf(!hasDom)("a Tab from a row onto its hover action keeps focus on the action, the same element, and the action's tooltip shows", async () => {
  const el = render(false);
  const rowButton = el.querySelector<HTMLElement>('[data-row="msg_1"] [data-thread-id]')!;
  act(() => rowButton.focus());
  expect(document.activeElement).toBe(rowButton);
  // The row armed its action when focus came in: the Tab's handler holds the element it moves focus to.
  const before = el.querySelector<HTMLElement>('[data-row="msg_1"] [data-row-mark-unread]')!;
  act(() => {
    rowButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  const action = el.querySelector<HTMLElement>('[data-row="msg_1"] [data-row-mark-unread]')!;
  expect(action).toBe(before);
  expect(document.activeElement).toBe(action);
  expect(el.querySelector('[data-row="msg_1"]')!.hasAttribute('data-action-focus')).toBe(true);
  await settle();
  expect(openTooltips().some((t) => t.startsWith('Mark unread'))).toBe(true);
  expect(document.activeElement).toBe(action);
});

test.skipIf(!hasDom)("a press with no hover before it (a pen's first contact): the trigger stays the element pressed, and the click opens the row", async () => {
  const opened: string[] = [];
  const el = render(false, (id) => opened.push(id));
  const tiles = el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  // What the browser sends the element under a press that came with no move: its over events, then the press.
  act(() => {
    tiles.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  await settle(0);
  expect(tiles.isConnected).toBe(true);
  act(() => {
    tiles.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  expect(opened).toEqual(['msg_0']);
  // As `Tip` let the press cancel its open: nothing opens until the pointer comes back.
  await settle();
  expect(openTooltips()).toEqual([]);
  expect(tiles.isConnected).toBe(true);
});

test.skipIf(!hasDom)('over events while the press is down (onto the next tile; a mouseover sent after the down) draw nothing again, and the click opens the row', async () => {
  const opened: string[] = [];
  const el = render(false, (id) => opened.push(id));
  const pen = (type: string, target: Element, buttons: number) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'pen', buttons, clientX: 10, clientY: 10 }));
  const mouse = (type: string, target: Element, buttons: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, buttons, clientX: 10, clientY: 10 }));
  // A: the press, then the pen slides onto the next tile with the button down.
  const tilesA = el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  const tile = tilesA.querySelector('.ib-atile') ?? tilesA;
  act(() => {
    pen('pointerover', tilesA, 0);
    mouse('mouseover', tilesA, 0);
    pen('pointerdown', tilesA, 1);
    mouse('mousedown', tilesA, 1);
  });
  act(() => {
    pen('pointerover', tile, 1);
    mouse('mouseover', tile, 1);
  });
  await settle(0);
  expect(tilesA.isConnected).toBe(true);
  act(() => {
    pen('pointerup', tilesA, 0);
    mouse('mouseup', tilesA, 0);
    mouse('click', tilesA, 0);
  });
  // B: the compatibility mouseover after the down (the Pointer Events spec allows that order).
  const tilesB = el.querySelector<HTMLElement>(`[data-thread-id="msg_2"] [data-row-agents]`)!;
  act(() => {
    pen('pointerover', tilesB, 0);
    pen('pointerdown', tilesB, 1);
    mouse('mouseover', tilesB, 1);
    mouse('mousedown', tilesB, 1);
  });
  await settle(0);
  expect(tilesB.isConnected).toBe(true);
  act(() => {
    pen('pointerup', tilesB, 0);
    mouse('mouseup', tilesB, 0);
    mouse('click', tilesB, 0);
  });
  expect(opened).toEqual(['msg_0', 'msg_2']);
});

test.skipIf(!hasDom)('a screen with no hover (a tablet and its pen) never draws a trigger again', async () => {
  const el = render(false);
  const tiles = el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => (query === '(hover: none)' ? ({ matches: true, media: query } as MediaQueryList) : real.call(window, query))) as typeof window.matchMedia;
  try {
    act(() => {
      tiles.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    });
    await settle(0);
    expect(tiles.isConnected).toBe(true);
  } finally {
    window.matchMedia = real;
  }
});

test.skipIf(!hasDom)("a press with no hover before it on a trigger that takes focus: the press's focus arms nothing, so its click lands", async () => {
  const clicks: string[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <LazyRowTips.Provider value={true}>
        <RowTip content="Pin">
          <button type="button" data-probe="" onClick={() => clicks.push('pin')}>
            Pin
          </button>
        </RowTip>
      </LazyRowTips.Provider>,
    );
  });
  const button = host.querySelector<HTMLElement>('[data-probe]')!;
  act(() => {
    button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', clientX: 10, clientY: 10 }));
    button.focus();
  });
  expect(button.isConnected).toBe(true);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  expect(clicks).toEqual(['pin']);
});

test.skipIf(!hasDom)("the pointer gone where the browser never says it left: the first real event elsewhere stops the tip's open", async () => {
  const el = render(false);
  const tiles = () => el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  hover(tiles());
  await settle(0);
  // The tip waits out its delay. The pointer is now on something else (a row's hover action that showed over it),
  // and the drawn-again trigger gets no mouseleave: only the browser's over event, on that something else.
  const elsewhere = el.querySelector<HTMLElement>('[data-row="msg_1"]')!;
  const over = new MouseEvent('mouseover', { bubbles: true, clientX: 600, clientY: 10 });
  Object.defineProperty(over, 'isTrusted', { value: true });
  act(() => {
    elsewhere.dispatchEvent(over);
  });
  await settle();
  expect(openTooltips()).toEqual([]);
});

test.skipIf(!hasDom)("a touch never draws a trigger again, its tap's mouse events included, and opens no tooltip", async () => {
  const el = render(false);
  const tiles = el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  // A tap: its pointer event, then the mouse events a browser sends for it (`sourceCapabilities.firesTouchEvents`).
  const tap = new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 });
  Object.defineProperty(tap, 'sourceCapabilities', { value: { firesTouchEvents: true } });
  act(() => {
    tiles.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }));
    tiles.dispatchEvent(tap);
  });
  await settle(0);
  expect(tiles.isConnected).toBe(true);
  await settle();
  expect(openTooltips()).toEqual([]);
});
