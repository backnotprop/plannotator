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
const { COMBINE_DWELL_MS, useRowDragA11y } = (hasDom ? await import('./listDrops') : {}) as typeof import('./listDrops');

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
/** The threads each Combine dialog asked about (its plan read, `/combine?threads=`), in the order sent. */
let combinePlans: string[][] = [];
/** What one row's menu action resolves to (App.tsx `rowAction`: a Mark read whose warning was cancelled gives false). */
let rowActionAnswer: unknown;
/** The person's answer to Mark read's set-aside warning in the picks' writes (true: go on). */
let warnGoesOn = true;

beforeEach(() => {
  realFetch = globalThis.fetch;
  writes = [];
  // Every write answers as the server does when it goes; the Combine dialog's plan has one agent.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/combine')) {
      combinePlans.push(decodeURIComponent(new URL(url, 'http://x').searchParams.get('threads') ?? '').split(','));
      return Response.json({ agents: [{ session: 'ses_a', name: 'Claude Code', host: 'claude-code', threads: 2 }] });
    }
    writes.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')} ${init?.body ?? ''}`);
    return Response.json({ before: { priority: null } });
  }) as unknown as typeof fetch;
  actions = [];
  opened = [];
  toasts = [];
  combineStarts = 0;
  combinePlans = [];
  rowActionAnswer = undefined;
  warnGoesOn = true;
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
    warnSetAside: async () => warnGoesOn,
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
            onAction={(row, action) => {
              actions.push([row.thread_id, action]);
              return rowActionAnswer;
            }}
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
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
/** ⌘-click: picks the row (useListPicks.ts), as the person does before carrying several. */
const cmdClick = (id: string) => act(() => void rowEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));

