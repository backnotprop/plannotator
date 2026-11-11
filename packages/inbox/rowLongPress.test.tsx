/**
 * A finger held on a thread row opens the row's menu (the right-click menu, RowMenu.tsx), through the shared
 * trigger's opt-in `longPress` (useContextMenuTrigger.ts).
 *
 * What this catches: a hold that opens nothing, or opens a menu other than the row's; a tap that waits for the hold or
 * opens nothing; a finger that moves (a scroll, the start of a swipe), a second finger or a cancelled touch that still
 * opens it; the lift after the menu opens that opens the thread or activates the item under it; the row without its
 * muted look while its menu is open, or keeping it after a cancelled hold; a phone's menu that is not the sheet; a
 * phone's own `contextmenu` for the hold that shows the browser's menu; and the Board's card menu (no `longPress`)
 * opening on a hold.
 *
 * The list's menu is drawn over a few plain rows, so no Inbox runs. The real window on a phone and an iPad is proved
 * against the compiled binary by tests/e2e/inbox-row-long-press.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCardWire, InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadRowMenu } = (hasDom ? await import('./components/RowMenu') : {}) as typeof import('./components/RowMenu');
const { CardMenu } = (hasDom ? await import('./board/CardMenu') : {}) as typeof import('./board/CardMenu');
const { LONG_PRESS_MS } = await import('./components/useContextMenuTrigger');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

const rowOf = (id: string) =>
  ({ thread_id: id, subject: `Thread ${id}`, section: 'new', unread: true, unseen: 1, answered_not_sent: false, resolved_at: null, read_at: null, questions: { open: 0, picked: 0, stopped: false, holds_up: [] } }) as unknown as InboxListRow;

interface Calls {
  opened: string[];
  actions: [string, string][];
}

/** The list's menu over rows `a` (a wide row in its wrapper) and `m` (a phone's row), with the row's muted look. */
function draw(options: { phone?: boolean } = {}) {
  const calls: Calls = { opened: [], actions: [] };
  function Harness() {
    const [menuRow, setMenuRow] = useState<string | null>(null);
    return (
      <div className="pn-inbox">
        <ThreadRowMenu className="ib-lbody" rowOf={(id) => (['a', 'm'].includes(id) ? rowOf(id) : null)} canMarkRead={true} held={false} phone={options.phone} onAction={(row, action) => calls.actions.push([row.thread_id, action])} onTarget={setMenuRow}>
          <button type="button" className="ib-band">
            New
          </button>
          <div className="ib-rw" data-row="a" data-menu={menuRow === 'a' ? '' : undefined}>
            <button type="button" className="ib-row" data-thread-id="a" onClick={() => calls.opened.push('a')}>
              <span className="ib-title">Thread a</span>
            </button>
          </div>
          <button type="button" className="ib-mrow" data-thread-id="m" data-menu={menuRow === 'm' ? '' : undefined} onClick={() => calls.opened.push('m')}>
            <span>Thread m</span>
          </button>
        </ThreadRowMenu>
      </div>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness />);
  });
  return calls;
}

/** A touch event as a phone sends it: `fingers` touches down (none on a lift). */
function touch(target: Element, type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x = 40, y = 20, fingers = 1): Event {
  const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  const down = type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: fingers }, (_, i) => ({ ...point, identifier: i + 1 }));
  Object.defineProperty(event, 'touches', { value: down });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  act(() => void target.dispatchEvent(event));
  return event;
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const actions = () => [...(menu()?.querySelectorAll('[data-row-action]') ?? [])].map((el) => el.getAttribute('data-row-action'));
const button = (id: string) => document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const look = (id: string) => (id === 'm' ? button('m') : button(id).closest('[data-row]')!).hasAttribute('data-menu');

/** The click a browser sends after a lift, at the element under the finger. */
function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  act(() => void target.dispatchEvent(event));
  return event;
}

test.skipIf(!hasDom)("a finger held on a row opens the row's own menu with its muted look; the lift opens no thread and picks no item", async () => {
  const calls = draw();
  const row = button('a').querySelector('.ib-title')!;
  touch(row, 'touchstart');
  await wait(LONG_PRESS_MS - 200);
  expect(menu()).toBeNull();
  await wait(260);
  expect(menu()?.getAttribute('data-row-menu')).toBe('a');
  // The right-click's items, as rowMenuActions gives them for this row.
  expect(actions()).toEqual(['copy-thread', 'copy-link', 'copy-id', 'read', 'archive']);
  expect(look('a')).toBe(true);
  // The finger lifts: no click from it, and a click the browser sends anyway (on the row, or on the item now under
  // the finger) does nothing.
  const lift = touch(row, 'touchend');
  expect(lift.defaultPrevented).toBe(true);
  const onRow = click(row);
  const onItem = click(menu()!.querySelector('[data-row-action="archive"]')!);
  expect([onRow.defaultPrevented, onItem.defaultPrevented]).toEqual([true, true]);
  expect(calls.opened).toEqual([]);
  expect(calls.actions).toEqual([]);
  expect(menu()?.getAttribute('data-row-menu')).toBe('a');
  // A tap on an item after that is the item's.
  await wait(450);
  act(() => menu()!.querySelector<HTMLElement>('[data-row-action="read"]')!.click());
  expect(calls.actions).toEqual([['a', 'read']]);
  await wait(50);
  expect(menu()).toBeNull();
  expect(look('a')).toBe(false);
  expect(calls.opened).toEqual([]);
});

