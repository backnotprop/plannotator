/**
 * The list's look options (approval "inbox-list-options", listLook.ts): four checkboxes in the list's ⋮ menu,
 * "Highlight thread subject", "Compact rows", "Hide agent icons" and "Smaller thread names", off by default, and
 * since "inbox-customize-rows" the person's look wherever they use the Inbox (config.json `inboxRows`).
 * What this catches: an option on in a browser that never chose it (today's list must stay today's); a change that
 * waits for the server, is not saved, or is undone by a read that predates it; another window's save not reaching an
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

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { TourMain } = (hasDom ? await import('./tour/Tour') : {}) as typeof import('./tour/Tour');
const { parseTourFixture, tourStateAt, TOUR_THREAD } = await import('./tour/model');
const { LIST_LOOK_COOKIES, LIST_LOOK_OFF, ROWS_COOKIE, adoptSavedRows, readListLook, resetListLookForTests, writeListLookOption, writeListLookOptions } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

// This browser's cookies (Plannotator's storage); a map stands in for them here.
const stored = new Map<string, string>();
// The server (POST /api/inbox/settings `{ rows }`): each save is recorded and answered with what it saved, at once
// or when the test lets it (`hold`). The round trip through a real Inbox is packages/server/inbox.test.ts's.
const saves: unknown[][] = [];
let held: (() => void)[] | null = null;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  saves.length = 0;
  held = null;
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const rows = (JSON.parse(init?.body ?? '{}') as { rows: unknown[] }).rows;
    saves.push(rows);
    if (held) await new Promise<void>((go) => held!.push(go));
    return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

function render(shape: Shape, onCustomizeRows?: () => void): HTMLElement {
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
          sections={SECTIONS}
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

function remount(shape: Shape): HTMLElement {
  act(() => root?.unmount());
  host?.remove();
  return render(shape);
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
  test('a browser that never chose, with no saved look: every option off, and nothing is saved', async () => {
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
    adoptSavedRows(null);
    await answer();
    expect(saves).toEqual([]);
    expect(stored.size).toBe(0);
  });

  test('a change shows at once, then is saved; this browser keeps only the look it showed, never the old cookies', async () => {
    held = [];
    void writeListLookOptions({ roomy: true, compact: true });
    // Before the server answers: on screen, and sent as the whole look in the options' order.
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true, compact: true });
    expect(saves).toEqual([['compact', 'roomy']]);
    await answer();
    expect(Object.fromEntries(stored)).toEqual({ [ROWS_COOKIE]: 'compact,roomy' });
    void writeListLookOption('roomy', false);
    void writeListLookOption('compact', false);
    await answer();
    expect(saves.at(-1)).toEqual([]);
    expect(Object.fromEntries(stored)).toEqual({ [ROWS_COOKIE]: 'none' });
    // A reload paints the last look shown (all off), not the defaults' absence of a cookie.
    reload();
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
  });

  test("the server's look is taken from a settings read and from another window's save, and paints the next reload", async () => {
    adoptSavedRows(['titleFirst', 'relativeTime']);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, titleFirst: true, relativeTime: true });
    adoptSavedRows(['previewTwo']);
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
    adoptSavedRows(null);
    adoptSavedRows(null);
    await answer();
    expect(saves).toEqual([['compact', 'hideAgents']]);
    // Another browser's look, saved later: it wins here. The old cookies are left as they were, never written.
    adoptSavedRows(['roomy']);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
    expect(stored.get(LIST_LOOK_COOKIES.compact)).toBe('1');
    reload();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, roomy: true });
  });

  test("a browser whose old cookies differ from the server's look takes the server's and saves nothing", async () => {
    stored.set(LIST_LOOK_COOKIES.smallNames, '1');
    reload();
    adoptSavedRows([]);
    await answer();
    expect(readListLook()).toEqual(LIST_LOOK_OFF);
    expect(saves).toEqual([]);
  });

  test('a read or another window\'s save that arrives while this page saves is not taken: the last answer is', async () => {
    held = [];
    void writeListLookOption('unreadDot', true);
    void writeListLookOption('smallNames', true);
    adoptSavedRows([]);
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, unreadDot: true, smallNames: true });
    await answer();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, unreadDot: true, smallNames: true });
    expect(saves).toEqual([['unreadDot'], ['smallNames', 'unreadDot']]);
  });

  test('an older Inbox (no `rows`) or a list naming something else changes nothing', () => {
    adoptSavedRows(['hidePreview']);
    adoptSavedRows(undefined);
    adoptSavedRows(['hidePreview', 'sparkles']);
    adoptSavedRows('hidePreview');
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, hidePreview: true });
  });
});

describe.if(hasDom)('the ⋮ menu', () => {
  test('four checkboxes after Refresh, unchecked by default, each a menuitemcheckbox', async () => {
    const el = render('narrow');
    await openMenu(el);
    const popup = document.querySelector<HTMLElement>('[data-tidy-menu-popup]')!;
    const items = [...popup.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    // The labels are the approved words (approval "inbox-list-options"): pinned on purpose.
    expect(items.map((i) => [i.getAttribute('role'), i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['menuitem', 'Tidy', null],
      ['menuitem', 'Refresh', null],
      ['menuitemcheckbox', 'Highlight thread subject', 'false'],
      ['menuitemcheckbox', 'Compact rows', 'false'],
      ['menuitemcheckbox', 'Hide agent icons', 'false'],
      ['menuitemcheckbox', 'Smaller thread names', 'false'],
    ]);
    expect(lookClasses(el)).toEqual([]);
  });

  test('a tick changes the list at once, keeps the menu open, and survives a reload', async () => {
    const el = render('narrow');
    await openMenu(el);
    act(() => item('compact').click());
    await settle();
    expect(item('compact').getAttribute('aria-checked')).toBe('true');
    expect(item('compact').querySelector('.ib-pmi-box[data-on] svg')).not.toBeNull();
    expect(document.querySelector('[data-tidy-menu-popup]')).not.toBeNull();
    expect(lookClasses(el)).toEqual(['ib-lk-compact']);
    act(() => item('highlight').click());
    act(() => item('hideAgents').click());
    act(() => item('smallNames').click());
    await settle();
    expect(lookClasses(el)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);

    expect(saves.at(-1)).toEqual(['highlight', 'compact', 'hideAgents', 'smallNames']);

    reload();
    const again = remount('narrow');
    expect(lookClasses(again)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);
    await openMenu(again);
    expect(['highlight', 'compact', 'hideAgents', 'smallNames'].map((k) => item(k).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true']);

    // Turned off again: the list is today's, and that is what is saved.
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
    act(() => adoptSavedRows(['compact', 'roomy']));
    expect(lookClasses(el)).toEqual(['ib-lk-compact', 'ib-lk-roomy']);
  });

  // The owner, 2026-11-02: "those could all just be check boxes anyways. They don't look right as icons."
  test('plain checkboxes: a box and the label, no icon; then "Customize rows…", no icon, last in Rows', async () => {
    let customized = 0;
    stored.set(LIST_LOOK_COOKIES.hideAgents, '1');
    await openMenu(render('narrow', () => customized++));
    const rows = document.querySelector<HTMLElement>('[data-tidy-menu-popup] [role="group"]')!;
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
  test('all off: today\'s three lines, the title plain on its own line', () => {
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

  // The time, the questions and the warnings always show: no option hides them, on any shape.
  test('every option on: the time and the question count still on every row and shape', () => {
    adoptSavedRows(['highlight', 'compact', 'hideAgents', 'smallNames', 'hideProject', 'hidePreview', 'unreadDot', 'relativeTime', 'titleFirst']);
    for (const shape of ['narrow', 'phone', 'wide'] as const) {
      const el = remount(shape);
      const r = el.querySelector<HTMLElement>(`[data-thread-id="msg_unread"]`)!;
      expect(r.querySelector('.ib-t')!.textContent, `${shape}: time`).toBeTruthy();
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
    const today = { narrow: markup(render('narrow')), phone: markup(remount('phone')) };
    act(() => adoptSavedRows(['smallNames']));
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
  test("ignores the saved options: its list is today's, and the person's choice stays", () => {
    for (const key of ['highlight', 'compact', 'hideAgents', 'smallNames'] as const) writeListLookOption(key, true);
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
    expect(lookClasses(host)).toEqual([]);
    expect(host.querySelector('.ib-rowkey')).toBeNull();
    expect(readListLook()).toEqual({ ...LIST_LOOK_OFF, highlight: true, compact: true, hideAgents: true, smallNames: true });
  });
});
