/**
 * The list's look options (approval "inbox-list-options", listLook.ts): four checkboxes in the list's ⋮ menu,
 * "Highlight thread subject", "Compact rows", "Hide agent icons" and "Smaller thread names", off by default and
 * remembered per browser.
 * What this catches: an option on in a browser that never chose it (today's list must stay today's); a choice
 * forgotten on the next load, or one that leaves a cookie behind when turned off; a menu item a screen reader does
 * not hear as a checkbox (role and aria-checked) or that closes the menu; a compact row that keeps the title on its
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
const { LIST_LOOK_COOKIES, readListLook, writeListLookOption } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

// The choices persist through Plannotator's storage (cookies in the app); a map stands in for them here.
const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
});

afterEach(() => {
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

function render(shape: Shape): HTMLElement {
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

describe('the remembered choice', () => {
  test('a browser that never chose: every option off', () => {
    expect(readListLook()).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
  });

  test('each option is its own cookie, "1" while on, removed when turned off', () => {
    writeListLookOption('compact', true);
    writeListLookOption('hideAgents', true);
    writeListLookOption('smallNames', true);
    expect(readListLook()).toEqual({ highlight: false, compact: true, hideAgents: true, smallNames: true });
    expect([...stored.entries()]).toEqual([
      [LIST_LOOK_COOKIES.compact, '1'],
      [LIST_LOOK_COOKIES.hideAgents, '1'],
      [LIST_LOOK_COOKIES.smallNames, '1'],
    ]);
    writeListLookOption('compact', false);
    writeListLookOption('hideAgents', false);
    writeListLookOption('smallNames', false);
    expect(stored.size).toBe(0);
    expect(readListLook()).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
  });

  test('a cookie with anything but "1" is off', () => {
    stored.set(LIST_LOOK_COOKIES.highlight, 'true');
    expect(readListLook().highlight).toBe(false);
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
    expect(item('compact').querySelector('.ib-pmi-check')).not.toBeNull();
    expect(document.querySelector('[data-tidy-menu-popup]')).not.toBeNull();
    expect(lookClasses(el)).toEqual(['ib-lk-compact']);
    act(() => item('highlight').click());
    act(() => item('hideAgents').click());
    act(() => item('smallNames').click());
    await settle();
    expect(lookClasses(el)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);

    const again = remount('narrow');
    expect(lookClasses(again)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents', 'ib-lk-small']);
    await openMenu(again);
    expect(['highlight', 'compact', 'hideAgents', 'smallNames'].map((k) => item(k).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true']);

    // Turned off again: the list is today's and no cookie is left.
    act(() => item('highlight').click());
    act(() => item('compact').click());
    act(() => item('hideAgents').click());
    act(() => item('smallNames').click());
    await settle();
    expect(lookClasses(again)).toEqual([]);
    expect(stored.size).toBe(0);
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
    stored.set(LIST_LOOK_COOKIES.smallNames, '1');
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
    expect(readListLook()).toEqual({ highlight: true, compact: true, hideAgents: true, smallNames: true });
  });
});
