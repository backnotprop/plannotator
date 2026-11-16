/**
 * "Open beside" (panes/beside.ts, useRoutePanes.ts) as the window mounts it: the rows' real menu (RowMenu.tsx) under
 * the panes' context, and an address the test keeps as the window's route.
 *
 * What regresses: the item showing with the switch off, or on the thread already open, or in a window too narrow for
 * two panes; choosing it not opening the second pane beside the first, or not putting the person in it; closing
 * either pane not coming back to today's one pane; Escape (the address closed) closing both panes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { BesideContext, besideOf, besideRoom } from './beside';
import type { PaneSet } from './model';
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
});

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => void window.dispatchEvent(new Event('resize')));
}

const rowOf = (id: string) =>
  ({ thread_id: id, subject: `Thread ${id}`, section: 'new', unread: true, unseen: 1, answered_not_sent: false, resolved_at: null, read_at: null, questions: { open: 0, picked: 0, stopped: false, holds_up: [] } }) as unknown as InboxListRow;

/** The window: the address (`thread`), its panes, and the list's menu over rows a and b. */
function draw(switchOn: boolean, start: string | null = 'thr_a') {
  const out: { panes: WindowPanes | null; thread: string | null; go: (thread: string | null) => void } = { panes: null, thread: start, go: () => {} };
  function Window() {
    const [thread, setThread] = useState<string | null>(start);
    out.thread = thread;
    out.go = setThread;
    const panes = useRoutePanes(thread, true, switchOn, (next) => setThread(next));
    out.panes = panes;
    return (
      <div className="pn-inbox">
        <BesideContext.Provider value={besideOf(panes, thread)}>
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
  });

  test('the open thread\'s own row offers none', async () => {
    draw(true);
    await openMenu('thr_a');
    expect(document.querySelector('[data-row-menu]')).not.toBeNull();
    expect(besideItem()).toBeNull();
  });

  test('on, it opens the row beside the open thread, the person in the new pane', async () => {
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

  test('a window too narrow for two panes offers none, and narrowing to it leaves the active pane alone', async () => {
    const w = draw(true);
    setWidth(besideRoom(0) - 1);
    await openMenu('thr_b');
    expect(besideItem()).toBeNull();
    setWidth(besideRoom(0));
    act(() => w.panes!.openBeside('thr_b'));
    expect(w.panes!.panes.panes).toHaveLength(2);
    setWidth(besideRoom(0) - 1);
    expect(shape(w.panes!.panes)).toEqual({ threads: ['thr_b'], active: 0 });
    expect(w.thread).toBe('thr_b');
  });
});
