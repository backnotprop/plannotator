/**
 * The keys of approval "inbox-keyboard-keys-2026-11-07" that live in one component (DOM_TESTS=1 for the DOM ones).
 * What would regress: an arrow in the Artifacts grid or on the Board landing on the wrong tile (or moving at all from
 * outside one); H opening the header clock's menu without focus in it, snoozing on its own, or opening again by
 * itself when the clock mounts again; H on a row opening another row's menu, or a menu on a row that cannot snooze;
 * Shift+E archiving the wrong thread; C and G P / G D firing while typing, on the tour, or where their page is
 * hidden; Shift+F10 on a message head not opening its ⋯ menu, or opening it from a text field. Shift+R (approval
 * "inbox-refresh-key") not running the page's refresh from the list or an open thread, running it while typing, under a
 * dialog, with single keys off or where the page has none, or taking plain R from Reply.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideArtifact } from './artifacts';
import { gridStep, laneStep, type Box } from './gridMove';
import { archiveTarget, newPageKeys, refreshAction, refreshKey, refreshKind, type AppKeyPages, type RefreshView } from './keyboard/appKeys';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ArtifactsView } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');
const { ThreadSnooze, MessageMenu } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { useShortcutScope } = (hasDom ? await import('@plannotator/ui/shortcuts') : {}) as typeof import('@plannotator/ui/shortcuts');
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const prefs = await import('./shortcuts/prefs');
const { inboxAppShortcuts } = await import('./shortcuts/app.shortcuts');

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const frames = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

/** A 3-column grid of 100 × 80 boxes with a 10 px gap, in reading order. */
const grid = (n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 90, width: 100, height: 80 }));

test('the Artifacts grid: ← → in reading order, ↑ ↓ by column, Home End the ends, nothing past an edge', () => {
  const boxes = grid(8); // rows: 0 1 2 / 3 4 5 / 6 7
  expect(gridStep(boxes, 4, 'ArrowRight')).toBe(5);
  expect(gridStep(boxes, 3, 'ArrowLeft')).toBe(2);
  expect(gridStep(boxes, 1, 'ArrowDown')).toBe(4);
  expect(gridStep(boxes, 4, 'ArrowUp')).toBe(1);
  // The last row is short: ↓ from the third column lands on the nearest tile below.
  expect(gridStep(boxes, 5, 'ArrowDown')).toBe(7);
  expect(gridStep(boxes, 0, 'Home')).toBeNull();
  expect(gridStep(boxes, 4, 'Home')).toBe(0);
  expect(gridStep(boxes, 4, 'End')).toBe(7);
  expect(gridStep(boxes, 0, 'ArrowLeft')).toBeNull();
  expect(gridStep(boxes, 7, 'ArrowRight')).toBeNull();
  expect(gridStep(boxes, 1, 'ArrowUp')).toBeNull();
  expect(gridStep(boxes, 6, 'ArrowDown')).toBeNull();
});

test('the Board: ↑ ↓ within a lane, ← → the nearest card in the next lane with cards, Home End the lane’s ends', () => {
  const lane = (x: number, n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: x, top: i * 100, width: 200, height: 90 }));
  const lanes = [lane(0, 3), lane(220, 0), lane(440, 5)];
  expect(laneStep(lanes, { lane: 0, card: 1 }, 'ArrowDown')).toEqual({ lane: 0, card: 2 });
  expect(laneStep(lanes, { lane: 0, card: 2 }, 'ArrowDown')).toBeNull();
  expect(laneStep(lanes, { lane: 0, card: 0 }, 'ArrowUp')).toBeNull();
  // The empty lane between is passed over; the card at the same height is the one.
  expect(laneStep(lanes, { lane: 0, card: 2 }, 'ArrowRight')).toEqual({ lane: 2, card: 2 });
  expect(laneStep(lanes, { lane: 2, card: 4 }, 'ArrowLeft')).toEqual({ lane: 0, card: 2 });
  expect(laneStep(lanes, { lane: 2, card: 0 }, 'ArrowRight')).toBeNull();
  expect(laneStep(lanes, { lane: 2, card: 2 }, 'End')).toEqual({ lane: 2, card: 4 });
  expect(laneStep(lanes, { lane: 2, card: 2 }, 'Home')).toEqual({ lane: 2, card: 0 });
});

