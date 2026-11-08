/**
 * The list's look options (approval "inbox-list-options", listLook.ts): four checkboxes in the list's ⋮ menu,
 * "Highlight thread subject", "Compact rows", "Hide agent icons" and "Smaller thread names" (only the last on by
 * default, since 2026-11-05), and since "inbox-customize-rows" the person's look wherever they use the Inbox
 * (config.json `inboxRows`).
 * What this catches: a browser that never chose getting anything but the defaults, or an old look that is the old
 * defaults (every option off) read as a choice, or an old chosen look changed by the new defaults; a change that
 * waits for the server, is not saved, or is undone by a read that predates it; saves that land out of order leaving a
 * page on an older look, or more than one on its way; rival options both on; another window's save not reaching an
 * open list; a browser's old cookies not adopted once (or adopted over the server's look, or written again); a menu
 * item a screen reader does not hear as a checkbox (role and aria-checked), that draws an icon, or that closes the
 * menu; "Customize rows…" missing from the Rows group; a compact row that keeps the title on its
 * own line, or loses the time; a highlighted title outside its pill on any row shape; the agents' words lost to a
 * screen reader when their icons are hidden; smaller names that change the rows' markup; the onboarding tour drawing
 * the person's saved look. Geometry (the project giving way first, the time never, an unread name's size with
 * Smaller thread names) is proved in Chromium by tests/e2e/inbox-list-options.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';
import { whenTime } from './format';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { TourMain } = (hasDom ? await import('./tour/Tour') : {}) as typeof import('./tour/Tour');
const { parseTourFixture, tourStateAt, TOUR_THREAD } = await import('./tour/model');
const { LIST_LOOK_COOKIES, LIST_LOOK_DEFAULT, LIST_LOOK_OFF, ROWS_COOKIE, adoptSavedRows, hearRowsEvent, listLookReadMark, readListLook, resetListLookForTests, writeListLookOption, writeListLookOptions, writeMenuLook } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

// This browser's cookies (Plannotator's storage); a map stands in for them here.
const stored = new Map<string, string>();
// The server (POST /api/inbox/settings `{ rows }`): each save is recorded, counted (`rows_rev`) when it arrives, and
// answered with what it saved (or `answerRows`), at once or when the test lets it (`held`); `offline` refuses it.
// The round trip through a real Inbox is packages/server/inbox.test.ts's.
const saves: unknown[][] = [];
let held: (() => void)[] | null = null;
let serverRev = 0;
let answerRows: unknown[] | null = null;
let offline = false;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  saves.length = 0;
  held = null;
  serverRev = 0;
  answerRows = null;
  offline = false;
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const rows = (JSON.parse(init?.body ?? '{}') as { rows: unknown[] }).rows;
    saves.push(rows);
    if (offline) throw new TypeError('Failed to fetch');
    const rev = ++serverRev;
    if (held) await new Promise<void>((go) => held!.push(go));
    return new Response(JSON.stringify({ rows: answerRows ?? rows, rows_rev: rev }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // A fresh page: nothing read yet, nothing saving.
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'northwind-industries-reconciliation-platform' },
    thread_name: `Name of ${id}`,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const SECTIONS: InboxListSection[] = [
  { id: 'waiting', label: 'Waiting on you', threads: [row('msg_unread'), row('msg_unnamed', { thread_name: null })] },
  { id: 'quiet', label: 'Quiet', threads: [row('msg_read', { unread: false, waiting_on_person: false, section: 'quiet' })] },
];

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };

type Shape = 'wide' | 'narrow' | 'phone';

function render(shape: Shape, onCustomizeRows?: () => void, opts: { sections?: InboxListSection[]; pinned?: ReadonlySet<string> } = {}): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList
          title="Inbox"
          path={null}
          sections={opts.sections ?? SECTIONS}
          pinned={opts.pinned}
          // happy-dom has no layout: a column beside a thread draws three-line rows, one project's list wide ones.
          filtered={shape === 'wide'}
          narrow={shape === 'narrow'}
          phone={shape === 'phone'}
          selectedThreadId={null}
          notice={null}
          onShowNew={() => {}}
          onOpen={() => {}}
          tidy={TIDY}
          onCustomizeRows={onCustomizeRows}
        />
      </SidebarProvider>,
    );
  });
  return host;
}

function remount(shape: Shape, opts?: Parameters<typeof render>[2]): HTMLElement {
  act(() => root?.unmount());
  host?.remove();
  return render(shape, undefined, opts);
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

async function openMenu(el: HTMLElement) {
  act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
}

const item = (key: string) => document.querySelector<HTMLElement>(`[data-list-look="${key}"]`)!;
const column = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-listcol')!;
const lookClasses = (el: HTMLElement) => [...column(el).classList].filter((c) => c.startsWith('ib-lk-'));

/** A three-line row's lines by class, and each line's children by what they are. */
function narrowLines(el: HTMLElement, id: string): Record<string, string[]> {
  const r = el.querySelector<HTMLElement>(`.ib-nrow[data-thread-id="${id}"]`)!;
  const out: Record<string, string[]> = {};
  for (const line of r.querySelectorAll<HTMLElement>(':scope > div')) out[line.className] = [...line.children].map(part);
  return out;
}

