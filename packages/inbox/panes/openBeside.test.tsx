/**
 * "Open beside" (panes/beside.ts, useRoutePanes.ts) as the window mounts it: the rows' real menu (RowMenu.tsx) under
 * the panes' context, and an address the test keeps as the window's route.
 *
 * What regresses: the item showing with the switch off, or on the thread already open, or in a window without room for
 * the list and two threads even with the sidebar folded, or missing where there is that room but a docked sidebar
 * takes it (1440 px); choosing it not opening the second pane beside the first, or not putting the person in it, or not
 * folding a docked sidebar that leaves too little room (panes/sidebarHold.ts); closing the second pane not bringing
 * that sidebar back, or opening a sidebar the person folded; closing either pane not coming back to today's one pane;
 * Escape (the address closed) closing both panes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH } from '../stack';
import { BesideContext, besideOf } from './beside';
import type { PaneSet } from './model';
import { useSidebarHold } from './sidebarHold';
import { useRoutePanes, type WindowPanes } from './useRoutePanes';

const hasDom = typeof document !== 'undefined';
const { ThreadRowMenu } = (hasDom ? await import('../components/RowMenu') : {}) as typeof import('../components/RowMenu');

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedWidth = hasDom ? window.innerWidth : 0;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setWidth(savedWidth);
  // The kept layout (savedLayout.ts) is the window's: each test opens a new one.
  sessionStorage.clear();
});

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => void window.dispatchEvent(new Event('resize')));
}

const rowOf = (id: string) =>
  ({ thread_id: id, subject: `Thread ${id}`, section: 'new', unread: true, unseen: 1, answered_not_sent: false, resolved_at: null, read_at: null, questions: { open: 0, picked: 0, stopped: false, holds_up: [] } }) as unknown as InboxListRow;

/** The docked sidebar's width (shell/sidebar.tsx's default). */
const SIDEBAR = 232;

/**
 * The window: the address (`thread`), its panes, the list's menu over rows a and b, and a docked sidebar `SIDEBAR` px
 * wide that the person keeps open (`sidebarOpen`) or folded. The window is as wide as `window.innerWidth`.
 */
function draw(switchOn: boolean, start: string | null = 'thr_a', sidebarOpen = true) {
  const out = { panes: null as WindowPanes | null, thread: start, go: (_thread: string | null) => {}, sidebarHeld: false, sidebarOpen, toggleSidebar: (_open: boolean) => {} };
  function Window() {
    const [thread, setThread] = useState<string | null>(start);
    out.thread = thread;
    out.go = setThread;
    const panes = useRoutePanes(thread, true, switchOn, (next) => setThread(next));
    out.panes = panes;
    const route = { page: 'inbox', thread } as Route;
    const routeRef = useRef(route);
    routeRef.current = route;
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(sidebarOpen);
    const hold = useSidebarHold(rootRef, routeRef, route, panes.columns, open);
    out.sidebarHeld = hold.held;
    out.sidebarOpen = open;
    // The sidebar's own toggle, as App.tsx wires it: the person's choice, which ends a fold for room.
    out.toggleSidebar = (next) => {
      hold.setHeld(false);
      setOpen(next);
    };
    const measured = (el: HTMLDivElement | null, width: () => number) => {
      if (el) el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: width(), height: 900 });
    };
    return (
      <div className="pn-inbox" ref={(el) => {
        rootRef.current = el;
        measured(el, () => window.innerWidth);
      }}>
        <div className="ib-sb-inner" ref={(el) => measured(el, () => SIDEBAR)} />
        <div className="ib-main" ref={(el) => measured(el, () => window.innerWidth)}>
          <div className="ib-listcol" ref={(el) => measured(el, () => LIST_MIN_WIDTH)} />
        </div>
        <BesideContext.Provider value={besideOf(panes, thread, hold.holdIfTight)}>
          <ThreadRowMenu className="ib-lbody" rowOf={(id) => (['thr_a', 'thr_b'].includes(id) ? rowOf(id) : null)} canMarkRead={true} held={thread !== null} onAction={() => {}} onTarget={() => {}}>
            {['thr_a', 'thr_b'].map((id) => (
              <div key={id} className="ib-rw" data-row={id}>
                <button type="button" className="ib-row" data-thread-id={id}>
                  Thread {id}
                </button>
              </div>
            ))}
          </ThreadRowMenu>
        </BesideContext.Provider>
      </div>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Window />);
  });
  return out;
}

async function openMenu(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
}
const besideItem = () => document.querySelector<HTMLElement>('[data-row-menu] [data-row-action="open-beside"]');
const shape = (set: PaneSet) => ({ threads: set.panes.map((pane) => pane.thread), active: set.panes.findIndex((pane) => pane.id === set.active) });