function guide(i: number): GuideArtifact {
  return {
    type: 'guide',
    messageId: `msg_${i}`,
    sender: 'Claude Code',
    sentAt: '11:05 AM',
    at: `2026-11-07T11:0${i}:00.000Z`,
    fromPerson: false,
    host: 'claude-code',
    guide: { sha256: String(i).repeat(64).slice(0, 64), input_sha256: 'a'.repeat(64), bytes: 10, title: `Guide ${i}`, sections: 1, files: 1, additions: 1, deletions: 0 } as GuideArtifact['guide'],
  };
}

test.skipIf(!hasDom)('arrow keys move focus between the Artifacts tiles, and only from a tile', () => {
  const el = mount(<ArtifactsView artifacts={[0, 1, 2, 3, 4].map(guide)} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />);
  const tiles = [...el.querySelectorAll<HTMLElement>('[data-artifact-tile]')];
  expect(tiles.length).toBe(5);
  // Lay the tiles out three to a row (happy-dom draws nothing).
  tiles.forEach((tile, i) => {
    const box = grid(5)[i]!;
    const rect = { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box };
    Object.defineProperty(tile, 'getBoundingClientRect', { configurable: true, value: () => rect });
  });
  act(() => tiles[0]!.focus());
  press(tiles[0]!, 'ArrowRight');
  expect(document.activeElement).toBe(tiles[1]!);
  press(tiles[1]!, 'ArrowDown');
  expect(document.activeElement).toBe(tiles[4]!);
  press(tiles[4]!, 'Home');
  expect(document.activeElement).toBe(tiles[0]!);
  press(tiles[0]!, 'End');
  expect(document.activeElement).toBe(tiles[4]!);
  // With a modifier the arrows are the page's.
  press(tiles[4]!, 'ArrowLeft', { shiftKey: true });
  expect(document.activeElement).toBe(tiles[4]!);
  // From the heading Shift+O lands on: ↓ → Home go to the first tile, End to the last, ↑ ← stay the page's.
  const heading = el.querySelector<HTMLElement>('#ib-art-h')!;
  for (const [key, to] of [['ArrowDown', 0], ['ArrowRight', 0], ['Home', 0], ['End', 4]] as const) {
    act(() => heading.focus());
    press(heading, key);
    expect(document.activeElement).toBe(tiles[to]!);
  }
  for (const key of ['ArrowUp', 'ArrowLeft']) {
    act(() => heading.focus());
    press(heading, key);
    expect(document.activeElement).toBe(heading);
  }
  // Outside the section (the page body), nothing moves.
  act(() => (document.activeElement as HTMLElement).blur());
  press(document.body, 'ArrowDown');
  expect(document.activeElement).toBe(document.body);
});

test.skipIf(!hasDom)('H’s request opens the header clock’s menu with focus on the first time; nothing is snoozed until one is picked', async () => {
  const picked: string[] = [];
  const snooze = { snoozed: false, onPick: (until: string) => picked.push(until), onUnsnooze: () => {} };
  mount(<ThreadSnooze snooze={snooze} openRequest={0} />);
  expect(document.querySelector('[data-thread-snooze-menu]')).toBeNull();
  act(() => root!.render(<ThreadSnooze snooze={snooze} openRequest={1} />));
  await frames();
  const menu = document.querySelector('[data-thread-snooze-menu]');
  expect(menu).not.toBeNull();
  expect(document.activeElement).toBe(menu!.querySelector('[data-snooze-choice]'));
  expect(picked).toEqual([]);
});

