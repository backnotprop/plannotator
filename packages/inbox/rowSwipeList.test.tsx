/**
 * Swipe a thread row on a touch screen (rowSwipe.ts) in the list as a phone
 * draws it (InboxList, phone rows), with touch events dispatched on a row:
 * a short slow swipe rests open on the action's button, a real button named
 * with the thread's title, and a tap on it runs the action; a long swipe and
 * a flick run it at once; a vertical drag, a start at the screen's side and a
 * hold that never moves do nothing; a tap still opens the thread, and the
 * click that ends a swipe opens nothing; a tap elsewhere closes an open row;
 * a Mark read whose warning is cancelled leaves the row at rest where it was.
 * Every action goes through the list's `onRowAction` (the row menu's).
 *
 * The rules alone are rowSwipe.test.ts; real touch, the toasts, Undo and the
 * warning are tests/e2e/inbox-row-swipe.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { RowMenuAction } from './rowMenu';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

function row(n: number, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: `msg_${n}`,
    project_id: 'prj_1',
    subject: `Thread ${n}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${n}`, name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

const READ = { section: 'quiet', unread: false, waiting_on_person: false, questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null } } as Partial<InboxListRow>;

function sections(): InboxListSection[] {
  return [
    { id: 'waiting', label: 'Waiting on you', threads: Array.from({ length: 60 }, (_, i) => row(i)) },
    // Read rows (Quiet starts folded, so they are drawn in New here, as the held list can).
    { id: 'new', label: 'New', threads: [row(100, READ), row(101, { ...READ, resolved_at: '2026-10-10T12:00:00.000Z' })] },
  ];
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let actions: [string, RowMenuAction][] = [];
let opened: string[] = [];
/** What `onRowAction` hands back (Archive's write; a cancelled warning's nothing). */
let answer: () => unknown = () => undefined;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  actions = [];
  opened = [];
  answer = () => undefined;
});

function draw(): void {
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
            sections={sections()}
            filtered={false}
            narrow={false}
            phone
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={(r) => opened.push(r.thread_id)}
            onMarkRead={() => {}}
            onMarkUnread={() => {}}
            onRowAction={(r, action) => {
              actions.push([r.thread_id, action]);
              return answer();
            }}
          />
        </div>
      </SidebarProvider>,
    );
  });
}