test.skipIf(!hasDom)('a tap opens the thread at once, and no menu follows', async () => {
  const calls = draw();
  touch(button('m'), 'touchstart');
  await wait(60);
  const lift = touch(button('m'), 'touchend');
  expect(lift.defaultPrevented).toBe(false);
  const tap = click(button('m'));
  expect(tap.defaultPrevented).toBe(false);
  expect(calls.opened).toEqual(['m']);
  await wait(LONG_PRESS_MS + 100);
  expect(menu()).toBeNull();
  expect(look('m')).toBe(false);
});

test.skipIf(!hasDom)('a finger that moves past the slop (a scroll, a swipe) is no press, and loses the look; a small drift still is one', async () => {
  draw();
  touch(button('m'), 'touchstart', 40, 20);
  await wait(200);
  expect(look('m')).toBe(true);
  touch(button('m'), 'touchmove', 40, 40);
  expect(look('m')).toBe(false);
  await wait(LONG_PRESS_MS);
  expect(menu()).toBeNull();
  touch(button('m'), 'touchend', 40, 40);
  // Sideways too (the start of a swipe).
  touch(button('m'), 'touchstart', 40, 20);
  touch(button('m'), 'touchmove', 60, 20);
  await wait(LONG_PRESS_MS + 60);
  expect(menu()).toBeNull();
  touch(button('m'), 'touchend', 60, 20);
  // A finger that drifts a few pixels while it rests is still a press.
  touch(button('m'), 'touchstart', 40, 20);
  touch(button('m'), 'touchmove', 44, 24);
  await wait(LONG_PRESS_MS + 60);
  expect(menu()?.getAttribute('data-row-menu')).toBe('m');
});

test.skipIf(!hasDom)('a second finger, a cancelled touch or a scroll of the list ends the hold', async () => {
  draw();
  const row = button('a');
  touch(row, 'touchstart');
  touch(row, 'touchmove', 40, 20, 2);
  await wait(LONG_PRESS_MS + 60);
  expect(menu()).toBeNull();
  touch(row, 'touchend');

  touch(row, 'touchstart');
  touch(row, 'touchcancel');
  await wait(LONG_PRESS_MS + 60);
  expect(menu()).toBeNull();

  touch(row, 'touchstart');
  act(() => void document.querySelector('.ib-lbody')!.dispatchEvent(new Event('scroll')));
  await wait(LONG_PRESS_MS + 60);
  expect(menu()).toBeNull();
  expect(look('a')).toBe(false);
});

test.skipIf(!hasDom)("a phone's own contextmenu for the hold shows no browser menu and opens the row's menu now", async () => {
  draw();
  const row = button('a');
  touch(row, 'touchstart');
  act(() => void row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })));
  await wait(100);
  const own = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 });
  act(() => void row.dispatchEvent(own));
  expect(own.defaultPrevented).toBe(true);
  await wait(20);
  expect(menu()?.getAttribute('data-row-menu')).toBe('a');
});

test.skipIf(!hasDom)("on a phone the held row's menu is the bottom sheet, the thread's name over its items", async () => {
  draw({ phone: true });
  touch(button('m'), 'touchstart');
  await wait(LONG_PRESS_MS + 60);
  const popup = menu()!;
  expect(popup.getAttribute('data-row-menu')).toBe('m');
  expect(popup.closest('.ib-pm-pos')!.hasAttribute('data-phone')).toBe(true);
  expect(document.querySelector('.ib-pm-scrim')).not.toBeNull();
  expect(popup.querySelector('.ib-pm-title')!.textContent).toBe('Thread m');
  expect(popup.querySelector('.ib-pm-title')!.getAttribute('aria-hidden')).toBe('true');
});

test.skipIf(!hasDom)("the Board's card menu takes no hold: a touch never opens it, a right-click still does", async () => {
  const card = { id: 'card_1', column: 'todo', title: 'Ship the docs', notes: null, threads: [] } as unknown as InboxCardWire;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <CardMenu className="ib-bmain" cardOf={(id) => (id === card.id ? card : null)} rowOf={() => null} onTarget={() => {}} onColumn={() => {}} onRestore={() => {}} onDrop={() => {}} onOpenThread={() => {}}>
          <div className="ib-bcard" data-card-id={card.id}>
            <button type="button" data-card-open="">
              Ship the docs
            </button>
          </div>
        </CardMenu>
      </div>,
    );
  });
  const open = document.querySelector<HTMLElement>('[data-card-open]')!;
  touch(open, 'touchstart');
  await wait(LONG_PRESS_MS + 150);
  expect(document.querySelector('[data-card-context-menu]')).toBeNull();
  const lift = touch(open, 'touchend');
  expect(lift.defaultPrevented).toBe(false);
  act(() => void open.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })));
  await wait(20);
  expect(document.querySelector('[data-card-context-menu]')?.getAttribute('data-card-context-menu')).toBe(card.id);
});