test.skipIf(!hasDom)('the clock mounting again with an old request (Z after Shift+E, J/K into a thread) keeps its menu shut; a new one opens it', async () => {
  const snooze = { snoozed: false, onPick: () => {}, onUnsnooze: () => {} };
  mount(<ThreadSnooze snooze={snooze} openRequest={1} />);
  await frames();
  expect(document.querySelector('[data-thread-snooze-menu]')).toBeNull();
  act(() => root!.render(<ThreadSnooze snooze={snooze} openRequest={1} />));
  await frames();
  expect(document.querySelector('[data-thread-snooze-menu]')).toBeNull();
  act(() => root!.render(<ThreadSnooze snooze={snooze} openRequest={2} />));
  await frames();
  expect(document.querySelector('[data-thread-snooze-menu]')).not.toBeNull();
});

test.skipIf(!hasDom)('Shift+F10 on a message’s head opens its ⋯ menu with focus in it', async () => {
  const message = { id: 'msg_1', author: { kind: 'agent', host: 'claude-code', name: 'Claude Code' }, created_at: '2026-11-07T11:00:00.000Z', body: 'Hi' } as never;
  const el = mount(
    <MessageMenu
      thread={{ thread_id: 'thr_1', subject: 'S', messages: [message] } as never}
      message={message}
      linkOf={() => 'http://x'}
      phone={false}
      head={(more) => (
        <div data-test-head="">
          <button type="button" data-fold-head="">
            Claude Code
          </button>
          {more}
        </div>
      )}
    />,
  );
  const head = el.querySelector<HTMLElement>('[data-fold-head]')!;
  act(() => head.focus());
  press(head, 'F10', { shiftKey: true });
  await frames();
  const menu = document.querySelector('[data-message-menu="msg_1"]');
  expect(menu).not.toBeNull();
  expect(menu!.contains(document.activeElement)).toBe(true);
});

test('Shift+E archives the row the keyboard is on, else the open thread by its first message, never an archived one', () => {
  const open = { thread_id: 'thr_open', resolved_at: null, messages: [{ id: 'msg_root' }, { id: 'msg_2' }] };
  const resolved: Record<string, string | null> = { thr_open: null, thr_row: null, thr_done: '2026-11-07T10:00:00.000Z' };
  const resolvedOf = (id: string) => resolved[id];
  // A row the keyboard is on wins over the thread open beside the list.
  expect(archiveTarget({ keyRow: 'thr_row', open, routeThread: 'thr_open', resolvedOf })).toEqual({ threadId: 'thr_row', messageId: 'thr_row' });
  // No keyboard row (a clicked row is passed as none): the open thread, by its first message.
  expect(archiveTarget({ keyRow: null, open, routeThread: 'thr_open', resolvedOf })).toEqual({ threadId: 'thr_open', messageId: 'msg_root' });
  // Archived already, as a row or as the open thread: nothing.
  expect(archiveTarget({ keyRow: 'thr_done', open, routeThread: 'thr_open', resolvedOf })).toBeNull();
  expect(archiveTarget({ keyRow: null, open: { ...open, resolved_at: '2026-11-07T10:00:00.000Z' }, routeThread: 'thr_open', resolvedOf })).toBeNull();
  // A row that is not in the list, or a thread the route has left: nothing.
  expect(archiveTarget({ keyRow: 'thr_gone', open, routeThread: 'thr_open', resolvedOf })).toBeNull();
  expect(archiveTarget({ keyRow: null, open, routeThread: null, resolvedOf })).toBeNull();
});

function AppKeys({ pages, calls }: { pages: AppKeyPages; calls: string[] }) {
  useShortcutScope({
    scope: inboxAppShortcuts,
    handlers: newPageKeys(() => pages, { goPulls: () => calls.push('pulls'), goDrafts: () => calls.push('drafts'), compose: () => calls.push('compose') }),
  });
  return <input data-test-field="" />;
}

