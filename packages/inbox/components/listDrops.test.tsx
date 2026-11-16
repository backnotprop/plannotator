/**
 * The list's places for a dragged thread (approval "inbox-drag-threads", drag-system.html; listDrops.tsx) and the
 * empty thread panel as a place (EmptyThreadPanel.tsx), as the person does it: a row pressed and carried by the
 * window's one thread drag (../threadDrag.ts) onto Priority at the list's top, Archive or Quiet at its bottom, held on
 * another row, or onto the empty panel.
 *
 * What regresses: a place showing when nothing is carried, or staying after; a drop that two places take, or that
 * runs its action twice or not as its menu item does; several picked rows not moving together (one toast, one Undo
 * that takes them all back); a place that cannot take the threads taking them silently or doing nothing silently,
 * instead of saying why while it is under the pointer; Quiet not saying it would set a question aside; a row passed
 * over on the way to an edge opening Combine, or a held row combining by itself instead of opening the dialog with
 * exactly those threads picked (its Cancel leaving nothing picked); the list's scroll band sitting under a docked edge
 * where no pointer can reach it; the empty panel not opening the dropped thread, or opening one of several.
 *
 * happy-dom lays nothing out: the pointer's hit test and the rows' boxes are stood in for; the engine, the places, the
 * picks, the Combine dialog and the bulk writes (with their toast and Undo) are the product's. One row's drop hands
 * the row menu's own action to App (App.tsx `rowAction`, whose toast and Undo tests/e2e/inbox-thread-drags.spec.ts
 * checks in a browser).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import type { RowMenuAction } from '../rowMenu';
import type { BulkWrites } from '../bulkWrites';
import type { InboxToastModel } from './Toast';

const hasDom = typeof document !== 'undefined';
const { ThreadRowMenu } = (hasDom ? await import('./RowMenu') : {}) as typeof import('./RowMenu');
const { EmptyThreadPanel } = (hasDom ? await import('./EmptyThreadPanel') : {}) as typeof import('./EmptyThreadPanel');
const { useListPicks } = (hasDom ? await import('./useListPicks') : {}) as typeof import('./useListPicks');
const { bulkWrites } = (hasDom ? await import('../bulkWrites') : {}) as typeof import('../bulkWrites');
const { registerThreadDropTarget, scrollStep, setThreadDragHitTestForTests, threadDragging } = (hasDom ? await import('../threadDrag') : {}) as typeof import('../threadDrag');
const { COMBINE_DWELL_MS } = (hasDom ? await import('./listDrops') : {}) as typeof import('./listDrops');

const NOW = '2026-11-16T09:00:00.000Z';
const PROJECT = { id: 'prj_1', key: 'harbor-abcdef', name: 'harbor', root: '/work/harbor', created_at: NOW };

function rowOf(id: string, subject: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    subject,
    thread_name: null,
    project: PROJECT,
    section: 'new',
    unread: true,
    unseen: 1,
    answered_not_sent: false,
    resolved_at: null,
    read_at: null,
    priority: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    ...extra,
  } as unknown as InboxListRow;
}

const FLAKY = rowOf('msg_FLAKY', 'Flaky login test on CI', { section: 'waiting', questions: { open: 1, picked: 0, stopped: false, holds_up: [] } as unknown as InboxListRow['questions'] });
const RATE = rowOf('msg_RATE', 'Rate limit for the public API');
const SEARCH = rowOf('msg_SEARCH', 'Search index rebuild');
const BILLING = rowOf('msg_BILLING', 'Billing migration cutover', { priority: { at: NOW } as unknown as InboxListRow['priority'] });
const OLD = rowOf('msg_OLD', 'Cookie domains in staging', { section: 'quiet', unread: false, unseen: 0, resolved_at: NOW, read_at: NOW });
/** Live rows, in the list's order (one per 100 px down the list); OLD is the Archived group's, under them. */
const LIVE = [FLAKY, RATE, SEARCH, BILLING];
const ALL = [...LIVE, OLD];

let root: Root | null = null;
let host: HTMLElement | null = null;
let realFetch: typeof fetch;
let actions: [string, RowMenuAction][] = [];
let opened: string[] = [];
let writes: string[] = [];
let toasts: Omit<InboxToastModel, 'id'>[] = [];
let combineStarts = 0;