describe.skipIf(!hasDom)('the list edges take a carried thread', () => {
  test('the places show only while a thread is carried, and leave with the drop', async () => {
    draw();
    expect(document.querySelector('.ib-tedge')).toBeNull();
    pickUp(RATE.thread_id);
    expect(threadDragging()).toBe(true);
    expect(slot('priority')?.textContent).toBe('Priority');
    expect(slot('archive')?.textContent).toBe('Archive');
    expect(slot('quiet')?.textContent).toBe('Quiet');
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

  test('a thread with an open question: Quiet is its name alone and takes it, the drop running Mark read (whose warning names what it sets aside)', async () => {
    draw();
    pickUp(FLAKY.thread_id);
    expect(slot('quiet')!.textContent).toBe('Quiet');
    expect(slot('quiet')!.hasAttribute('data-refused')).toBe(false);
    move(400, 2100);
    expect(ghostWord()).toBe('Quiet');
    release(400, 2100);
    expect(actions).toEqual([[FLAKY.thread_id, 'read']]);
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
    expect(live()).toBe('Already in Priority. Nothing changed.');
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
    expect(slot('priority')!.textContent).toBe('Priority');
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
    // The drop ended picking (drag-system.html: picks clear after any drop).
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
    // Picked again: exactly those two go to the archive together, and picking ends again.
    writes = [];
    cmdClick(RATE.thread_id);
    cmdClick(FLAKY.thread_id);
    pickUp(RATE.thread_id);
    move(100, 2100);
    release(100, 2100);
    await wait(20);
    const archived = writes.filter((w) => w.includes('/resolve')).map((w) => ALL.find((row) => w.includes(row.thread_id))?.thread_id);
    expect(archived.sort()).toEqual([FLAKY.thread_id, RATE.thread_id].sort());
    expect(toasts.map((t) => t.lead)).toEqual(['Added 2 threads to Priority', 'Archived 2 threads']);
    expect(actions).toEqual([]);
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
  });

  test('one row dropped while others are picked: its action runs, and picking ends', async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
    pickUp(FLAKY.thread_id);
    move(300, -10);
    release(300, -10);
    await wait(20);
    expect(actions).toEqual([[FLAKY.thread_id, 'priority-add']]);
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
  });

  test('a drop that changes nothing (a place that took it, then had no room) keeps the picks; one that does something ends them', async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    const spot = document.createElement('div');
    document.body.appendChild(spot);
    let did = false;
    const off = registerThreadDropTarget({ element: () => spot, layer: 40, what: 'Somewhere', accepts: () => 'take', show: () => {}, over: () => {}, drop: () => did });
    setThreadDragHitTestForTests(() => spot);
    try {
      pickUp(FLAKY.thread_id);
      move(700, 700);
      release(700, 700);
      await wait(20);
      expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
      did = true;
      pickUp(FLAKY.thread_id);
      move(700, 700);
      release(700, 700);
      await wait(20);
      expect(document.querySelector('[data-pick-bar]')).toBeNull();
    } finally {
      off();
      spot.remove();
    }
  });

  test("a drop on Quiet whose Mark read warning is cancelled keeps the picks; once it goes on, picking ends", async () => {
    draw();
    cmdClick(RATE.thread_id);
    cmdClick(SEARCH.thread_id);
    // One unpicked row with an open question: its menu's Mark read asks, and the person cancels.
    let answer!: (went: boolean) => void;
    rowActionAnswer = new Promise<boolean>((resolve) => (answer = resolve));
    pickUp(FLAKY.thread_id);
    move(400, 2100);
    release(400, 2100);
    expect(actions).toEqual([[FLAKY.thread_id, 'read']]);
    // While the warning is up, and after its Cancel, the picks stay.
    expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
    await act(async () => answer(false));
    expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
    // Again, and this time it goes on: picking ends, as any drop's does.
    rowActionAnswer = new Promise<boolean | void>((resolve) => (answer = resolve));
    pickUp(FLAKY.thread_id);
    move(400, 2100);
    release(400, 2100);
    expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
    await act(async () => answer(true));
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
  });

  test('several picked rows dropped on Quiet, the warning cancelled: nothing is written and the picks stay; gone on, they end', async () => {
    draw();
    cmdClick(FLAKY.thread_id);
    cmdClick(RATE.thread_id);
    warnGoesOn = false;
    pickUp(FLAKY.thread_id);
    move(400, 2100);
    release(400, 2100);
    await wait(20);
    expect(writes).toEqual([]);
    expect(document.querySelector('[data-pick-bar]')).not.toBeNull();
    warnGoesOn = true;
    pickUp(FLAKY.thread_id);
    move(400, 2100);
    release(400, 2100);
    await wait(20);
    expect(writes.length).toBe(2);
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
  });

  test('Escape while over Archive: nothing is archived, the places go, and it says so', async () => {
    draw();
    pickUp(RATE.thread_id);
    move(100, 2100);
    expect(slot('archive')!.hasAttribute('data-hot')).toBe(true);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('.ib-tedge')).toBeNull();
    await wait(60);
    expect(live()).toBe('Cancelled. Nothing changed.');
    release(100, 2100);
    await wait(20);
    expect(actions).toEqual([]);
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('an Undo toast up over the bottom edge: the place under it still takes the drop, and the toast is never pressed', async () => {
    draw();
    // A toast as the window draws it, lying over Quiet; the hit test is the browser's, toast first.
    const toast = document.createElement('div');
    toast.setAttribute('data-inbox-toast', '');
    const undo = document.createElement('button');
    let undone = 0;
    undo.addEventListener('click', () => void undone++);
    toast.appendChild(undo);
    document.querySelector('.pn-inbox')!.appendChild(toast);
    setThreadDragHitTestForTests(null);
    const realStack = document.elementsFromPoint;
    document.elementsFromPoint = ((x: number, y: number) => {
      if (y > 2000) return [undo, toast, x < 200 ? slot('archive') : slot('quiet'), document.body].filter(Boolean) as Element[];
      const row = ALL[Math.floor(y / 100)];
      return row ? [rowEl(row.thread_id).querySelector('.ib-title')!, document.body] : [document.body];
    }) as typeof document.elementsFromPoint;
    try {
      pickUp(SEARCH.thread_id);
      move(400, 2100);
      expect(slot('quiet')!.hasAttribute('data-hot')).toBe(true);
      expect(ghostWord()).toBe('Quiet');
      release(400, 2100);
      expect(actions).toEqual([[SEARCH.thread_id, 'read']]);
      expect(undone).toBe(0);
    } finally {
      document.elementsFromPoint = realStack;
      toast.remove();
    }
  });
});

describe.skipIf(!hasDom)("the drop's own click, and the person's next one", () => {
  /** A button outside the list (the drop's toast's Undo), counting the clicks that reach it. */
  function undoButton() {
    const undo = document.createElement('button');
    const pressed = { count: 0 };
    undo.addEventListener('click', () => void pressed.count++);
    document.querySelector('.pn-inbox')!.appendChild(undo);
    return { undo, pressed };
  }
  const clickAt = (el: Element, x: number, y: number) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })));

  test("a drop on Archive that the browser follows with no click: Undo pressed at once still undoes (it was swallowed for 400 ms)", () => {
    draw();
    const { undo, pressed } = undoButton();
    pickUp(RATE.thread_id);
    move(100, 2100);
    // The place under the release leaves with the drop, so the browser fires no click of its own.
    act(() => void window.dispatchEvent(new PointerEvent('pointerup', at(100, 2100, 0))));
    expect(actions).toEqual([[RATE.thread_id, 'archive']]);
    clickAt(undo, 700, 2300);
    expect(pressed.count).toBe(1);
  });

  test("the click a release brings, where it was let go, still opens nothing; the next one elsewhere goes through", () => {
    draw();
    const { undo, pressed } = undoButton();
    let reached = 0;
    const count = () => void reached++;
    document.body.addEventListener('click', count);
    try {
      pickUp(RATE.thread_id);
      move(100, 2100);
      release(100, 2100);
      expect(reached).toBe(0);
      clickAt(undo, 700, 2300);
      expect(pressed.count).toBe(1);
    } finally {
      document.body.removeEventListener('click', count);
    }
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
    expect(combinePlans.at(-1)!.sort()).toEqual([RATE.thread_id, SEARCH.thread_id].sort());
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
    expect(combinePlans.at(-1)!.sort()).toEqual([FLAKY.thread_id, RATE.thread_id, SEARCH.thread_id].sort());
  });

  test('one unpicked row held on another while others are picked: the dialog has those two; its Cancel ends picking', async () => {
    draw();
    cmdClick(FLAKY.thread_id);
    cmdClick(BILLING.thread_id);
    pickUp(RATE.thread_id);
    move(300, 250);
    await wait(COMBINE_DWELL_MS + 60);
    release(300, 250);
    await wait(20);
    expect(combinePlans.at(-1)!.sort()).toEqual([RATE.thread_id, SEARCH.thread_id].sort());
    act(() => document.querySelector<HTMLElement>('[data-combine-cancel]')!.click());
    await wait(20);
    expect(document.querySelector('[data-pick-bar]')).toBeNull();
  });

  test('a held row that moves away or leaves the list before the hold ends arms nothing, and the drop opens nothing', async () => {
    draw();
    pickUp(RATE.thread_id);
    move(300, 250);
    expect(rowEl(SEARCH.thread_id).getAttribute('data-thread-combine')).toBe('arming');
    // New rows push it down under the still pointer: BILLING is under it now.
    const searchBox = rowEl(SEARCH.thread_id).getBoundingClientRect;
    rowEl(SEARCH.thread_id).getBoundingClientRect = () => ({ ...searchBox(), top: 300, bottom: 400, y: 300 }) as DOMRect;
    setThreadDragHitTestForTests((_x, y) => (y > 200 && y < 300 ? rowEl(BILLING.thread_id).querySelector('.ib-title') : null));
    await wait(COMBINE_DWELL_MS + 60);
    expect(rowEl(SEARCH.thread_id).getAttribute('data-thread-combine')).toBeNull();
    expect(document.querySelector('.ib-tcomb')).toBeNull();
    release(300, 250);
    await wait(20);
    expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
    // A held row that leaves the list (archived elsewhere) mid-hold: nothing arms either.
    standIn();
    pickUp(RATE.thread_id);
    move(300, 250);
    const held = rowEl(SEARCH.thread_id);
    expect(held.getAttribute('data-thread-combine')).toBe('arming');
    setThreadDragHitTestForTests(() => null);
    held.parentElement!.style.display = 'none';
    await wait(COMBINE_DWELL_MS + 60);
    expect(held.getAttribute('data-thread-combine')).toBeNull();
    release(300, 250);
    await wait(20);
    expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
    expect(combinePlans).toEqual([]);
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

describe.skipIf(!hasDom)("a row's drag role and help: only where a drag can happen, naming only the places offered", () => {
  /** A row as InboxList.tsx draws its description: its badge's words (`words`), then the drag help. */
  function Row({ words }: { words?: string }) {
    return <button type="button" className="ib-nrow" data-thread-id={RATE.thread_id} {...useRowDragA11y(words)} />;
  }
  const menu = (props: { disabled?: boolean; canMarkRead?: boolean }) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <ThreadRowMenu className="ib-lbody" rowOf={() => RATE} canMarkRead={props.canMarkRead ?? true} held={false} disabled={props.disabled} onAction={() => {}} onTarget={() => {}}>
          <Row words="ib-badge-words" />
        </ThreadRowMenu>,
      );
    });
    return rowEl(RATE.thread_id);
  };

  test('with row actions: "draggable thread", the badge words then the help, whose words name no Quiet and no Combine the list lacks', () => {
    const row = menu({ canMarkRead: false });
    expect(row.getAttribute('aria-roledescription')).toBe('draggable thread');
    expect(row.getAttribute('aria-describedby')).toBe('ib-badge-words ib-thread-drag-help');
    expect(document.getElementById('ib-thread-drag-help')!.textContent).toBe('Drag to the reply box to mention it, to the top for Priority, or to the bottom for Archive. Or open the menu with Shift F10.');
  });

  test('the full list (Mark read, Combine): the help names Quiet and Combine', () => {
    draw();
    expect(document.getElementById('ib-thread-drag-help')!.textContent).toBe('Drag to the reply box to mention it, to the top for Priority, to the bottom for Quiet or Archive, or hold over another thread to combine. Or open the menu with Shift F10.');
  });

  test('no row actions: no role words, no help, the badge words kept, and no id pointing at nothing', () => {
    const row = menu({ disabled: true });
    expect(row.hasAttribute('aria-roledescription')).toBe(false);
    expect(row.getAttribute('aria-describedby')).toBe('ib-badge-words');
    expect(document.getElementById('ib-thread-drag-help')).toBeNull();
  });

  test('a touch screen with no fine pointer (touch never drags): no role words, no help', () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const row = menu({});
      expect(row.hasAttribute('aria-roledescription')).toBe(false);
      expect(row.getAttribute('aria-describedby')).toBe('ib-badge-words');
      expect(document.getElementById('ib-thread-drag-help')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});