test.skipIf(!hasDom)('C opens New message and G P / G D go to their pages, only where they apply', () => {
  const calls: string[] = [];
  const pages: AppKeyPages = { page: 'inbox', pulls: true, drafts: true, composing: false };
  const el = mount(<AppKeys pages={pages} calls={calls} />);
  const key = (k: string, target: Element = document.body) => press(target, k, { code: `Key${k.toUpperCase()}` });
  key('c');
  key('g');
  key('p');
  key('g');
  key('d');
  expect(calls).toEqual(['compose', 'pulls', 'drafts']);
  calls.length = 0;
  // Typing in a field: the letters are the field's.
  const field = el.querySelector<HTMLElement>('[data-test-field]')!;
  act(() => field.focus());
  key('c', field);
  key('g', field);
  key('p', field);
  expect(calls).toEqual([]);
  act(() => field.blur());
  // New message already open: C stands down. A hidden Pull requests or Drafts row: G P / G D stand down.
  Object.assign(pages, { composing: true, pulls: false, drafts: false });
  key('c');
  key('g');
  key('p');
  key('g');
  key('d');
  expect(calls).toEqual([]);
  // On the tour, nothing.
  Object.assign(pages, { page: 'tour', composing: false, pulls: true, drafts: true });
  key('c');
  key('g');
  key('p');
  expect(calls).toEqual([]);
});

