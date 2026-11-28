/**
 * "Open to the side" (panes/beside.ts, useRoutePanes.ts) as the window mounts it: the rows' real menu (RowMenu.tsx)
 * under the panes' context, and an address the test keeps as the window's route.
 *
 * What regresses: the item showing with the switch off or on the thread already open, or missing with any number of
 * panes open (the owner: two felt like a cap); choosing it not opening the second pane beside the first, or not putting
 * the person in it, or not folding a docked sidebar that leaves too little room (panes/sidebarHold.ts); a third thread
 * where no third column fits not going below the active pane; a window with no room for another pane opening it
 * without saying which pane stepped aside, or its Undo not bringing that pane back; closing the second pane not
 * bringing that sidebar back, or opening a sidebar the person folded; closing either pane not coming back to today's
 * one pane; Escape (the address closed) closing both panes, or, drawn again before the next pane's thread reached the
 * address, every pane (the hands-on pass, 2026-11-19: one Escape closed a layout of five).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, StrictMode, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import type { Route } from '../app/route';
import { LIST_MIN_WIDTH } from '../stack';
import { BesideContext, besideOf } from './beside';
import * as L from './layoutModel';
import { stackedRows } from './layoutRoom';
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

/** The list's rows. */
const ROWS = ['thr_a', 'thr_b', 'thr_c', 'thr_d'];

/** The docked sidebar's width (shell/sidebar.tsx's default). */
const SIDEBAR = 232;

/** A window where the list and two panes fit only with the docked sidebar folded (1440 in the real window; this one has no gutters). */
const TIGHT = LIST_MIN_WIDTH + 2 * L.PANE_MIN_WIDTH + SIDEBAR - 40;

/**
 * The window: the address (`thread`), its panes, the list's menu over rows a to d, and a docked sidebar `SIDEBAR` px
 * wide that the person keeps open (`sidebarOpen`) or folded. The window is as wide as `window.innerWidth`.
 */