beforeEach(() => {
  realFetch = globalThis.fetch;
  writes = [];
  // Every write answers as the server does when it goes; the Combine dialog's plan has one agent.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/combine')) return Response.json({ agents: [{ session: 'ses_a', name: 'Claude Code', host: 'claude-code', threads: 2 }] });
    writes.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')} ${init?.body ?? ''}`);
    return Response.json({ before: { priority: null } });
  }) as unknown as typeof fetch;
  actions = [];
  opened = [];
  toasts = [];
  combineStarts = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  setThreadDragHitTestForTests(null);
});

/** The bulk writes the picks' bar runs, with a host that keeps their toasts (the real toast model, Undo included). */
function bulk(): BulkWrites {
  const writes = bulkWrites({
    rowOf: (id) => ALL.find((row) => row.thread_id === id),
    rowWrites: { draw: () => ({ failed: () => {}, done: () => {} }) } as unknown as Parameters<typeof bulkWrites>[0]['rowWrites'],
    setShown: () => {},
    shownRef: { current: null },
    latestRef: { current: null },
    routeRef: { current: {} },
    listCovered: () => false,
    armSlide: () => {},
    afterWrite: async () => {},
    showToast: (toast) => void toasts.push(toast),
    dismissToast: () => {},
    say: () => {},
    warnSetAside: async () => true,
    restoreSnooze: async () => {},
    restorePriority: async () => {},
    closeThread: () => {},
    openThread: () => {},
  });
  return { ...writes, combines: { begin: () => void combineStarts++, waiting: new Map(), stop: async () => {} } } as unknown as BulkWrites;
}

/** The list as InboxList draws it (its picks, its row menu over the rows), and the empty thread panel beside it. */
function Window({ writes }: { writes: BulkWrites }) {
  const body = useRef<HTMLDivElement>(null);
  const drawn = (id: string): InboxListGroupId | null => (id === OLD.thread_id ? 'archived' : (ALL.find((row) => row.thread_id === id)?.section ?? null));
  const pick = useListPicks({ sections: [{ id: 'new', label: 'New since you looked', threads: LIVE } as never], isOpen: () => true, body, bulk: writes, phone: false, scope: null, snoozes: false, sectionOf: drawn });
  return (
    <div className="pn-inbox">
      <main className="ib-main">
        <section className="ib-listcol" onClickCapture={pick.onClickCapture}>
          {pick.bar}
          <ThreadRowMenu
            ref={body}
            className="ib-lbody"
            rowOf={(id) => ALL.find((row) => row.thread_id === id) ?? null}
            sectionOf={drawn}
            canMarkRead={true}
            held={false}
            onAction={(row, action) => void actions.push([row.thread_id, action])}
            onTarget={() => {}}
            picks={pick.menu}
          >
            {ALL.map((row) => (
              // A row and its hover action's wrapper, as InboxList.tsx `RowWithAction` draws it.
              <div key={row.thread_id} className="ib-rw" data-row="">
                <button type="button" className="ib-nrow" data-thread-id={row.thread_id} data-section={row.section}>
                  <div className="ib-l2">
                    <span className="ib-title">{row.subject}</span>
                  </div>
                  <div className="ib-l3">
                    <span className="ib-pv">The latest words.</span>
                  </div>
                </button>
              </div>
            ))}
          </ThreadRowMenu>
        </section>
        <div className="ib-pane ib-pempty">
          <EmptyThreadPanel onOpen={(id) => void opened.push(id)} />
        </div>
      </main>
    </div>
  );
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
const slot = (place: string) => document.querySelector<HTMLElement>(`[data-thread-place="${place}"]`);
/** The carried thread's ghost (a cancelled one may still be flying back: the newest is the one in hand). */
const ghost = () => [...document.querySelectorAll<HTMLElement>('[data-thread-ghost]')].at(-1) ?? null;
const ghostWord = () => ghost()?.querySelector('.ib-tdrag-w')?.textContent ?? null;
const live = () => document.querySelector('[data-thread-drag-live]')?.textContent ?? '';
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * Where the pointer is: the list's rows are 100 px tall from y 0 (in ALL's order); above the list (y < 0) is the
 * Priority place, below it (y > 2000) Archive (x < 200) or Quiet; right of it (x > 1000) the empty panel.
 */