function listRow(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_a',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-11-07T10:00:00.000Z',
    last_at: '2026-11-07T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_a', name: 'api' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

test.skipIf(!hasDom)('H on a row opens that row’s menu at the times; an archived row or one that cannot snooze stands down', async () => {
  const sections: InboxListSection[] = [
    { id: 'new', label: 'New', threads: [listRow('thr_a'), listRow('thr_b'), listRow('thr_linked')] },
    { id: 'quiet', label: 'Archived', threads: [listRow('thr_done', { section: 'quiet', resolved_at: '2026-11-07T10:00:00.000Z' })] },
  ];
  const snoozed: string[] = [];
  const el = mount(
    <SidebarProvider>
      <InboxList
        title="Inbox"
        path={null}
        sections={sections}
        filtered={false}
        narrow={false}
        selectedThreadId={null}
        notice={null}
        onShowNew={() => {}}
        onOpen={() => {}}
        phone={false}
        onRowAction={() => {}}
        onSnooze={(row, until) => snoozed.push(`${row.thread_id}@${until}`)}
        snoozesOf={(row) => row.thread_id !== 'thr_linked'}
      />
    </SidebarProvider>,
  );
  const rowButton = (id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
  const menuOf = (id: string) => document.querySelector(`[data-row-menu="${id}"]`);
  const pressH = async (id: string) => {
    const button = rowButton(id)!;
    act(() => button.focus());
    press(button, 'h', { code: 'KeyH' });
    await frames();
  };
  await pressH('thr_b');
  expect(menuOf('thr_b')?.querySelector('[data-snooze-view="times"]')).not.toBeNull();
  expect(menuOf('thr_a')).toBeNull();
  expect(snoozed).toEqual([]);
  press(document.activeElement ?? document.body, 'Escape');
  await frames();
  expect(menuOf('thr_b')).toBeNull();
  // A thread whose agent cannot snooze (a linked machine's), and an archived one: no menu.
  await pressH('thr_linked');
  expect(menuOf('thr_linked')).toBeNull();
  const done = rowButton('thr_done');
  if (done) {
    await pressH('thr_done');
    expect(menuOf('thr_done')).toBeNull();
  }
});

test.skipIf(!hasDom)('Shift+F10 in a text field inside a message’s head is the field’s, not the ⋯ menu', async () => {
  const message = { id: 'msg_1', author: { kind: 'agent', host: 'claude-code', name: 'Claude Code' }, created_at: '2026-11-07T11:00:00.000Z', body: 'Hi' } as never;
  const el = mount(
    <MessageMenu
      thread={{ thread_id: 'thr_1', subject: 'S', messages: [message] } as never}
      message={message}
      linkOf={() => 'http://x'}
      phone={false}
      head={(more) => (
        <div data-test-head="">
          <input data-test-field="" />
          {more}
        </div>
      )}
    />,
  );
  const field = el.querySelector<HTMLElement>('[data-test-field]')!;
  act(() => field.focus());
  press(field, 'F10', { shiftKey: true });
  await frames();
  expect(document.querySelector('[data-message-menu="msg_1"]')).toBeNull();
  expect(document.activeElement).toBe(field);
});

test('Shift+R runs the refresh of the page on screen, route by route; none where the page has no refresh', () => {
  const base: RefreshView = { page: 'inbox', thread: null, fromReviews: false, fromCard: false, pullReview: false, fileOpen: false, tourOn: false, boardOn: true, pullsShown: true, listReady: true };
  const rows: [string, Partial<RefreshView>, ReturnType<typeof refreshKind>][] = [
    ['the Inbox list', {}, 'inbox'],
    ['a project’s list', {}, 'inbox'],
    ['a thread beside the list', { thread: 'thr_1' }, 'inbox'],
    ['a file open from a thread', { thread: 'thr_1', fileOpen: true }, 'inbox'],
    ['a thread opened from a Board card', { thread: 'thr_1', fromCard: true }, 'board+thread'],
    ['a file open in a thread from a card', { thread: 'thr_1', fromCard: true, fileOpen: true }, 'board+thread'],
    ['a thread beside the Reviews list', { thread: 'thr_1', fromReviews: true }, 'reviews+thread'],
    ['a file open in a thread from Reviews', { thread: 'thr_1', fromReviews: true, fileOpen: true }, 'inbox'],
    ['a thread from Reviews with Reviews hidden', { thread: 'thr_1', fromReviews: true, pullsShown: false }, 'inbox'],
    ['the list still loading, first run, the tour’s entry', { listReady: false }, null],
    ['the Board', { page: 'board' }, 'board'],
    ['the Board turned off or loading', { page: 'board', boardOn: false }, null],
    ['the Reviews list', { page: 'reviews' }, 'reviews'],
    ['a pull request’s review', { page: 'reviews', pullReview: true }, null],
    ['Reviews hidden (Code review off, a tailnet guest)', { page: 'reviews', pullsShown: false }, null],
    ['Drafts', { page: 'drafts' }, null],
    ['Settings', { page: 'settings' }, null],
    ['What’s new', { page: 'whats-new' }, null],
    ['Shapes', { page: 'shapes' }, null],
    ['the tour', { page: 'tour', tourOn: true }, null],
  ];
  for (const [where, over, kind] of rows) expect([where, refreshKind({ ...base, ...over })]).toEqual([where, kind]);

  // Each kind runs the window's own refreshes, the thread's beside the Board's or Reviews'.
  const ran: string[] = [];
  const act = { inbox: () => ran.push('inbox'), board: () => ran.push('board'), reviews: () => ran.push('reviews'), thread: () => ran.push('thread') };
  for (const [kind, runs] of [['inbox', ['inbox']], ['board', ['board']], ['board+thread', ['board', 'thread']], ['reviews', ['reviews']], ['reviews+thread', ['reviews', 'thread']]] as const) {
    ran.length = 0;
    refreshAction(kind, act)!();
    expect([kind, ran]).toEqual([kind, [...runs]]);
  }
  expect(refreshAction(null, act)).toBeNull();
});

function RefreshKeys({ on }: { on: () => { page: string; run: (() => void) | null } }) {
  useShortcutScope({ scope: inboxAppShortcuts, handlers: refreshKey(on) });
  return null;
}

const REFRESH_PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };

function refreshThread(): InboxThread {
  const id = 'msg_01M4H6G73M9H3Z32T859E72DPY';
  const message: InboxMessageWire = {
    id,
    project_id: REFRESH_PROJECT.id,
    thread_id: id,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Nightly sync',
    body: 'The nightly sync is green again.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
  };
  return { thread_id: id, project: REFRESH_PROJECT, subject: 'Nightly sync', thread_name: null, resolved_at: null, messages: [message] };
}

test.skipIf(!hasDom)('Shift+R runs the page’s refresh from the list and from an open thread; plain R still opens Reply', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: REFRESH_PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = savedFetch;
  });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  let refreshes = 0;
  const view: { page: string; run: (() => void) | null } = { page: 'inbox', run: () => (refreshes += 1) };
  const el = mount(
    <>
      <RefreshKeys on={() => view} />
      <button type="button" data-thread-id="thr_row">
        A row
      </button>
      <ThreadPane thread={refreshThread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
    </>,
  );
  await settle();
  const box = () => el.querySelector<HTMLTextAreaElement>('textarea');
  const replyButton = () => el.querySelector<HTMLButtonElement>('[data-reply-button]');
  expect(replyButton()).not.toBeNull();
  const shiftR = (target: Element, init: KeyboardEventInit = {}) => press(target, 'R', { code: 'KeyR', shiftKey: true, ...init });

  // From the list (a row with focus), Shift+R refreshes, and opens nothing.
  const row = el.querySelector<HTMLElement>('[data-thread-id="thr_row"]')!;
  act(() => row.focus());
  shiftR(row);
  expect(refreshes).toBe(1);
  // From inside the open thread (its Reply button with focus), the same; the reply box stays shut.
  act(() => replyButton()!.focus());
  shiftR(replyButton()!);
  await settle();
  expect(refreshes).toBe(2);
  expect(box()).toBeNull();
  // Plain R is still Reply: the box opens, nothing refreshes.
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  press(document.body, 'r', { code: 'KeyR' });
  await settle();
  expect(box()).not.toBeNull();
  expect(refreshes).toBe(2);
  // Typing in the reply box: Shift+R is a capital R.
  act(() => box()!.focus());
  shiftR(box()!);
  expect(refreshes).toBe(2);
  act(() => box()!.blur());
  // ⌘⇧R and Ctrl+Shift+R stay the browser's hard reload.
  shiftR(document.body, { metaKey: true });
  shiftR(document.body, { ctrlKey: true });
  expect(refreshes).toBe(2);
  // Under a dialog, nothing.
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.append(dialog);
  shiftR(document.body);
  dialog.remove();
  expect(refreshes).toBe(2);
  // Single-key shortcuts off (Settings → General): nothing; back on, it refreshes again.
  act(() => prefs.setSingleKeys(false));
  try {
    shiftR(document.body);
    expect(refreshes).toBe(2);
  } finally {
    act(() => prefs.setSingleKeys(true));
  }
  shiftR(document.body);
  expect(refreshes).toBe(3);
  // A page with no refresh (Drafts, Settings): nothing, and the key is left alone.
  view.run = null;
  const left = new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', shiftKey: true, bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(left);
  });
  expect(left.defaultPrevented).toBe(false);
  // On the tour, nothing either.
  view.run = () => (refreshes += 1);
  view.page = 'tour';
  shiftR(document.body);
  expect(refreshes).toBe(3);
});