describe.skipIf(!hasDom)("a row's drag help follows the pointers the device has", () => {
  /** A device's media: the queries that match now, and the `change` listeners a query has (a pointer added or gone). */
  function device(matching: string[]) {
    const now = new Set(matching);
    const heard = new Set<() => void>();
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return now.has(query);
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => heard.add(fn),
      removeEventListener: (_: string, fn: () => void) => heard.delete(fn),
    })) as unknown as typeof window.matchMedia;
    return {
      set: (next: string[]) => act(() => {
        now.clear();
        next.forEach((query) => now.add(query));
        heard.forEach((fn) => fn());
      }),
      restore: () => void (window.matchMedia = real),
    };
  }
  function Row() {
    return <button type="button" className="ib-nrow" data-thread-id={RATE.thread_id} {...useRowDragA11y()} />;
  }
  const menu = () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <ThreadRowMenu className="ib-lbody" rowOf={() => RATE} canMarkRead={true} held={false} onAction={() => {}} onTarget={() => {}}>
          <Row />
        </ThreadRowMenu>,
      );
    });
  };
  const IPAD = ['(any-pointer: coarse)', '(pointer: coarse)', '(any-hover: none)', '(hover: none)'];
  const says = () => rowEl(RATE.thread_id).getAttribute('aria-roledescription') === 'draggable thread' && document.getElementById('ib-thread-drag-help') !== null;

  test('an iPad with its Pencil (a fine pointer that is not the main one, and a pen never drags there): no drag is announced', () => {
    const media = device([...IPAD, '(any-pointer: fine)']);
    try {
      menu();
      expect(says()).toBe(false);
    } finally {
      media.restore();
    }
  });

  test('a trackpad connected mid-session announces the drag at once, and taken away it goes, with no other render', () => {
    const media = device(IPAD);
    try {
      menu();
      expect(says()).toBe(false);
      media.set([...IPAD, '(any-pointer: fine)', '(any-hover: hover)']);
      expect(says()).toBe(true);
      media.set(IPAD);
      expect(says()).toBe(false);
    } finally {
      media.restore();
    }
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
    expect(pane.querySelector('.ib-topen')!.hasAttribute('data-ghost-says')).toBe(false);
    move(1200, 300);
    expect(pane.getAttribute('data-thread-drop')).toBe('over');
    expect(ghostWord()).toBe('Open here');
    // One label: under the pointer the ghost says it, so the pane's own steps out of sight (inbox.css).
    expect(pane.querySelector('.ib-topen')!.hasAttribute('data-ghost-says')).toBe(true);
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