function standIn() {
  ALL.forEach((row, i) => {
    rowEl(row.thread_id).getBoundingClientRect = () => ({ left: 0, right: 600, top: i * 100, bottom: i * 100 + 100, width: 600, height: 100, x: 0, y: i * 100, toJSON: () => null }) as DOMRect;
  });
  setThreadDragHitTestForTests((x, y) => {
    if (x > 1000) return document.querySelector('.ib-pempty');
    if (y < 0) return slot('priority');
    if (y > 2000) return x < 200 ? slot('archive') : slot('quiet');
    const row = ALL[Math.floor(y / 100)];
    return row ? rowEl(row.thread_id).querySelector('.ib-title') : null;
  });
}

function draw() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Window writes={bulk()} />));
  standIn();
}

const at = (x: number, y: number, buttons = 1) => ({ clientX: x, clientY: y, button: 0, buttons, pointerType: 'mouse', pointerId: 1, bubbles: true });
/** A mouse press on a row's middle, then a move past the threshold: the row is carried. */
function pickUp(id: string) {
  const y = ALL.findIndex((row) => row.thread_id === id) * 100 + 50;
  act(() => void rowEl(id).dispatchEvent(new PointerEvent('pointerdown', at(50, y))));
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(60, y + 8))));
}
const move = (x: number, y: number) => act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(x, y))));
/** The release, and the click a browser fires after it (on what the press and the release share): the drag's own. */
const release = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', at(x, y, 0)));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
/** ⌘-click: picks the row (useListPicks.ts), as the person does before carrying several. */
const cmdClick = (id: string) => act(() => void rowEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));

describe.skipIf(!hasDom)('the list edges take a carried thread', () => {
  test('the places show only while a thread is carried, and leave with the drop', async () => {
    draw();
    expect(document.querySelector('.ib-tedge')).toBeNull();
    pickUp(RATE.thread_id);
    expect(threadDragging()).toBe(true);
    expect(slot('priority')?.textContent).toBe('PriorityPut it first in your list');
    expect(slot('archive')?.textContent).toBe('ArchiveOut of the list');
    expect(slot('quiet')?.textContent).toBe('QuietMark read');
    // The top place is docked above the bottom one's pair: Archive left of Quiet, as the phone's swipe pairs them.
    expect([...document.querySelectorAll('.ib-tedge-bottom [data-thread-place]')].map((el) => el.getAttribute('data-thread-place'))).toEqual(['archive', 'quiet']);
    release(500, 1500);
    expect(document.querySelector('.ib-tedge')).toBeNull();
  });

  test('Priority: one drop runs Add to Priority once, exactly as the row menu item does, and nothing else takes it', async () => {
    draw();
    pickUp(RATE.thread_id);
    move(300, -10);
    expect(slot('priority')!.hasAttribute('data-hot')).toBe(true);
    expect(ghostWord()).toBe('Priority');
    release(300, -10);
    expect(actions).toEqual([[RATE.thread_id, 'priority-add']]);
    expect(opened).toEqual([]);
    // The menu's twin: the same call.
    await act(async () => void rowEl(RATE.thread_id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 150 })));
    for (let i = 0; i < 40 && !document.querySelector('[data-row-menu]'); i++) await wait(25);
    const item = document.querySelector<HTMLElement>('[data-row-menu] [data-row-action="priority-add"]')!;
    act(() => item.click());
    expect(actions).toEqual([[RATE.thread_id, 'priority-add'], [RATE.thread_id, 'priority-add']]);
  });

  test('Archive and Quiet: each drop runs its menu action once; Archive is red only under the pointer', async () => {
    draw();
    pickUp(SEARCH.thread_id);
    move(100, 2100);
    expect(slot('archive')!.hasAttribute('data-hot')).toBe(true);
    expect(slot('quiet')!.hasAttribute('data-hot')).toBe(false);
    move(400, 2100);
    expect(slot('archive')!.hasAttribute('data-hot')).toBe(false);
    expect(slot('quiet')!.hasAttribute('data-hot')).toBe(true);
    expect(ghostWord()).toBe('Quiet');
    release(400, 2100);
    pickUp(RATE.thread_id);
    move(100, 2100);
    expect(ghostWord()).toBe('Archive');
    release(100, 2100);
    expect(actions).toEqual([
      [SEARCH.thread_id, 'read'],
      [RATE.thread_id, 'archive'],
    ]);
  });

  test('Quiet says it is Mark read, and that it would set a question aside', async () => {
    draw();
    pickUp(FLAKY.thread_id);
    expect(slot('quiet')!.textContent).toBe('QuietMark read · sets aside 1 question');
    release(500, 1500);
  });

  test('a place that cannot take the thread shows greyed and says why; a drop there changes nothing and says so', async () => {
    draw();
    // Already in Priority.
    pickUp(BILLING.thread_id);
    expect(slot('priority')!.hasAttribute('data-refused')).toBe(true);
    expect(slot('priority')!.textContent).toBe('PriorityAlready in Priority');
    move(300, -10);
    expect(slot('priority')!.hasAttribute('data-hot')).toBe(false);
    expect(ghost()!.hasAttribute('data-refused')).toBe(true);
    expect(ghostWord()).toBe('');
    release(300, -10);
    await wait(50);
    expect(live()).toBe('Cancelled. Nothing changed.');
    // An archived thread (the Archived group's row): Archive and Quiet each say why.
    pickUp(OLD.thread_id);
    expect(slot('archive')!.textContent).toBe('ArchiveAlready archived');
    expect(slot('quiet')!.textContent).toBe('QuietArchived: nothing to mark read');
    expect(slot('priority')!.textContent).toBe('PriorityUnarchive it first');
    move(100, 2100);
    release(100, 2100);
    expect(actions).toEqual([]);
  });

  test('several picked rows move together: one bulk write each, one toast, and its Undo takes them all back', async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    pickUp(SEARCH.thread_id);
    expect(ghost()!.classList.contains('ib-tdrag-stack')).toBe(true);
    expect(slot('priority')!.textContent).toBe('PriorityPut them first in your list');
    move(300, -10);
    release(300, -10);
    await wait(20);
    expect(actions).toEqual([]);
    expect(writes.filter((w) => w.includes('/priority'))).toEqual([
      `POST /api/inbox/threads/${RATE.thread_id}/priority {"priority":true}`,
      `POST /api/inbox/threads/${SEARCH.thread_id}/priority {"priority":true}`,
    ]);
    expect(toasts.map((t) => t.lead)).toEqual(['Added 2 threads to Priority']);
    writes = [];
    act(() => toasts[0]!.onUndo!());
    await wait(20);
    expect(writes.filter((w) => w.includes('/priority')).length).toBe(2);
    expect(writes.every((w) => w.includes('"restore"'))).toBe(true);
    // Still picked: the same two go to the archive together.
    writes = [];
    pickUp(RATE.thread_id);
    move(100, 2100);
    release(100, 2100);
    await wait(20);
    expect(writes.filter((w) => w.includes('/resolve')).length).toBe(2);
    expect(toasts.map((t) => t.lead)).toEqual(['Added 2 threads to Priority', 'Archived 2 threads']);
    expect(actions).toEqual([]);
  });
});