test.skipIf(!hasDom)('the list’s ↻ shows only Shift+R’s keycap beside it, keeps its words for screen readers, and drops both with single keys off', () => {
  let refreshed = 0;
  const list = () => (
    <SidebarProvider>
      <InboxList
        title="Inbox"
        path={null}
        sections={[]}
        filtered={false}
        narrow={false}
        selectedThreadId={null}
        notice={null}
        onShowNew={() => {}}
        onOpen={() => {}}
        phone={false}
        onRefresh={() => (refreshed += 1)}
      />
    </SidebarProvider>
  );
  const el = mount(list());
  const button = () => el.querySelector<HTMLButtonElement>('.ib-lhead [data-list-refresh]')!;
  // The keycap is inside the button (an overlay, inbox.css `.ib-hover-kbd`), with no words of its own.
  const cap = button().querySelector<HTMLElement>('kbd.ib-hover-kbd');
  // ⇧R on a Mac, Shift R elsewhere (the registry's formatter).
  expect(cap?.getAttribute('data-keycap')).toMatch(/^(⇧R|Shift R)$/);
  expect(cap?.getAttribute('aria-hidden')).toBe('true');
  expect(cap?.textContent).toBe('');
  expect(button().getAttribute('aria-keyshortcuts')).toBe('Shift+R');
  expect(document.getElementById(button().getAttribute('aria-describedby')!)?.textContent?.trim()).toBe('Refresh the list');
  act(() => button().click());
  expect(refreshed).toBe(1);
  act(() => prefs.setSingleKeys(false));
  try {
    expect(button().querySelector('kbd')).toBeNull();
    expect(button().hasAttribute('aria-keyshortcuts')).toBe(false);
  } finally {
    act(() => prefs.setSingleKeys(true));
  }
  expect(button().querySelector('kbd.ib-hover-kbd')).not.toBeNull();
});