/** A phone row's spans by class (line 1 by its parts). */
function phoneLines(el: HTMLElement, id: string): { m1: string[]; rest: string[] } {
  const r = el.querySelector<HTMLElement>(`.ib-mrow[data-thread-id="${id}"]`)!;
  const kids = [...r.children].filter((c) => !c.classList.contains('ib-sr')) as HTMLElement[];
  return { m1: [...kids[0]!.children].map(part), rest: kids.slice(1).map((c) => c.className) };
}

function part(c: Element): string {
  if (c.classList.contains('ib-from')) return 'from';
  if (c.classList.contains('ib-t')) return 'time';
  if (c.classList.contains('ib-rowkey')) return `pill(${c.firstElementChild!.className}:${c.textContent})`;
  if (c.classList.contains('ib-title') || c.classList.contains('ib-m2')) return `title(${c.textContent})`;
  return c.className;
}

/** The saves still on their way answer. */
async function answer() {
  const waiting = held ?? [];
  held = null;
  for (const go of waiting) go();
  await new Promise((r) => setTimeout(r, 10));
}

/** A reload: the page forgets its look and paints from this browser's cookie. */
function reload() {
  if (hasDom) act(() => resetListLookForTests());
  else resetListLookForTests();
}

// The look is the person's, wherever they use the Inbox (the owner, 2026-11-02), kept in config.json `inboxRows`.
describe('the saved look', () => {
  test('a browser that never chose, with no saved look: the defaults (smaller names only), and nothing is saved', async () => {
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, smallNames: true });
    adoptSavedRows(null);
    await answer();
    expect(saves).toEqual([]);
    expect(stored.size).toBe(0);
  });

  // Smaller thread names became a default (2026-11-05). What an older build kept for every option off was its
  // defaults, never a choice: today's defaults paint. Any other old look was chosen and stays exactly as it was.
  test("upgrading: this browser's old defaults paint today's defaults; an old chosen look keeps its larger names", async () => {
    stored.set(ROWS_COOKIE, 'none');
    reload();
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
    stored.set(ROWS_COOKIE, 'compact');
    reload();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, compact: true });
    // The old per-option cookies, none on: the old defaults too.
    stored.clear();
    stored.set(LIST_LOOK_COOKIES.highlight, '0');
    reload();
    expect(readListLook()).toEqual(LIST_LOOK_DEFAULT);
    adoptSavedRows(null, 0);
    await answer();
    expect(saves).toEqual([]);
  });

  test('a change shows at once, then is saved; this browser keeps only the look it showed, never the old cookies', async () => {
    held = [];
    void writeListLookOptions({ roomy: true, highlight: true });
    // Before the server answers: on screen, and sent as the whole look in the options' order.
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, roomy: true, highlight: true });
    expect(saves).toEqual([['highlight', 'smallNames', 'roomy']]);
    await answer();
    expect(Object.fromEntries(stored)).toEqual({ [ROWS_COOKIE]: 'highlight,smallNames,roomy' });
    void writeListLookOption('roomy', false);
    void writeListLookOption('highlight', false);
    void writeListLookOption('smallNames', false);
    await answer();
    expect(saves.at(-1)).toEqual([]);
    // Every option off, chosen today: "off", never the old builds' "none" (their defaults).
    expect(Object.fromEntries(stored)).toEqual({ [ROWS_COOKIE]: 'off' });
    // A reload paints the last look shown (all off), not the defaults.
    reload();
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
  });

  test("the server's look is taken from a settings read and from another window's save, and paints the next reload", async () => {
    adoptSavedRows(['titleFirst', 'relativeTime'], 1);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, titleFirst: true, relativeTime: true });
    adoptSavedRows(['previewTwo'], 2);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, previewTwo: true });
    reload();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, previewTwo: true });
    expect(saves).toEqual([]);
  });

  test('upgrading: the old cookies are saved once when the server has no look, then the server wins', async () => {
    stored.set(LIST_LOOK_COOKIES.compact, '1');
    stored.set(LIST_LOOK_COOKIES.hideAgents, '1');
    stored.set(LIST_LOOK_COOKIES.highlight, 'true'); // anything but "1" is off
    reload();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, compact: true, hideAgents: true });
    held = [];
    adoptSavedRows(null, 0);
    // A second read while the adoption is on its way, and one sent before it that answers after it: never again.
    adoptSavedRows(null, 0);
    await answer();
    adoptSavedRows(null, 0);
    await answer();
    expect(saves).toEqual([['compact', 'hideAgents']]);
    // Another browser's look, saved later: it wins here. The old cookies are left as they were, never written.
    adoptSavedRows(['roomy'], 2);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
    expect(stored.get(LIST_LOOK_COOKIES.compact)).toBe('1');
    reload();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
  });

  test('upgrading offline: the adoption that failed is offered again by the next read, and the look stays meanwhile', async () => {
    stored.set(LIST_LOOK_COOKIES.compact, '1');
    reload();
    offline = true;
    adoptSavedRows(null, 0);
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, compact: true });
    offline = false;
    adoptSavedRows(null, 0);
    await answer();
    expect(saves).toEqual([['compact'], ['compact']]);
    expect(serverRev).toBe(1);
  });

  test("a browser whose old cookies differ from the server's look takes the server's and saves nothing", async () => {
    stored.set(LIST_LOOK_COOKIES.compact, '1');
    reload();
    adoptSavedRows([], 3);
    await answer();
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
    expect(saves).toEqual([]);
  });

  test('one save on its way at a time: changes meanwhile wait, and only the latest is sent next', async () => {
    held = [];
    void writeListLookOption('highlight', true);
    void writeListLookOption('compact', true);
    void writeListLookOption('hideAgents', true);
    // On screen at once, every change; one request.
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, highlight: true, compact: true, hideAgents: true });
    expect(saves).toEqual([['highlight', 'smallNames']]);
    await answer();
    expect(saves).toEqual([['highlight', 'smallNames'], ['highlight', 'compact', 'hideAgents', 'smallNames']]);
    // The first answer (only highlight) never showed over the changes after it.
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, highlight: true, compact: true, hideAgents: true });
  });

  test("a read that arrives while this page saves waits, and an older one is dropped: the page ends on the server's newest", async () => {
    adoptSavedRows(['relativeTime'], 4);
    serverRev = 4;
    held = [];
    void writeListLookOption('unreadDot', true);
    // A read sent before the change answers while it saves: not shown over it, not even after it.
    adoptSavedRows(['relativeTime'], 4);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, relativeTime: true, unreadDot: true, smallNames: true });
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, relativeTime: true, unreadDot: true, smallNames: true });
    adoptSavedRows([], 4);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, relativeTime: true, unreadDot: true, smallNames: true });
  });

  // Saves land out of order: another window's save, made after this page's, is heard before this page's answer.
  test("another window's newer save, heard while this page saves, wins once this page's older answer arrives", async () => {
    held = [];
    void writeListLookOption('compact', true);
    adoptSavedRows(['roomy'], 2);
    // This page's save is still on its way: its change stays on screen meanwhile.
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, compact: true });
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
    expect(stored.get(ROWS_COOKIE)).toBe('roomy');
  });

  test("this page's save made after another window's: its answer is the newest and wins over the event heard before it", async () => {
    held = [];
    serverRev = 1;
    void writeListLookOption('compact', true);
    adoptSavedRows(['roomy'], 1);
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, compact: true });
  });

  test("the last save's answer is the server's look: shown when it differs from what this page sent", async () => {
    answerRows = ['titleFirst'];
    void writeListLookOption('compact', true);
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, titleFirst: true });
  });

  test('a save that fails keeps the look on this page', async () => {
    adoptSavedRows(['highlight'], 1);
    offline = true;
    void writeListLookOption('compact', true);
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true });
  });

  test('rivals never both on: the option turned on wins, and the Dot keeps the smaller names', async () => {
    adoptSavedRows(['highlight', 'roomy', 'previewTwo'], 1);
    void writeListLookOption('compact', true);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true, previewTwo: true });
    void writeListLookOption('roomy', true);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, roomy: true, previewTwo: true });
    void writeListLookOption('hidePreview', true);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, roomy: true, hidePreview: true });
    void writeListLookOption('previewTwo', true);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, roomy: true, previewTwo: true });
    void writeListLookOption('unreadDot', true);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, roomy: true, previewTwo: true, unreadDot: true, smallNames: true });
    void writeListLookOption('smallNames', false);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, roomy: true, previewTwo: true });
    await answer();
    expect(saves.at(-1)).toEqual(['highlight', 'roomy', 'previewTwo']);
    // A hand-edited or older look with both: Compact, no "2 lines" under no preview, the Dot with its names.
    adoptSavedRows(['compact', 'roomy', 'hidePreview', 'previewTwo', 'unreadDot'], 9);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, compact: true, hidePreview: true, unreadDot: true, smallNames: true });
  });

  // Review of #2516: the one-time list dialog's Done saved all eleven options from the look it opened with.
  test("the list dialog's Done saves what it changed only: the others keep what was saved while it was open", async () => {
    const opened = readListLook();
    adoptSavedRows(['previewTwo', 'relativeTime', 'titleFirst'], 1);
    void writeMenuLook({ ...opened, compact: true, highlight: true }, opened);
    await answer();
    expect(saves).toEqual([['highlight', 'compact', 'previewTwo', 'relativeTime', 'titleFirst']]);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true, previewTwo: true, relativeTime: true, titleFirst: true });
  });

  // Delta review of #2516: the dialog's "smaller names" as it opened (off) turned off a Dot saved meanwhile.
  test("the list dialog's Done keeps a Dot another window turned on while it was open; nothing changed saves nothing", async () => {
    const opened = readListLook();
    adoptSavedRows(['smallNames', 'unreadDot'], 1);
    void writeMenuLook({ ...opened, hideAgents: true }, opened);
    await answer();
    expect(saves).toEqual([['hideAgents', 'smallNames', 'unreadDot']]);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, hideAgents: true, smallNames: true, unreadDot: true });
    void writeMenuLook(opened, opened);
    await answer();
    expect(saves).toHaveLength(1);
  });

  // Delta review of #2516: config.json reset, restored or hand-edited takes the count back to 0.
  test('the count gone back (config.json reset): a change stays on screen, and reads and events are taken again', async () => {
    adoptSavedRows(['highlight'], 9);
    void writeListLookOption('compact', true);
    await answer();
    // The server counted the save 1, below the 9 this page had heard: still Compact, and counting starts from 1.
    expect(saves).toEqual([['highlight', 'compact']]);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true });

    // A window that only reads: a settings read answers below what it had heard when it was sent.
    reload();
    adoptSavedRows(['highlight'], 9);
    const mark = listLookReadMark();
    adoptSavedRows(['roomy'], 2, mark);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
    // An event at or below the last event's count is not taken (gone back, or a late copy?): it asks for a read, and
    // the read, below what the page had heard when it was sent, is taken.
    let doubts = 0;
    hearRowsEvent(['highlight'], 7);
    const sent = listLookReadMark();
    hearRowsEvent(['titleFirst'], 1, () => (doubts += 1));
    expect(doubts).toBe(1);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true });
    adoptSavedRows(['titleFirst'], 1, sent);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, titleFirst: true });
  });

  // Delta review of #2516: in a leader steal two tabs relay the same frames, and a rows frame has no seq.
  test("a late copy of an old event never undoes this page's newer save: it asks for a read instead", async () => {
    let doubts = 0;
    serverRev = 4;
    hearRowsEvent(['highlight'], 4);
    void writeListLookOption('compact', true);
    await answer();
    hearRowsEvent(['highlight', 'compact'], 5);
    hearRowsEvent(['highlight'], 4, () => (doubts += 1));
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true });
    expect(doubts).toBe(1);
    // The read it asks for answers the server's count, 5: at the mark, so nothing changes.
    adoptSavedRows(['highlight', 'compact'], 5, listLookReadMark());
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true });
  });

  // The count went back to exactly the one heard before the save, while a newer one was heard during it.
  test("a save's answer equal to the count heard before it is the count gone back: this page's look is taken", async () => {
    hearRowsEvent(['highlight'], 2);
    held = [];
    serverRev = 1;
    void writeListLookOption('compact', true);
    // Before it lands: another window's save (3), then config.json reset and that window's next save (1).
    hearRowsEvent(['roomy'], 3);
    hearRowsEvent(['titleFirst'], 1, () => {});
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true });
  });

  test('a read is old, not gone back, when it answers at least the count heard when it was sent', () => {
    adoptSavedRows(['highlight'], 5);
    const mark = listLookReadMark();
    hearRowsEvent(['roomy'], 6);
    adoptSavedRows(['highlight'], 5, mark);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
  });

  test("an event older than this page's own save's answer, arriving after it, is old, not gone back", async () => {
    serverRev = 2;
    void writeListLookOption('compact', true);
    await answer();
    hearRowsEvent(['roomy'], 2);
    expect(readListLook()).toEqual({ ...LIST_LOOK_DEFAULT, compact: true });
  });

  test('an older Inbox (no `rows`) or not a list changes nothing; a name no build knows is dropped', () => {
    adoptSavedRows(['hidePreview'], 1);
    adoptSavedRows(undefined);
    adoptSavedRows('hidePreview', 2);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, hidePreview: true });
    adoptSavedRows(['previewTwo', 'sparkles'], 3);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, previewTwo: true });
  });
});