describe.skipIf(!hasDom)('Open beside', () => {
  test('with the switch off the menu has no Open beside, and one pane stays', async () => {
    const w = draw(false);
    await openMenu('thr_b');
    expect(document.querySelector('[data-row-menu]')).not.toBeNull();
    expect(besideItem()).toBeNull();
    expect(w.panes!.panes.panes).toHaveLength(1);
    // Main's one pane: the same set through a redraw on the same thread (what reads it draws nothing new), a new one
    // for another thread.
    const before = w.panes!.panes;
    act(() => w.toggleSidebar(false));
    expect(w.sidebarOpen).toBe(false);
    expect(w.panes!.panes).toBe(before);
    act(() => w.go('thr_b'));
    expect(w.panes!.panes).not.toBe(before);
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_b'], active: 0 });
  });

  test('the open thread\'s own row offers none', async () => {
    draw(true);
    await openMenu('thr_a');
    expect(document.querySelector('[data-row-menu]')).not.toBeNull();
    expect(besideItem()).toBeNull();
  });

  test('on, it opens the row beside the open thread, the person in the new pane', async () => {
    setWidth(1440);
    const w = draw(true);
    await openMenu('thr_b');
    expect(besideItem()?.textContent).toBe('Open beside');
    await act(async () => besideItem()!.click());
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.thread).toBe('thr_b');
  });

  test("closing either pane is today's one pane again, with the other's thread", async () => {
    const w = draw(true);
    act(() => w.panes!.openBeside('thr_b'));
    act(() => w.panes!.closePane(w.panes!.panes.panes[1]!.id));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a'], active: 0 });
    expect(w.thread).toBe('thr_a');
    act(() => w.panes!.openBeside('thr_b'));
    act(() => w.panes!.closePane('main'));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_b'], active: 0 });
    expect(w.thread).toBe('thr_b');
  });

  test('the address closing (Escape, ‹ Inbox) closes the active pane only; a click in the other makes it active', async () => {
    const w = draw(true);
    act(() => w.panes!.openBeside('thr_b'));
    act(() => w.panes!.focus('main'));
    expect(w.thread).toBe('thr_a');
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 0 });
    act(() => w.go(null));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_b'], active: 0 });
    expect(w.thread).toBe('thr_b');
  });

  test('offered while the list and two 440 px threads fit with the sidebar folded; narrower, none', async () => {
    const room = LIST_MIN_WIDTH + 2 * THREAD_BESIDE_FILE_WIDTH;
    setWidth(room - 1);
    draw(true);
    await openMenu('thr_b');
    expect(besideItem()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    // 1440 px with the sidebar docked: the two fit once it folds, so the item is there.
    setWidth(1440);
    expect(1440 - SIDEBAR).toBeLessThan(room);
    draw(true);
    await openMenu('thr_b');
    expect(besideItem()?.textContent).toBe('Open beside');
  });

  test('at 1440 with the sidebar docked, choosing it folds the sidebar on screen; closing the second pane brings it back', async () => {
    setWidth(1440);
    const w = draw(true);
    expect(w.sidebarHeld).toBe(false);
    await openMenu('thr_b');
    await act(async () => besideItem()!.click());
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.sidebarHeld).toBe(true);
    act(() => w.panes!.closePane(w.panes!.panes.panes[1]!.id));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a'], active: 0 });
    expect(w.sidebarHeld).toBe(false);
  });

  test('with room for the sidebar too, nothing folds', async () => {
    setWidth(LIST_MIN_WIDTH + 2 * THREAD_BESIDE_FILE_WIDTH + SIDEBAR);
    const w = draw(true);
    await openMenu('thr_b');
    await act(async () => besideItem()!.click());
    expect(w.panes!.panes.panes).toHaveLength(2);
    expect(w.sidebarHeld).toBe(false);
  });

  test('a sidebar the person folded stays theirs: Open beside folds nothing, and closing the second pane opens nothing', async () => {
    setWidth(1440);
    const w = draw(true, 'thr_a', false);
    await openMenu('thr_b');
    await act(async () => besideItem()!.click());
    expect(w.panes!.panes.panes).toHaveLength(2);
    expect(w.sidebarHeld).toBe(false);
    act(() => w.panes!.closePane(w.panes!.panes.panes[1]!.id));
    expect(w.panes!.panes.panes).toHaveLength(1);
    expect(w.sidebarHeld).toBe(false);
  });

  test('folded for room, then opened and folded again by the person: closing the second pane keeps it folded', async () => {
    setWidth(1440);
    const w = draw(true);
    await openMenu('thr_b');
    await act(async () => besideItem()!.click());
    expect(w.sidebarHeld).toBe(true);
    act(() => w.toggleSidebar(true));
    act(() => w.toggleSidebar(false));
    expect(w.sidebarHeld).toBe(false);
    act(() => w.panes!.closePane(w.panes!.panes.panes[1]!.id));
    expect(w.sidebarOpen).toBe(false);
    expect(w.sidebarHeld).toBe(false);
  });

  test('the layout comes back after a reload: the same panes, the person in the same one, the address naming it', async () => {
    setWidth(1440);
    const w = draw(true);
    act(() => w.panes!.openBeside('thr_b'));
    act(() => root!.unmount());
    host!.remove();
    // A reload with no thread in the address: the kept layout, and the address names its active pane's thread.
    const again = draw(true, null);
    expect(shape(again.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(again.thread).toBe('thr_b');
    act(() => root!.unmount());
    host!.remove();
    // A reload whose address names the other thread: the same panes, the person in that one.
    const named = draw(true, 'thr_a');
    expect(shape(named.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 0 });
    // Closing down to one pane keeps nothing: the next reload is today's window.
    act(() => named.panes!.closePane(named.panes!.panes.panes[1]!.id));
    act(() => root!.unmount());
    host!.remove();
    const plain = draw(true, null);
    expect(plain.panes!.layout.root).toBeNull();
    expect(plain.thread).toBeNull();
  });

  test('a window too narrow for two panes offers none; narrowing keeps both panes in the layout and the active one in the address', async () => {
    // The list's narrowest column and two 440 px panes with the 1 px gap between them (layoutRoom.ts).
    const two = LIST_MIN_WIDTH + 2 * THREAD_BESIDE_FILE_WIDTH + 1;
    const w = draw(true);
    setWidth(two - 1);
    await openMenu('thr_b');
    expect(besideItem()).toBeNull();
    setWidth(two);
    act(() => w.panes!.openBeside('thr_b'));
    expect(w.panes!.panes.panes).toHaveLength(2);
    setWidth(two - 1);
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.thread).toBe('thr_b');
  });
});