const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-mrow[data-thread-id="${id}"]`)!;
const layer = () => host!.querySelector<HTMLElement>('[data-row-swipe-layer]')!;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function touch(target: Element, type: string, x: number, y: number): void {
  const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  target.dispatchEvent(event);
}

/** One finger on `target` at (x, y), moved by (dx, dy) in `moves` steps `gap` ms apart, then held `hold` ms and lifted. */
async function swipe(target: Element, dx: number, dy = 0, { x = 200, y = 100, moves = 8, gap = 20, hold = 120 } = {}): Promise<void> {
  await act(async () => {
    touch(target, 'touchstart', x, y);
    for (let i = 1; i <= moves; i++) {
      await sleep(gap);
      touch(target, 'touchmove', x + (dx * i) / moves, y + (dy * i) / moves);
    }
    await sleep(hold);
    touch(target, 'touchend', x + dx, y + dy);
  });
}

/** Waits for the row's spring to settle (its transform stops changing). */
async function settled(el: HTMLElement): Promise<string> {
  let last = el.style.transform;
  let still = 0;
  for (let i = 0; i < 100 && still < 3; i++) {
    await act(async () => {
      await sleep(30);
    });
    still = el.style.transform === last ? still + 1 : 0;
    last = el.style.transform;
  }
  return last;
}

const offsetOf = (el: HTMLElement) => {
  const match = /translate3d\((-?[\d.]+)px/.exec(el.style.transform);
  return match ? Number(match[1]) : 0;
};

test.skipIf(!hasDom)('a short slow swipe left rests open on Archive, a real named button; a tap on it archives the row', async () => {
  draw();
  const el = rowEl('msg_2');
  await swipe(el, -90);
  await settled(el);
  expect(offsetOf(el)).toBeCloseTo(-96, 0);
  expect(layer().dataset.side).toBe('trail');
  expect(actions).toEqual([]);
  const button = layer().querySelector<HTMLButtonElement>('[data-row-swipe="trail"]')!;
  expect(button.tagName).toBe('BUTTON');
  expect(button.getAttribute('aria-label')).toBe('Archive: Thread 2');
  expect(button.textContent).toBe('Archive');
  await act(async () => button.click());
  expect(actions).toEqual([['msg_2', 'archive']]);
  // The row slides off, then comes back in place (the held list shows it Archived there).
  await settled(el);
  await act(async () => {
    await sleep(300);
  });
  expect(el.style.transform).toBe('');
  expect(el.isConnected).toBe(true);
  expect(layer().dataset.side).toBeUndefined();
});

test.skipIf(!hasDom)('a short slow swipe right rests open on Quiet (Mark read); its tap marks the row read', async () => {
  draw();
  const el = rowEl('msg_3');
  await swipe(el, 90);
  await settled(el);
  expect(offsetOf(el)).toBeCloseTo(96, 0);
  expect(layer().dataset.side).toBe('lead');
  expect(layer().dataset.lead).toBe('read');
  const button = layer().querySelector<HTMLButtonElement>('[data-row-swipe="lead"]')!;
  expect(button.getAttribute('aria-label')).toBe('Mark read, move to Quiet: Thread 3');
  await act(async () => button.click());
  expect(actions).toEqual([['msg_3', 'read']]);
  expect(await settled(el)).toBe('');
});

test.skipIf(!hasDom)('a long swipe runs the action at once, whatever the speed', async () => {
  draw();
  await swipe(rowEl('msg_4'), -220, 0, { moves: 12, gap: 20 });
  expect(actions).toEqual([['msg_4', 'archive']]);
  await swipe(rowEl('msg_5'), 220, 0, { moves: 12, gap: 20 });
  expect(actions).toEqual([
    ['msg_4', 'archive'],
    ['msg_5', 'read'],
  ]);
  // Quiet leaves the row where it is: it springs back into place.
  expect(await settled(rowEl('msg_5'))).toBe('');
});

test.skipIf(!hasDom)('a flick runs the action from a short distance', async () => {
  draw();
  await swipe(rowEl('msg_6'), -70, 0, { moves: 5, gap: 12, hold: 0 });
  expect(actions).toEqual([['msg_6', 'archive']]);
});

test.skipIf(!hasDom)('a vertical drag, a start at the screen side and a hold that never moves do nothing', async () => {
  draw();
  const el = rowEl('msg_7');
  await swipe(el, 6, 120);
  expect(el.style.transform).toBe('');
  expect(el.hasAttribute('data-swipe')).toBe(false);
  // From the left edge (Safari's Back): the same sideways move is no swipe.
  await swipe(el, 220, 0, { x: 10 });
  expect(el.style.transform).toBe('');
  // A hold without movement is left alone (no transform, no layer).
  await swipe(el, 0, 0, { moves: 1, gap: 600, hold: 0 });
  expect(el.style.transform).toBe('');
  expect(layer().dataset.side).toBeUndefined();
  expect(actions).toEqual([]);
});

test.skipIf(!hasDom)('a tap opens the thread; the click that ends a swipe opens nothing', async () => {
  draw();
  const el = rowEl('msg_8');
  await act(async () => el.click());
  expect(opened).toEqual(['msg_8']);
  await swipe(el, -90);
  await act(async () => el.click());
  expect(opened).toEqual(['msg_8']);
});

test.skipIf(!hasDom)('a tap elsewhere closes the open row without opening anything; one row is open at a time', async () => {
  draw();
  const a = rowEl('msg_9');
  const b = rowEl('msg_10');
  await swipe(a, -90);
  await settled(a);
  expect(offsetOf(a)).toBeCloseTo(-96, 0);
  // Another row's swipe closes the first one.
  await swipe(b, 90);
  await settled(b);
  expect(a.style.transform).toBe('');
  expect(offsetOf(b)).toBeCloseTo(96, 0);
  // A tap on another row closes the open one and opens nothing.
  await act(async () => {
    touch(a, 'touchstart', 200, 100);
    touch(a, 'touchend', 200, 100);
    a.click();
  });
  expect(await settled(b)).toBe('');
  expect(opened).toEqual([]);
  expect(actions).toEqual([]);
});

test.skipIf(!hasDom)("Mark read whose warning is cancelled leaves the row at rest where it was", async () => {
  draw();
  // The warning's Cancel: the action resolves having changed nothing.
  answer = () => Promise.resolve();
  const el = rowEl('msg_11');
  const before = el.previousElementSibling;
  await swipe(el, 220, 0, { moves: 12 });
  expect(actions).toEqual([['msg_11', 'read']]);
  expect(await settled(el)).toBe('');
  expect(el.hasAttribute('data-swipe')).toBe(false);
  expect(el.previousElementSibling).toBe(before);
  expect(layer().dataset.side).toBeUndefined();
});

test.skipIf(!hasDom)('a read row swipes right to Mark unread; an archived row shown in place does not swipe', async () => {
  draw();
  const read = rowEl('msg_100');
  await swipe(read, 90);
  await settled(read);
  expect(layer().dataset.lead).toBe('mark-unread');
  expect(layer().querySelector('[data-row-swipe="lead"]')!.getAttribute('aria-label')).toBe('Mark unread: Thread 100');
  await act(async () => layer().querySelector<HTMLButtonElement>('[data-row-swipe="lead"]')!.click());
  expect(actions).toEqual([['msg_100', 'mark-unread']]);
  const archived = rowEl('msg_101');
  await swipe(archived, -220, 0, { moves: 12 });
  expect(archived.style.transform).toBe('');
  expect(actions).toEqual([['msg_100', 'mark-unread']]);
});