function draw(switchOn: boolean, start: string | null = 'thr_a', sidebarOpen = true, strict = false) {
  const out = { panes: null as WindowPanes | null, thread: start, go: (_thread: string | null) => {}, setSwitch: (_on: boolean) => {}, sidebarHeld: false, sidebarOpen, toggleSidebar: (_open: boolean) => {}, toasts: [] as Omit<InboxToastModel, 'id'>[], dismissed: 0 };
  function Window() {
    const [thread, setThread] = useState<string | null>(start);
    out.thread = thread;
    out.go = setThread;
    // The switch as Settings or another window's change sets it, without a reload.
    const [on, setOn] = useState(switchOn);
    out.setSwitch = setOn;
    const panes = useRoutePanes(thread, true, on, (next) => setThread(next));
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
        <BesideContext.Provider value={besideOf(panes, thread, hold.holdIfTight, { toast: (toast) => void out.toasts.push(toast), dismiss: (undo) => void (out.toasts.at(-1)?.onUndo === undo && (out.dismissed += 1)), rowOf: (id) => (ROWS.includes(id) ? rowOf(id) : null) })}>
          <ThreadRowMenu className="ib-lbody" rowOf={(id) => (ROWS.includes(id) ? rowOf(id) : null)} canMarkRead={true} held={thread !== null} onAction={() => {}} onTarget={() => {}}>
            {ROWS.map((id) => (
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
    // StrictMode draws each render twice, as a window drawn again before an effect lands does.
    root.render(strict ? <StrictMode><Window /></StrictMode> : <Window />);
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

describe.skipIf(!hasDom)('Open to the side', () => {
  test('with the switch off the menu has no Open to the side, and one pane stays', async () => {
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
    expect(besideItem()?.textContent).toBe('Open to the side');
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

  test('drawn again before the next pane\'s thread reaches the address, Escape still closes the active pane only', async () => {
    setWidth(1920);
    const w = draw(true, 'thr_a', true, true);
    act(() => w.panes!.openBeside('thr_b'));
    act(() => w.panes!.openBeside('thr_c'));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b', 'thr_c'], active: 2 });
    act(() => w.go(null));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.thread).toBe('thr_b');
    act(() => w.go(null));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a'], active: 0 });
    expect(w.thread).toBe('thr_a');
    act(() => w.go(null));
    expect(w.panes!.panes.panes.every((pane) => pane.thread === null)).toBe(true);
    expect(w.thread).toBe(null);
  });

  test('the switch off and on again without a reload, an Escape in between: the kept panes come back as after a reload, none closed', async () => {
    setWidth(1440);
    const w = draw(true);
    act(() => w.panes!.openBeside('thr_b'));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    // Another window turns it off; here the person closes the thread (Escape) and the list is all there is.
    act(() => w.setSwitch(false));
    act(() => w.go(null));
    expect(w.panes!.allowed).toBe(false);
    act(() => w.setSwitch(true));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.thread).toBe('thr_b');
  });

  test('with two panes open it is still offered: where no third column fits, the third opens below the active pane; a fourth never stacks a third, and with no pane to halve the least recent steps aside, said with Undo', async () => {
    // 1440 px: the list and two 400 px columns fit (the sidebar folds), three do not; the window is 900 px tall, room
    // for three rows of 260 px, but no column stacks more than two (layoutRoom.ts MAX_STACKED). This window draws no
    // panes to halve (no rects), so the fourth goes right of the active pane and the least recent steps aside.
    setWidth(1440);
    expect(1440 - LIST_MIN_WIDTH).toBeLessThan(3 * L.PANE_MIN_WIDTH);
    const w = draw(true);
    for (const id of ['thr_b', 'thr_c', 'thr_d']) {
      await openMenu(id);
      expect(besideItem()?.textContent).toBe('Open to the side');
      await act(async () => besideItem()!.click());
      expect(w.thread).toBe(id);
      if (id === 'thr_c') {
        // a | (b / c): two columns, the right one two rows, the person in c; nothing stepped aside, nothing said.
        expect(w.toasts).toEqual([]);
        const tree = w.panes!.layout.root;
        const right = tree?.type === 'split' ? tree.children[1] : null;
        expect(right?.type === 'split' && [right.direction, right.children.length]).toEqual(['vertical', 2]);
      }
    }
    const { root: tree, threads } = w.panes!.layout;
    expect(L.panesOf(tree).map((pane) => threads[pane.id])).toEqual(['thr_a', 'thr_b', 'thr_c', 'thr_d']);
    expect(stackedRows(tree, 1)).toBe(2);
    expect(w.toasts.map((toast) => [toast.lead, toast.detail])).toEqual([['No room for another pane', '“Thread thr_a” stepped aside']]);
    expect(typeof w.toasts[0]!.onUndo).toBe('function');
  });

  test('in a window with room for two panes only without the docked sidebar, choosing it folds the sidebar on screen; closing the second pane brings it back', async () => {
    setWidth(TIGHT);
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
    setWidth(LIST_MIN_WIDTH + 2 * L.PANE_MIN_WIDTH + SIDEBAR);
    const w = draw(true);
    await openMenu('thr_b');
    await act(async () => besideItem()!.click());
    expect(w.panes!.panes.panes).toHaveLength(2);
    expect(w.sidebarHeld).toBe(false);
  });

  test('a sidebar the person folded stays theirs: Open to the side folds nothing, and closing the second pane opens nothing', async () => {
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
    setWidth(TIGHT);
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

  test('a window too narrow for two panes still offers it: the new pane shows, a toast names the pane that stepped aside, and Undo brings it back; narrowing keeps both panes in the layout', async () => {
    // The list's narrowest column and two 400 px panes with the 1 px gap between them (layoutRoom.ts).
    const two = LIST_MIN_WIDTH + 2 * L.PANE_MIN_WIDTH + 1;
    const w = draw(true);
    setWidth(two - 1);
    await openMenu('thr_b');
    expect(besideItem()?.textContent).toBe('Open to the side');
    await act(async () => besideItem()!.click());
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.toasts.map((toast) => [toast.lead, toast.detail])).toEqual([['No room for another pane', '“Thread thr_a” stepped aside']]);
    act(() => w.toasts[0]!.onUndo!());
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a'], active: 0 });
    // Undo takes its toast away, as every Undo does: no second Undo is left on screen.
    expect(w.dismissed).toBe(1);
    expect(w.thread).toBe('thr_a');
    setWidth(two);
    act(() => w.panes!.openBeside('thr_b'));
    expect(w.panes!.panes.panes).toHaveLength(2);
    setWidth(two - 1);
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b'], active: 1 });
    expect(w.thread).toBe('thr_b');
  });

  test('Undo only takes back the placement its toast named: once the layout is another, the toast leaves and its Undo does nothing', async () => {
    const two = LIST_MIN_WIDTH + 2 * L.PANE_MIN_WIDTH + 1;
    const toSide = async (w: ReturnType<typeof draw>, id: string) => {
      await openMenu(id);
      await act(async () => besideItem()!.click());
      expect(w.toasts.at(-1)?.lead).toBe('No room for another pane');
    };
    // Another thread opened in the new pane (a row clicked within the toast's time).
    const w = draw(true);
    setWidth(two - 1);
    await toSide(w, 'thr_b');
    // The open itself is the placement announced: the toast stays.
    expect(w.dismissed).toBe(0);
    act(() => w.go('thr_c'));
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_c'], active: 1 });
    expect(w.dismissed).toBe(1);
    act(() => w.toasts.at(-1)!.onUndo!());
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_c'], active: 1 });
    expect(w.thread).toBe('thr_c');
    act(() => root!.unmount());
    host!.remove();
    sessionStorage.clear();
    // The new pane closed (its ✕), then Undo: nothing more closes.
    const x = draw(true);
    setWidth(two - 1);
    await toSide(x, 'thr_b');
    const added = x.panes!.layout.active!;
    act(() => x.panes!.closePane(added));
    expect(x.dismissed).toBe(1);
    act(() => x.toasts.at(-1)!.onUndo!());
    expect(shape(x.panes!.panes)).toEqual({ threads: ['thr_a'], active: 0 });
    act(() => root!.unmount());
    host!.remove();
    sessionStorage.clear();
    // Another pane opened beside the new one: Undo would no longer give back the layout it named.
    const y = draw(true);
    setWidth(two - 1);
    await toSide(y, 'thr_b');
    act(() => y.panes!.openBeside('thr_d'));
    expect(y.dismissed).toBe(1);
    act(() => y.toasts[0]!.onUndo!());
    expect(shape(y.panes!.panes)).toEqual({ threads: ['thr_a', 'thr_b', 'thr_d'], active: 2 });
  });
});