describe.skipIf(!hasDom)('held on another row: Combine opens its dialog', () => {
  test('passing over a row arms nothing; held 500 ms over its middle it fills, says Combine, and the drop opens the dialog with both picked', async () => {
    draw();
    pickUp(RATE.thread_id);
    // Over SEARCH's middle, but on the way somewhere: let go before the hold.
    move(300, 250);
    expect(rowEl(SEARCH.thread_id).getAttribute('data-thread-combine')).toBe('arming');
    expect(ghostWord()).toBe('');
    await wait(COMBINE_DWELL_MS / 2);
    release(300, 250);
    expect(rowEl(SEARCH.thread_id).hasAttribute('data-thread-combine')).toBe(false);
    expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
    // The row's edge (its top 20%) never arms.
    pickUp(RATE.thread_id);
    move(300, 205);
    expect(rowEl(SEARCH.thread_id).hasAttribute('data-thread-combine')).toBe(false);
    // Held over the middle.
    move(300, 260);
    await wait(COMBINE_DWELL_MS + 60);
    expect(rowEl(SEARCH.thread_id).getAttribute('data-thread-combine')).toBe('on');
    expect(document.querySelector('.ib-tcomb')?.textContent).toBe('Combine with this thread');
    expect(ghostWord()).toBe('Combine');
    release(300, 260);
    await wait(20);
    const dialog = document.querySelector<HTMLElement>('[data-dialog="combine"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Combine 2 threads');
    // Nothing combined by itself; Cancel has the focus.
    expect(combineStarts).toBe(0);
    expect(document.activeElement?.hasAttribute('data-combine-cancel')).toBe(true);
    expect([...document.querySelectorAll('[data-pick-bar]')].length).toBe(1);
    act(() => (document.activeElement as HTMLElement).click());
    await wait(20);
    // Cancel leaves nothing behind: no dialog, no picking.
    expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
    expect(actions).toEqual([]);
  });

  test('several picked rows held on another: the dialog has all of them and that one', async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    pickUp(RATE.thread_id);
    move(300, 50);
    await wait(COMBINE_DWELL_MS + 60);
    release(300, 50);
    await wait(20);
    expect(document.querySelector('[data-dialog="combine"] h2')!.textContent).toBe('Combine 3 threads');
  });

  test('an Archived group row neither carries a Combine nor takes one', async () => {
    draw();
    pickUp(OLD.thread_id);
    move(300, 150);
    expect(rowEl(RATE.thread_id).hasAttribute('data-thread-combine')).toBe(false);
    release(300, 150);
    pickUp(RATE.thread_id);
    move(300, 450);
    expect(rowEl(OLD.thread_id).hasAttribute('data-thread-combine')).toBe(false);
    release(300, 450);
  });
});