describe.if(hasDom)('the ⋮ menu', () => {
  test('four checkboxes after Refresh and the view (listView.ts), only Smaller thread names checked by default, each a menuitemcheckbox', async () => {
    const el = render('narrow');
    await openMenu(el);
    const popup = document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
    const items = [...popup.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    // The labels are the approved words (approval "inbox-list-options"): pinned on purpose.
    expect(items.map((i) => [i.getAttribute('role'), i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['menuitem', 'Tidy', null],
      ['menuitem', 'Refresh', null],
      ['menuitemradio', 'Smart groups', 'true'],
      ['menuitemradio', 'Simple list', 'false'],
      ['menuitemcheckbox', 'Highlight thread subject', 'false'],
      ['menuitemcheckbox', 'Compact rows', 'false'],
      ['menuitemcheckbox', 'Hide agent icons', 'false'],
      ['menuitemcheckbox', 'Smaller thread names', 'true'],
    ]);
    expect(lookClasses(el)).toEqual(['ib-lk-small']);
  });

  test('a tick changes the list at once, keeps the menu open, and survives a reload', async () => {
    const el = render('narrow');
    await openMenu(el);
    act(() => item('compact').click());
    await settle();
    expect(item('compact').getAttribute('aria-checked')).toBe('true');
    expect(item('compact').querySelector('.ib-pmi-box[data-on] svg')).not.toBeNull();
    expect(document.querySelector('[data-tidy-menu-popup]')).not.toBeNull();
    expect(lookClasses(el)).toEqual(['ib-lk-compact', 'ib-lk-small']);
    act(() => item('highlight').click());
    act(() => item('hideAgents').click());
    await settle();
    expect(lookClasses(el)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);

    expect(saves.at(-1)).toEqual(['highlight', 'compact', 'hideAgents', 'smallNames']);

    reload();
    const again = remount('narrow');
    expect(lookClasses(again)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);
    await openMenu(again);
    expect(['highlight', 'compact', 'hideAgents', 'smallNames'].map((k) => item(k).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true']);

    // Turned off again, smaller names too: every option off, and that is what is saved.
    act(() => item('highlight').click());
    act(() => item('compact').click());
    act(() => item('hideAgents').click());
    act(() => item('smallNames').click());
    await settle();
    expect(lookClasses(again)).toEqual([]);
    expect(saves.at(-1)).toEqual([]);
  });

  test("another window's save reaches an open list at once", () => {
    const el = render('narrow');
    act(() => adoptSavedRows(['compact', 'unreadDot'], 1));
    expect(lookClasses(el)).toEqual(['ib-lk-compact', 'ib-lk-small', 'ib-lk-dot']);
  });

  // Review of #2516: the menu's Compact over Settings → Rows' Roomy left both on (a Custom look no control shows).
  test('from Detailed, ticking Compact turns Roomy off, on screen and in the save; unticking smaller names turns the Dot off', async () => {
    adoptSavedRows(['highlight', 'roomy', 'previewTwo'], 1);
    const el = render('narrow');
    expect(lookClasses(el)).toEqual(['ib-lk-pill', 'ib-lk-roomy', 'ib-lk-pv2']);
    await openMenu(el);
    act(() => item('compact').click());
    await settle();
    expect(lookClasses(el)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-pv2']);
    expect(saves.at(-1)).toEqual(['highlight', 'compact', 'previewTwo']);

    serverRev = 5;
    act(() => adoptSavedRows(['unreadDot', 'smallNames'], 5));
    expect(item('smallNames').getAttribute('aria-checked')).toBe('true');
    act(() => item('smallNames').click());
    await settle();
    expect(lookClasses(el)).toEqual([]);
    expect(saves.at(-1)).toEqual([]);
  });

  // The owner, 2026-11-02: "those could all just be check boxes anyways. They don't look right as icons."
  test('plain checkboxes: a box and the label, no icon; then "Customize rows…", no icon, last in Rows', async () => {
    let customized = 0;
    stored.set(LIST_LOOK_COOKIES.hideAgents, '1');
    await openMenu(render('narrow', () => customized++));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-tidy-menu-popup] [role="group"]')].find((group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent === 'Rows')!;
    const items = [...rows.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    expect(items.map((i) => [i.getAttribute('role'), i.textContent])).toEqual([
      ['menuitemcheckbox', 'Highlight thread subject'],
      ['menuitemcheckbox', 'Compact rows'],
      ['menuitemcheckbox', 'Hide agent icons'],
      ['menuitemcheckbox', 'Smaller thread names'],
      ['menuitem', 'Customize rows…'],
    ]);
    // Each checkbox: its box first (the icon's place), the only drawing a tick inside it.
    for (const i of items.slice(0, 4)) {
      expect(i.firstElementChild!.className).toBe('ib-pmi-box');
      expect([...i.querySelectorAll('svg')].every((svg) => svg.closest('.ib-pmi-box[data-on]'))).toBe(true);
    }
    expect(items.map((i) => i.querySelectorAll('svg').length)).toEqual([0, 0, 1, 0, 0]);
    act(() => items[4]!.click());
    await settle();
    expect(customized).toBe(1);
  });
});

describe.if(hasDom)('the rows in each mode', () => {
  test('the defaults: three lines, the title plain on its own line', () => {
    const el = render('narrow');
    expect(narrowLines(el, 'msg_unread')).toEqual({ 'ib-l1': ['from', 'time'], 'ib-l2': ['title(Name of msg_unread)'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread')).toEqual({ m1: ['from', 'time'], rest: ['ib-m2', 'ib-m3'] });
    expect(document.querySelector('.ib-rowkey')).toBeNull();
  });

  test('highlight: the title in its pill on every shape, read and unread, named or not', () => {
    stored.set(LIST_LOOK_COOKIES.highlight, '1');
    const el = render('narrow');
    expect(narrowLines(el, 'msg_unread')['ib-l2']).toEqual(['pill(ib-keyt ib-title:Name of msg_unread)']);
    expect(narrowLines(el, 'msg_unnamed')['ib-l2']).toEqual(['pill(ib-keyt ib-title:Subject msg_unnamed)']);
    act(() => el.querySelector<HTMLButtonElement>('[data-section-id="quiet"] button.ib-band')!.click());
    expect(narrowLines(el, 'msg_read')['ib-l2']).toEqual(['pill(ib-keyt ib-title:Name of msg_read)']);

    const phone = remount('phone');
    expect(phoneLines(phone, 'msg_unread')).toEqual({ m1: ['from', 'time'], rest: ['ib-key ib-rowkey', 'ib-m3'] });
    expect(phone.querySelector('.ib-mrow[data-thread-id="msg_unread"] .ib-rowkey > .ib-keyt.ib-m2')!.textContent).toBe('Name of msg_unread');

    const wide = remount('wide');
    const cell = wide.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_unread"] .ib-subj')!;
    expect([...cell.children].map(part)).toEqual(['pill(ib-keyt ib-title:Name of msg_unread)', 'ib-pv']);
  });

  test('compact: the title joins line 1 between the project and the time; the preview is line 2', () => {
    stored.set(LIST_LOOK_COOKIES.compact, '1');
    const el = render('narrow');
    expect(narrowLines(el, 'msg_unread')).toEqual({ 'ib-l1': ['from', 'title(Name of msg_unread)', 'time'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
    // An unnamed thread has no preview: line 1 holds its subject, and the count sits on line 2.
    expect(narrowLines(el, 'msg_unnamed')).toEqual({ 'ib-l1': ['from', 'title(Subject msg_unnamed)', 'time'], 'ib-l3': ['ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread')).toEqual({ m1: ['from', 'title(Name of msg_unread)', 'time'], rest: ['ib-m3'] });
    // A wide row is one line already: compact leaves it as it is.
    const wide = remount('wide');
    expect([...wide.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_unread"] .ib-subj')!.children].map(part)).toEqual(['title(Name of msg_unread)', 'ib-pv']);
  });

  test('compact and highlight: the pill on line 1', () => {
    stored.set(LIST_LOOK_COOKIES.compact, '1');
    stored.set(LIST_LOOK_COOKIES.highlight, '1');
    expect(narrowLines(render('narrow'), 'msg_unread')['ib-l1']).toEqual(['from', 'pill(ib-keyt ib-title:Name of msg_unread)', 'time']);
    expect(phoneLines(remount('phone'), 'msg_unread').m1).toEqual(['from', 'pill(ib-keyt ib-m2:Name of msg_unread)', 'time']);
  });

  // Settings → Rows' First line "Thread name" (approval "inbox-customize-rows"): the name leads, the time stays on line 1.
  test('name first: the name and the time on line 1, the agents and project under it; compact keeps one line, name first', () => {
    adoptSavedRows(['titleFirst']);
    const el = render('narrow');
    expect(narrowLines(el, 'msg_unread')).toEqual({ 'ib-l1': ['title(Name of msg_unread)', 'time'], 'ib-l2 ib-l2-lead': ['from'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread')).toEqual({ m1: ['title(Name of msg_unread)', 'time'], rest: ['ib-m1 ib-m1-lead', 'ib-m3'] });
    act(() => adoptSavedRows(['titleFirst', 'compact']));
    expect(narrowLines(remount('narrow'), 'msg_unread')).toEqual({ 'ib-l1': ['title(Name of msg_unread)', 'from', 'time'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread')).toEqual({ m1: ['title(Name of msg_unread)', 'from', 'time'], rest: ['ib-m3'] });
    // The full-width row keeps its columns (approval: name first there is out of scope).
    const wide = remount('wide');
    expect([...wide.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_unread"] .ib-subj')!.children].map(part)).toEqual(['title(Name of msg_unread)', 'ib-pv']);
  });

  // The owner, 2026-11-07: First line "Thread name" with Subject preview off is a true two-line row. Line 3's marks
  // and counts move to line 2's right end, after the agents and the project; no line 3.
  test('name first with no preview: two lines, the badge, pin and count at the end of line 2, on a three-line and a phone row', () => {
    const stopped = row('msg_stop', { section: 'stopped', guide: true, snoozed: { until: '2026-10-21T12:00:00.000Z', at: '2026-10-20T00:00:00.000Z' }, questions: { open: 2, picked: 0, stopped: true, holds_up: [], prompt: null } });
    const opts = { sections: [{ id: 'stopped', label: 'Stopped on you', threads: [stopped] }, ...SECTIONS] as InboxListSection[], pinned: new Set(['msg_stop']) };
    act(() => adoptSavedRows(['titleFirst', 'hidePreview']));
    const el = remount('narrow', opts);
    expect(narrowLines(el, 'msg_unread')).toEqual({ 'ib-l1': ['title(Name of msg_unread)', 'time'], 'ib-l2 ib-l2-lead': ['from', 'ib-lend'] });
    expect([...el.querySelector('.ib-nrow[data-thread-id="msg_unread"] .ib-lend')!.children].map(part)).toEqual(['ib-c ib-qn']);
    const stop = el.querySelector<HTMLElement>('.ib-nrow[data-thread-id="msg_stop"]')!;
    expect(stop.querySelector('.ib-l3')).toBeNull();
    expect([...stop.querySelector('.ib-l2 > .ib-lend')!.children].map((c) => c.className.split(' ')[0])).toEqual(['ib-att', 'ib-pinmark', 'ib-badge', 'ib-zwhen', 'ib-c']);
    // The pin's and the badge's words still reach a screen reader.
    expect(stop.querySelector(':scope > .ib-sr')!.textContent).toBe(', starred');
    expect(document.getElementById(stop.getAttribute('aria-describedby')!)!.textContent).toBeTruthy();

    const phone = remount('phone', opts);
    expect(phoneLines(phone, 'msg_unread')).toEqual({ m1: ['title(Name of msg_unread)', 'time'], rest: ['ib-m1 ib-m1-lead'] });
    expect(phone.querySelector('.ib-mrow[data-thread-id="msg_unread"] .ib-m1-lead > .ib-lend > .ib-qn')).not.toBeNull();
    // The pin goes with the counts to line 2, never to line 1 before the time.
    const pstop = phone.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_stop"]')!;
    expect(pstop.querySelector('.ib-m3')).toBeNull();
    expect([...pstop.querySelector('.ib-m1-lead > .ib-lend')!.children].map((c) => c.className.split(' ')[0])).toEqual(['ib-att', 'ib-pinmark', 'ib-badge', 'ib-zwhen', 'ib-c']);
    expect(pstop.querySelector('.ib-m1:not(.ib-m1-lead) > .ib-pinmark')).toBeNull();
  });

  // Every other combination keeps its line 3 (the owner: "keep what I have right now").
  test('name first with a preview, no preview alone, and compact name first with no preview: line 3 as before', () => {
    act(() => adoptSavedRows(['titleFirst', 'previewTwo']));
    expect(narrowLines(remount('narrow'), 'msg_unread')).toEqual({ 'ib-l1': ['title(Name of msg_unread)', 'time'], 'ib-l2 ib-l2-lead': ['from'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread').rest).toEqual(['ib-m1 ib-m1-lead', 'ib-m3']);
    act(() => adoptSavedRows(['hidePreview']));
    expect(narrowLines(remount('narrow'), 'msg_unread')).toEqual({ 'ib-l1': ['from', 'time'], 'ib-l2': ['title(Name of msg_unread)'], 'ib-l3': ['ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread').rest).toEqual(['ib-m2', 'ib-m3']);
    act(() => adoptSavedRows(['titleFirst', 'hidePreview', 'compact']));
    expect(narrowLines(remount('narrow'), 'msg_unread')).toEqual({ 'ib-l1': ['title(Name of msg_unread)', 'from', 'time'], 'ib-l3': ['ib-c ib-qn'] });
    expect(phoneLines(remount('phone'), 'msg_unread').rest).toEqual(['ib-m3']);
    expect(document.querySelector('.ib-lend')).toBeNull();
  });

  // The time, the questions and the warnings always show: no option hides them, on any shape.
  test('every option on: the time and the question count still on every row and shape', () => {
    adoptSavedRows(['highlight', 'compact', 'hideAgents', 'smallNames', 'hideProject', 'hidePreview', 'unreadDot', 'relativeTime', 'titleFirst']);
    for (const shape of ['narrow', 'phone', 'wide'] as const) {
      const el = remount(shape);
      const r = el.querySelector<HTMLElement>(`[data-thread-id="msg_unread"]`)!;
      expect(r.querySelector('.ib-t')!.textContent, `${shape}: time`).toBeTruthy();
      // Relative: the short form is hidden from a screen reader, which hears the words; the tooltip is the clock time.
      const rel = r.querySelector<HTMLElement>('.ib-t [data-relative-time]')!;
      expect(rel.title, `${shape}: tooltip`).toBe(whenTime('2026-10-10T10:00:00.000Z'));
      expect([...rel.children].map((c) => c.getAttribute('aria-hidden') ?? c.className), `${shape}: spoken once`).toEqual(['true', 'ib-sr']);
      expect(r.querySelector('.ib-qn'), `${shape}: question count`).not.toBeNull();
      expect(r.querySelector('.ib-pv'), `${shape}: no preview`).toBeNull();
    }
  });

  // Whether a screen reader still hears them once hidden is Chromium's accessibility tree: the e2e checks that.
  test('hide agent icons: the rows keep the agents\' label and their layout', () => {
    stored.set(LIST_LOOK_COOKIES.hideAgents, '1');
    const el = render('narrow');
    expect(lookClasses(el)).toEqual(['ib-lk-noagents']);
    expect(el.querySelector('.ib-nrow[data-thread-id="msg_unread"] .ib-atiles')!.getAttribute('aria-label')).toBe('Claude Code');
    expect(narrowLines(el, 'msg_unread')).toEqual({ 'ib-l1': ['from', 'time'], 'ib-l2': ['title(Name of msg_unread)'], 'ib-l3': ['ib-pv', 'ib-c ib-qn'] });
  });

  // The size itself is Chromium's layout: the e2e measures it. Here: only the column's class, the rows untouched.
  test('smaller thread names: the column\'s class only, the rows\' markup as today on every shape', () => {
    // React's generated ids differ per mount; everything else must match.
    const markup = (el: HTMLElement) => el.innerHTML.replace(/_r_[a-z0-9]+_/g, 'id');
    act(() => adoptSavedRows([], 1));
    const today = { narrow: markup(render('narrow')), phone: markup(remount('phone')) };
    act(() => adoptSavedRows(['smallNames'], 2));
    const el = remount('narrow');
    expect(lookClasses(el)).toEqual(['ib-lk-small']);
    column(el).classList.remove('ib-lk-small');
    expect(markup(el)).toBe(today.narrow);
    const phone = remount('phone');
    column(phone).classList.remove('ib-lk-small');
    expect(markup(phone)).toBe(today.phone);
  });
});

describe.if(hasDom)('the onboarding tour', () => {
  test("ignores the saved options: its list has the defaults' look, and the person's choice stays", () => {
    for (const key of ['highlight', 'compact', 'hideAgents'] as const) writeListLookOption(key, true);
    const fixture = parseTourFixture(JSON.parse(readFileSync(join(import.meta.dir, 'tour/content/fixture.json'), 'utf8')));
    const real = fixture.threads.find((t) => t.id === TOUR_THREAD)!.real_answer!;
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
    const noop = () => {};
    act(() => {
      root!.render(
        <SidebarProvider>
          <TourMain
            fixture={fixture}
            state={tourStateAt(1, real, fixture)}
            dispatch={noop}
            phone={false}
            stacked={{ thread: false, file: false }}
            reduced
            say={noop}
            onCompose={noop}
          />
        </SidebarProvider>,
      );
    });
    expect(host.querySelector('.ib-listcol')).not.toBeNull();
    expect(lookClasses(host)).toEqual(['ib-lk-small']);
    expect(host.querySelector('.ib-rowkey')).toBeNull();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true, hideAgents: true, smallNames: true });
  });
});