describe.skipIf(!hasDom)('the empty thread panel takes a carried thread', () => {
  test('it shows "Open here" while a row is carried and opens the dropped thread once; nothing else takes it', async () => {
    draw();
    const pane = document.querySelector<HTMLElement>('.ib-pempty')!;
    expect(pane.textContent).toBe('No thread selected');
    pickUp(RATE.thread_id);
    expect(pane.getAttribute('data-thread-drop')).toBe('target');
    expect(pane.querySelector('.ib-topen')!.textContent).toBe('Open here');
    move(1200, 300);
    expect(pane.getAttribute('data-thread-drop')).toBe('over');
    expect(ghostWord()).toBe('Open here');
    release(1200, 300);
    expect(opened).toEqual([RATE.thread_id]);
    expect(actions).toEqual([]);
    expect(pane.hasAttribute('data-thread-drop')).toBe(false);
    expect(pane.textContent).toBe('No thread selected');
  });

  test('several picked rows: it says to bring one, and a drop opens nothing', async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    pickUp(RATE.thread_id);
    const pane = document.querySelector<HTMLElement>('.ib-pempty')!;
    expect(pane.getAttribute('data-thread-drop')).toBe('refuse');
    expect(pane.querySelector('.ib-topen')!.textContent).toBe('Open one thread at a time');
    move(1200, 300);
    release(1200, 300);
    expect(opened).toEqual([]);
  });
});

describe.skipIf(!hasDom)('the scroll band and a docked edge', () => {
  test('while an edge place is docked over the list, the band is the strip just inside it, and on the place nothing scrolls', () => {
    const list = document.createElement('div');
    Object.defineProperty(list, 'scrollHeight', { value: 1000 });
    Object.defineProperty(list, 'clientHeight', { value: 300 });
    list.scrollTop = 200;
    list.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 400, width: 300, height: 300, x: 0, y: 100, toJSON: () => null }) as DOMRect;
    const dock = (top: number) => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ left: 8, right: 292, top, bottom: top + 52, width: 284, height: 52, x: 8, y: top, toJSON: () => null }) as DOMRect;
      return el;
    };
    const top = dock(100);
    const bottom = dock(340);
    const target = (el: HTMLElement, edge: 'top' | 'bottom') => registerThreadDropTarget({ element: () => el, edge, what: '', accepts: () => 'take', show: () => {}, over: () => {}, drop: () => {} });
    const offs = [target(top, 'top'), target(bottom, 'bottom')];
    try {
      // On the docked places: nothing.
      expect(scrollStep(list, 150, 120)).toBe(0);
      expect(scrollStep(list, 150, 380)).toBe(0);
      // Just inside them: up under the top one, down over the bottom one, faster nearer.
      expect(scrollStep(list, 150, 156)).toBeLessThan(scrollStep(list, 150, 190));
      expect(scrollStep(list, 150, 190)).toBeLessThan(0);
      expect(scrollStep(list, 150, 336)).toBeGreaterThan(scrollStep(list, 150, 300));
      expect(scrollStep(list, 150, 300)).toBeGreaterThan(0);
      expect(scrollStep(list, 150, 250)).toBe(0);
    } finally {
      offs.forEach((off) => off());
    }
  });
});
